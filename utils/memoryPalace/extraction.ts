/**
 * Memory Palace — 记忆提取 (Memory Extraction)
 *
 * 从聊天消息缓冲区提取 MemoryNode 数组，供后续向量化和 EventBox 绑定。
 * 不同重要性对应不同的记忆详细程度。
 */

import type { Message } from '../../types';
import type { MemoryNode, MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import { formatMessageForPrompt } from '../messageFormat';
import { buildUserPronounRule } from './userPronoun';

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 共用的 prompt 规则部分 ──────────────────────────
//
// 设计决策（2026-04）：palace extraction 的提示词**完全固定**，不会被用户
// 在"记忆归档设置"里选的模板影响。那里的模板只作用于手动归档路径
// （Chat.tsx handleFullArchive / Character.tsx handleBatchSummarize /
// handleForceArchiveDate）。
// 理由：palace 产出的 memory.content 要参与向量检索，风格化（"末尾加喵"之类）
// 会让 embedding 语义轻微漂移。保持 palace 内置风格稳定，手动归档路径提供
// 风格化的自由度——职责分离。

function buildRulesBlock(charName: string, userLabel: string): string {
    return `## Rules

1. **First-person narration**: Record each memory from ${charName}'s perspective using "I". Address the user directly as "${userLabel}". Preserve the complete course of the event rather than dropping its beginning or ending. Write every generated memory, tag, event name, correction note, and other natural-language output in English.
   Examples:
   - "${userLabel} worked late today without eating, so I told ${userLabel} not to neglect herself and ordered some food."
   - "After three straight weeks of overtime, ${userLabel} finally spoke to the manager, who responded reasonably well. On the way back, ${userLabel} cried against my shoulder; I said nothing and simply stayed close."
   - "I taught ${userLabel} recursion. At first ${userLabel} could not understand it, but the moment it clicked and her eyes lit up made me happy."

2. ${buildUserPronounRule(userLabel)}

3. **Use importance to control length**:
   - Importance 1-5: 15-50 English words, primarily factual.
   - Importance 6-7: 60-120 English words, including my feelings.
   - Importance 8-10: 100-200 English words, with a complete narrative (cause → event → my feelings/reaction).

4. **Room assignment** (anything involving ${userLabel}'s family, friends, colleagues, or other interpersonal relationships must go to user_room, even if it is only one specific event):
   - living_room: Pure everyday trivia with neither important relationships nor deep emotion, such as weather, food, or a passing complaint.
   - bedroom: Intimacy, deep bonds, and moving moments between ${userLabel} and me.
   - study: Work, learning, skills, and career matters.
   - user_room: All personal information and interpersonal events concerning ${userLabel}: birthday, habits, preferences, personality, upbringing, emotional patterns, and every event involving ${userLabel}'s family, relatives, friends, or colleagues. Even one-off events belong here rather than in living_room because they form the background of ${userLabel}'s social world.
   - self_room: My own growth and changes in identity.
   - attic: Unresolved conflict, confusion, or harm.
   - windowsill: My hopes, our goals, and aspirations for the future.

5. **Mood**: happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral.
6. **Emotion coordinates** (valence, arousal): Provide two-dimensional emotion coordinates in addition to mood.
   - valence: -1 (extreme pain) → +1 (extreme pleasure).
   - arousal: -1 (extreme calm) → +1 (extreme intensity).
   Reference values: happy ≈ (0.7, 0.5), peaceful ≈ (0.5, -0.6), dejected ≈ (-0.5, -0.4), anxious ≈ (-0.6, 0.7), angry ≈ (-0.7, 0.8).
7. **Tags**: Extract 2-5 English keyword tags.
8. **Do not miss important memories, but do not turn every sentence into one**. A topic box normally yields 1-5 memories.
9. **Temporary pinning** (optional pinDays): If a memory contains time-sensitive information that must remain salient in the near term, set 1-30 pin days. While pinned, it will be recalled in every conversation. Appropriate examples:
   - Time-bounded status: "${userLabel} is traveling for work this week" → pinDays: 7.
   - Near-term event: "${userLabel} has an exam the day after tomorrow" → pinDays: 3.
   - Temporary request: "${userLabel} asked me to remind her to drink water for the next few days" → pinDays: 5.
   - Health status: "${userLabel} has a cold" → pinDays: 5.
   Do not pin stable long-term facts, past events, or emotional memories. Most memories do not need pinning.

**Date field (required)**: Every message begins with a \`[YYYY-MM-DD HH:MM]\` timestamp. Set each memory's date to the actual day of that event in \`YYYY-MM-DD\` format, rather than assigning one day to the entire batch. If the batch spans multiple days, date each memory separately.`;
}

function buildConversationText(messages: Message[], charName: string, userLabel: string): string {
    // 每行带 [YYYY-MM-DD HH:MM] 时间戳前缀。
    // 没有这个 LLM 完全看不到日期，多日 batch 提取出来的记忆全部会被压到一个时间点
    // （见 parseMemoryNodesFromBuffer 的 midTime 兜底），跨日时间线就乱了。
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return messages
        .map(m => {
            const body = formatMessageForPrompt(m, charName, userLabel).slice(0, 600);
            const ts = m.timestamp;
            if (!ts || ts <= 0) return body;
            const d = new Date(ts);
            const stamp = `[${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}]`;
            return `${stamp} ${body}`;
        })
        .join('\n');
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

/** 从消息缓冲区直接解析记忆节点（不依赖 TopicBox） */
function parseMemoryNodesFromBuffer(
    parsed: any[], charId: string, messages: Message[], _batchLabel: string,
): MemoryNode[] {
    if (parsed.length === 0) return [];

    const msgTimestamps = messages.map(m => m.timestamp).filter(t => t > 0);
    const firstTs = msgTimestamps[0] ?? Date.now();
    const lastTs = msgTimestamps[msgTimestamps.length - 1] ?? firstTs;
    const midTime = Math.round((firstTs + lastTs) / 2);

    // 允许 LLM 写出的 date 略微越界（夜聊跨零点等），但要挡住完全不合理的（写错年月）
    const dayMs = 24 * 60 * 60 * 1000;
    const minTs = firstTs - dayMs;
    const maxTs = lastTs + dayMs;

    /** 解析 LLM 写的 date 字段 → 该日 12:00 本地时间。失败 / 越界则回到 midTime。 */
    const resolveCreatedAt = (raw: unknown): number => {
        if (typeof raw !== 'string') return midTime;
        const s = raw.trim();
        if (!s) return midTime;
        // 接受 "YYYY-MM-DD" / "YYYY/M/D" / "YYYY年M月D日" 等
        const norm = s.replace(/[年\/]/g, '-').replace(/[月日]/g, '');
        const parts = norm.split('-').map(p => parseInt(p, 10));
        if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return midTime;
        const [y, m, d] = parts;
        if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return midTime;
        // 用消息时间戳的本地时区表征"该日中午"——避免 UTC 解析跨日漂移
        const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
        const ts = dt.getTime();
        if (Number.isNaN(ts)) return midTime;
        if (ts < minTs || ts > maxTs) return midTime;
        return ts;
    };

    return parsed
        .filter(item => item.content && item.room)
        .map((item): MemoryNode => {
            const createdAt = resolveCreatedAt(item.date);
            const pinDays = parseInt(item.pinDays, 10);
            // 置顶 deadline 跟着 per-memory createdAt 算，否则"今天感冒 pinDays 5"
            // 会从 batch 中点起算，跨日 batch 里就直接少算/多算。
            const pinnedUntil = (pinDays > 0 && pinDays <= 30)
                ? createdAt + pinDays * 24 * 60 * 60 * 1000
                : null;
            // (v, a) 非必需：LLM 没给就不写，下游 getEmotionVA 查表兜底
            const v = typeof item.valence === 'number' ? clampVA(item.valence) : undefined;
            const a = typeof item.arousal === 'number' ? clampVA(item.arousal) : undefined;
            return {
                id: generateId(),
                charId,
                content: item.content,
                room: (VALID_ROOMS.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: item.mood || 'neutral',
                valence: v,
                arousal: a,
                embedded: false,
                createdAt,
                lastAccessedAt: createdAt,
                accessCount: 0,
                pinnedUntil,
                eventBoxId: null,  // 由 pipeline 在 binding 阶段设置
                origin: 'extraction',
            };
        });
}

/** 把 LLM 吐的 v/a 夹到 [-1, 1]，防止它写成 1.5 / -2 之类 */
function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

// ─── EventBox 绑定相关 prompt + 解析 helper（buffer / migration 共用） ──

/**
 * 构造"已有记忆"的 prompt 区块，带 O-编号供 LLM 引用。
 */
export function buildRelatedMemoriesBlock(relatedMemories: RelatedMemoryRef[]): string {
    if (relatedMemories.length === 0) return '';
    return `\n## Existing Memories (if a new memory describes the same event as, or is directly connected to, an old memory, cite its ID in relatedTo and provide eventName/eventTags for creating or merging an event box)\n${
        relatedMemories.map((r, i) => `O${i}. [${r.room}] ${r.content}`).join('\n')
    }\n`;
}

/**
 * 构造"事件关联 + 事件盒命名"的规则文本，追加到 buildRulesBlock 之后。
 */
export function buildRelatedToRule(): string {
    return `\n9. **Event-box links** (relatedTo / sameAs + eventName + eventTags):
   **Same event as an old memory** → put the matching O IDs in relatedTo, such as ["O0", "O3"].
   **Same event as another new memory in this output** → put that item's zero-based JSON-array index in sameAs. It may only point to an earlier output item; for example, ["0"] refers to the first array item.
   Link only genuinely identical events: a continuation, outcome, recurrence, or direct consequence of the same event. Mere topic similarity is insufficient.
   If either relatedTo or sameAs is nonempty, also provide:
   - eventName: a concise 2-8 word English noun phrase naming the event, such as "clothes shopping discussion" or "conflict with the manager".
   - eventTags: 3-6 detailed English search tags using concrete nouns, people, places, and actions.
   If neither link exists, omit relatedTo, sameAs, eventName, and eventTags.
10. **Avoid duplicate binding**: If one new memory links to several old or new memories, include every ID but provide only one eventName/eventTags set describing the whole event.
11. **Correcting an old memory** (optional correct item, separate from memory objects):
   Use this only when the user explicitly says that an existing memory is wrong, outdated, or inaccurate and clearly contradicts something you just said.
   If applicable, append this item at the end of the JSON array:
   {"correct": "O ID", "note": "the corrected fact in a short, neutral English sentence"}
   The note states what is true, not why the old memory was wrong. Example: if the user says "I moved and no longer live in Chaoyang," use note: "Moved away and no longer lives in Chaoyang."
   Do not use correct for:
   - A later development or status update → use relatedTo.
   - An added detail → do not mark it as a correction.
   - Ambiguity or self-correction that you inferred yourself → do not mark it.
   Use at most 1-2 correction items per conversation.`;
}

/**
 * 输出格式中的字段示例（如果有 relatedMemories 才注入）。
 */
export function buildRelatedToFormatHint(): string {
    return `,
    "relatedTo": ["O0"],
    "sameAs": ["0"],
    "eventName": "clothes shopping discussion",
    "eventTags": ["clothes", "shopping", "return", "trendy style"]`;
}

/**
 * 从 LLM 输出（已解析 JSON）和提取出的 memories 中，
 * 解析出：
 *  - crossTimeLinks（newMemoryId → existingMemoryId）
 *  - eventBoxHints（newMemoryId → eventName / eventTags）
 *
 * 注意：parsed 数组顺序应该与 memories 顺序对齐（同源 LLM 输出）。
 */
export function parseRelatedToAndHints(
    parsed: any[],
    memories: MemoryNode[],
    relatedMemories: RelatedMemoryRef[],
): { crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[]; eventBoxHints: EventBoxHint[] } {
    const crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[] = [];
    const eventBoxHints: EventBoxHint[] = [];

    if (memories.length === 0) {
        return { crossTimeLinks, eventBoxHints };
    }

    // parsed 包含的不只是 memory（还可能有 unpin 指令等），按 memory 顺序对齐：
    // memories 是 parsed.filter(item => item.content && item.room) 的结果，
    // 用同样的过滤遍历 parsed，按位次匹配 memories。
    let memIdx = 0;
    for (const item of parsed) {
        if (!item || !item.content || !item.room) continue;
        const mem = memories[memIdx++];
        if (!mem) break;

        let hasAnyLink = false;

        // (a) relatedTo → O 索引指向已有记忆
        if (relatedMemories.length > 0 && Array.isArray(item.relatedTo) && item.relatedTo.length > 0) {
            for (const ref of item.relatedTo) {
                const idx = parseInt(String(ref).replace(/^O/i, ''), 10);
                if (idx >= 0 && idx < relatedMemories.length) {
                    crossTimeLinks.push({
                        newMemoryId: mem.id,
                        existingMemoryId: relatedMemories[idx].id,
                    });
                    hasAnyLink = true;
                }
            }
        }

        // (b) sameAs → N 索引指向本批次之前的新记忆（靠数组 0-base index 索引）
        //     memIdx 已经 ++，当前这条在 memories 中的位置是 memIdx-1；允许引用 0..memIdx-2
        if (Array.isArray(item.sameAs) && item.sameAs.length > 0) {
            const currentPos = memIdx - 1;
            for (const ref of item.sameAs) {
                const idx = parseInt(String(ref).replace(/^N/i, ''), 10);
                if (idx >= 0 && idx < currentPos && memories[idx]) {
                    crossTimeLinks.push({
                        newMemoryId: mem.id,
                        existingMemoryId: memories[idx].id, // 此时 memories[idx] 的 id 已经生成
                    });
                    hasAnyLink = true;
                }
            }
        }

        // (c) 如果任一关联成立，收集 eventName/eventTags 作为 hints
        if (hasAnyLink) {
            const name = typeof item.eventName === 'string' ? item.eventName.trim() : '';
            const tags = Array.isArray(item.eventTags)
                ? item.eventTags.map((t: any) => String(t).trim()).filter(Boolean)
                : [];
            if (name || tags.length > 0) {
                eventBoxHints.push({
                    newMemoryId: mem.id,
                    eventName: name,
                    eventTags: tags,
                });
            }
        }
    }

    if (crossTimeLinks.length > 0) {
        console.log(`🔗 [Extraction] 发现 ${crossTimeLinks.length} 条同事件关联（含跨批次 relatedTo 与同批 sameAs），${eventBoxHints.length} 条带命名提示`);
    }
    return { crossTimeLinks, eventBoxHints };
}

// ─── 跨时间关联：传入向量检索命中的旧记忆供 LLM 关联 ───

/** 向量检索命中的已有记忆引用，用于跨时间事件关联 */
export interface RelatedMemoryRef {
    id: string;       // MemoryNode.id
    room: string;
    content: string;  // 截断的内容摘要
}

/** 当前生效的便利贴引用 */
export interface PinnedMemoryRef {
    id: string;
    content: string;
}

/**
 * EventBox 创建/合并提示。
 * 当 LLM 把新记忆 N 标记为 relatedTo 旧记忆 O 时，附带的盒名/标签提示。
 * pipeline 在 binding 时使用：若需要新建 EventBox，用此名/tags 初始化。
 */
export interface EventBoxHint {
    /** 触发该 hint 的新记忆 ID */
    newMemoryId: string;
    /** LLM 建议的事件盒名（如"买衣服"） */
    eventName: string;
    /** LLM 建议的详细 tag */
    eventTags: string[];
}

/** 缓冲区提取结果，包含跨时间关联信息 */
export interface BufferExtractionResult {
    memories: MemoryNode[];
    /** 新记忆 → 关联的已有记忆 ID 映射（用于 EventBox 绑定） */
    crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[];
    /** EventBox 名/tag 提示（仅 relatedTo 非空的新记忆才有） */
    eventBoxHints: EventBoxHint[];
    /** 应提前摘除的便利贴 ID */
    unpinIds: string[];
    /** 纠正：把对应已有记忆的 content 追加一行"YYYY-MM-DD 纠正：note"，并重新向量化 */
    corrections: { targetId: string; note: string }[];
}

// ─── 缓冲区提取：直接从消息提取记忆，不依赖 TopicBox ───

/**
 * 从消息缓冲区直接提取记忆节点。
 * 用于缓冲区机制：积累的聊天消息达到阈值后，一次 LLM 调用提取记忆。
 *
 * @param relatedMemories 向量检索命中的已有记忆，供 LLM 判断跨时间事件关联（搭便车，不额外调用）
 * @param pinnedMemories 当前生效的便利贴，供 LLM 判断是否应提前摘除（搭便车）
 */
export async function extractMemoriesFromBuffer(
    messages: Message[],
    charId: string,
    charName: string,
    llmConfig: LightLLMConfig,
    charContext?: string,
    userName?: string,
    relatedMemories?: RelatedMemoryRef[],
    pinnedMemories?: PinnedMemoryRef[],
): Promise<BufferExtractionResult> {
    if (messages.length === 0) return { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };

    const userLabel = userName || 'the user';
    const conversationText = buildConversationText(messages, charName, userLabel);

    const contextBlock = charContext
        ? `\n## Your Character Profile (reference for understanding relationships and roles in the conversation)\n${charContext}\n`
        : '';

    // 构建已有记忆引用块（带 O-编号，供 LLM 输出 relatedTo）
    const hasRelated = relatedMemories && relatedMemories.length > 0;
    const relatedBlock = hasRelated
        ? buildRelatedMemoriesBlock(relatedMemories!)
        : '';
    const relatedToRule = hasRelated ? buildRelatedToRule() : '';
    const relatedToFormat = hasRelated ? buildRelatedToFormatHint() : '';

    // 便利贴摘除判断
    const hasPinned = pinnedMemories && pinnedMemories.length > 0;
    const pinnedBlock = hasPinned
        ? `\n## Current Pinned Notes (if the conversation explicitly shows that a note is no longer valid, add an unpin item at the end of the output)\n${
            pinnedMemories!.map((p, i) => `P${i}. ${p.content}`).join('\n')
          }\n`
        : '';

    const unpinRule = hasPinned
        ? `\n12. **Removing a pinned note** (optional unpin): If the conversation explicitly states that a pinned status has ended, such as recovery from a cold, returning early, or finishing an exam, append {"unpin": "P0"} to the JSON array. Unpin only when the conversation says so; never guess.`
        : '';

    const systemPrompt = `You are ${charName}. From the conversation below, extract memories worth retaining from your first-person ("I") perspective. Write every generated natural-language value in English, even when the source conversation is in another language.${contextBlock}${relatedBlock}${pinnedBlock}

${buildRulesBlock(charName, userLabel)}${relatedToRule}${unpinRule}

## Output Format

Return a strict JSON array with no Markdown wrapper:
[
  {
    "content": "An English memory from my perspective...",
    "room": "living_room",
    "importance": 5,
    "mood": "neutral",
    "valence": 0,
    "arousal": 0,
    "tags": ["tag 1", "tag 2"],
    "date": "YYYY-MM-DD",
    "pinDays": 3${relatedToFormat}
  }
]

date is required and must match the day the event actually occurred, using the timestamp at the start of the relevant message line.
Include pinDays only when pinning is necessary; most memories do not need it.
If the conversation is too trivial to contain a worthwhile memory, return an empty array [].`;

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
                        { role: 'user', content: `Conversation:\n${conversationText}` },
                    ],
                    temperature: 0.4,
                    // 12000 比 16000 留余量：避免 LLM 顶满 cap 导致 JSON 输出被 truncate
                    // buffer 路径 pipeline 上层 CHUNK_SIZE=250 已经在切分 → 单 call 输出可控
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            2, 180_000, { appName: '记忆宫殿', purpose: '记忆提取' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (parsed.length === 0 && reply.trim().length > 0) {
            console.warn(`🏰 [Extraction] LLM 返回了内容但 JSON 解析为空数组，可能格式异常。原始回复前200字: ${reply.slice(0, 200)}`);
        }

        console.log(`🏰 [Extraction] 缓冲区提取完成：从 ${messages.length} 条消息中提取 ${parsed.length} 条记忆`);

        // 生成日期标签
        const firstTs = messages[0]?.timestamp;
        const lastTs = messages[messages.length - 1]?.timestamp;
        const d1 = (firstTs != null && firstTs > 0) ? new Date(firstTs) : new Date();
        const d2 = (lastTs != null && lastTs > 0) ? new Date(lastTs) : d1;
        const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
        const batchLabel = fmt(d1) === fmt(d2) ? fmt(d1) : `${fmt(d1)}-${fmt(d2)}`;

        const memories = parseMemoryNodesFromBuffer(parsed, charId, messages, batchLabel);

        // 解析跨时间关联（→ EventBox 绑定信号）+ eventName/eventTags 提示
        const { crossTimeLinks, eventBoxHints } = parseRelatedToAndHints(
            parsed, memories, hasRelated ? relatedMemories! : [],
        );

        // 解析便利贴摘除指令：{ "unpin": "P0" } → 真实 ID
        const unpinIds: string[] = [];
        if (hasPinned) {
            for (const item of parsed) {
                if (item.unpin && typeof item.unpin === 'string') {
                    const idx = parseInt(item.unpin.replace(/^P/i, ''), 10);
                    if (idx >= 0 && idx < pinnedMemories!.length) {
                        unpinIds.push(pinnedMemories![idx].id);
                    }
                }
            }
            if (unpinIds.length > 0) {
                console.log(`📌 [Extraction] LLM 建议摘除 ${unpinIds.length} 条便利贴`);
            }
        }

        // 解析纠正指令：{ "correct": "O0", "note": "实情是..." } → 真实 ID
        // 仅在有 relatedMemories 时才有意义（O 编号必须能解析回真节点 id）
        const corrections: { targetId: string; note: string }[] = [];
        if (hasRelated) {
            for (const item of parsed) {
                if (!item || typeof item.correct !== 'string') continue;
                const note = typeof item.note === 'string' ? item.note.trim() : '';
                if (!note) continue;
                const idx = parseInt(item.correct.replace(/^O/i, ''), 10);
                if (idx >= 0 && idx < relatedMemories!.length) {
                    corrections.push({ targetId: relatedMemories![idx].id, note });
                }
            }
            if (corrections.length > 0) {
                console.log(`✏️ [Extraction] LLM 标记 ${corrections.length} 条纠正：${corrections.map(c => c.targetId.slice(0, 12) + '…').join(', ')}`);
            }
        }

        return { memories, crossTimeLinks, eventBoxHints, unpinIds, corrections };

    } catch (err: any) {
        console.error(`❌ [Extraction] 缓冲区提取失败 (${messages.length} 条消息):`, err.message);
        return { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };
    }
}
