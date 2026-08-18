/**
 * Group Memory Palace — 群聊记忆提取（第三人称版本，独立于私聊）
 *
 * 与 extraction.ts 的区别：
 * - 视角是"群聊观察者"而非角色本人 → 第三人称叙事，主语是具体的角色名
 * - 内容前缀统一为 "在【XXX群】里，..."，便于该记忆后续平等地分发给每个成员
 * - 不参与便利贴系统（pinDays），不参与 relatedTo / EventBox 跨时间链接（v1 简化）
 *
 * 私聊路径完全不感知本文件存在。
 */
import type { Message } from '../../types';
import type { MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import { buildUserPronounRule } from './userPronoun';

/** 群记忆草稿——尚未指派 charId（一份记忆稍后会复制给每个成员持久化） */
export interface GroupMemoryDraft {
    content: string;
    room: MemoryRoom;
    tags: string[];
    importance: number;
    mood: string;
    valence?: number;
    arousal?: number;
    /** 这批草稿对应的群消息时间窗中点（用于 createdAt） */
    createdAt: number;
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

function buildGroupRulesBlock(groupName: string, memberNames: string[], userLabel: string): string {
    const memberList = memberNames.join('、');
    return `## Rules

1. **Third-person narration**: You observe the 【${groupName}】 group chat and record what happened in the group.
   - Refer to the user as "${userLabel}" and use group members' names directly: ${memberList}.
   - Never use "I". The memory will be distributed equally to every member and must not adopt any one member's viewpoint.
   - Begin every memory with: "In 【${groupName}】, ..."
   - Write every generated memory and tag in English, even when the source conversation is in another language.
   Examples:
   - "In 【${groupName}】, ${memberNames[0] || 'A'} mentioned a show they had been watching, ${memberNames[1] || 'B'} recommended it too, and ${userLabel} said she was convinced to try it."
   - "In 【${groupName}】, ${memberNames[0] || 'A'} complained about weekend overtime. Everyone offered advice: ${memberNames[1] || 'B'} suggested refusing directly, while ${memberNames[2] || 'C'} suggested waiting to see what happened."

2. ${buildUserPronounRule(userLabel)}
3. **Use importance to control length**:
   - Importance 1-5: 20-60 English words, primarily factual.
   - Importance 6-7: 60-140 English words, including the group's atmosphere.
   - Importance 8-10: 120-220 English words, with a complete narrative (cause → development → group reaction).

4. **Room assignment** (from the group's collective viewpoint):
   - living_room: Everyday group chatter, running jokes, repetition, and inconsequential lively atmosphere.
   - bedroom: Warm moments, deep interactions, mutual care, or playful teasing of ${userLabel}.
   - study: Group discussion of work, study, interests, skills, or news.
   - user_room: Things in the group concerning ${userLabel}: her state, emotions, family or friends she mentions, teasing directed at her, and similar matters.
   - self_room: Changes in relationships among group members or in the group's overall atmosphere.
   - attic: Unresolved conflict, awkward silence, abandoned topics, or simmering interpersonal tension.
   - windowsill: Group promises, shared hopes, and collective goals such as meeting offline or making plans together.

5. **Mood**: happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral.
6. **Emotion coordinates** (valence, arousal):
   - valence: -1 (extreme pain) → +1 (extreme pleasure).
   - arousal: -1 (extreme calm) → +1 (extreme intensity).
7. **Tags**: Extract 2-5 English keyword tags, preferably including the names of the people involved.
8. **Do not miss worthwhile events, but do not turn every sentence into a memory**. A group-chat segment normally yields 1-5 memories.
9. **Do not output pinDays / relatedTo / sameAs / eventName / eventTags**. Group Memory v1 does not participate in pinned notes or event boxes.`;
}

function buildGroupConversationText(messages: Message[], speakerNameOf: (m: Message) => string): string {
    return messages.map(m => {
        const name = speakerNameOf(m);
        const time = new Date(m.timestamp).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        let content: string;
        if (m.type === 'image') content = '[图片]';
        else if (m.type === 'emoji') content = `[表情包]`;
        else if (m.type === 'transfer') content = `[红包: ${m.metadata?.amount ?? ''}]`;
        else content = (m.content || '').slice(0, 600);
        return `[${time}] ${name}: ${content}`;
    }).join('\n');
}

export interface GroupExtractionResult {
    drafts: GroupMemoryDraft[];
}

/**
 * 从群消息缓冲区提取记忆草稿。caller 拿到 drafts 后再为每个成员各持久化一份。
 *
 * 任何 LLM / 网络异常都吞掉，返回空 drafts 供 caller 跳过本轮——绝不抛到上层。
 */
export async function extractGroupMemoriesFromBuffer(
    messages: Message[],
    groupName: string,
    memberNames: string[],
    userLabel: string,
    speakerNameOf: (m: Message) => string,
    llmConfig: LightLLMConfig,
): Promise<GroupExtractionResult> {
    if (messages.length === 0) return { drafts: [] };

    const conversationText = buildGroupConversationText(messages, speakerNameOf);
    const memberList = memberNames.join('、');

    const systemPrompt = `You are an observer of the 【${groupName}】 group chat. Extract group memories worth retaining from the chat log below. Write all generated natural-language output in English.
Group members: ${memberList}
User: ${userLabel}

${buildGroupRulesBlock(groupName, memberNames, userLabel)}

## Output Format

Return a strict JSON array with no Markdown wrapper:
[
  {
    "content": "In 【${groupName}】, ...",
    "room": "living_room",
    "importance": 5,
    "mood": "neutral",
    "valence": 0,
    "arousal": 0,
    "tags": ["tag 1", "tag 2"]
  }
]

If the group chat is too trivial to contain a worthwhile memory, return an empty array [].`;

    try {
        const data = await safeFetchJson(
            `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${llmConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: llmConfig.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `Group chat log:\n${conversationText}` },
                    ],
                    temperature: 0.4,
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            2, 180_000, { appName: '记忆宫殿', purpose: '群记忆提取' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (parsed.length === 0 && reply.trim().length > 0) {
            console.warn(`🏰 [GroupExtraction] LLM 返回了内容但 JSON 解析为空数组。原始回复前200字: ${reply.slice(0, 200)}`);
        }

        const msgTimestamps = messages.map(m => m.timestamp).filter(t => t > 0);
        const midTime = msgTimestamps.length > 0
            ? Math.round((msgTimestamps[0] + msgTimestamps[msgTimestamps.length - 1]) / 2)
            : Date.now();

        const drafts: GroupMemoryDraft[] = parsed
            .filter((item: any) => item && typeof item.content === 'string' && item.content.trim() && item.room)
            .map((item: any): GroupMemoryDraft => ({
                content: item.content,
                room: (VALID_ROOMS.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: typeof item.mood === 'string' ? item.mood : 'neutral',
                valence: typeof item.valence === 'number' ? clampVA(item.valence) : undefined,
                arousal: typeof item.arousal === 'number' ? clampVA(item.arousal) : undefined,
                createdAt: midTime,
            }));

        console.log(`🏰 [GroupExtraction] 从 ${messages.length} 条群消息提取 ${drafts.length} 条群记忆草稿`);
        return { drafts };
    } catch (err: any) {
        console.warn(`❌ [GroupExtraction] 群记忆提取失败 (${messages.length} 条消息): ${err.message}`);
        return { drafts: [] };
    }
}
