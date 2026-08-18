/**
 * 外部记忆搬家
 *
 * 给「神经链接 -> 传统记忆」和「记忆宫殿 -> 向量记忆」共用：
 * - 单次最多 5 万字；
 * - 按自然段分批调用 LLM，避免长输入时模型只处理开头；
 * - 只整理时间与结构，不做摘要、不删除细节；
 * - 输出可直接转成 MemoryNode，供后续 embedding / 建链。
 */

import type { MemoryNode, MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { buildUserPronounRule } from './userPronoun';

export const EXTERNAL_MEMORY_MAX_CHARS = 50_000;
export const EXTERNAL_MEMORY_CHUNK_CHARS = 10_000;
export const EXTERNAL_MEMORY_MIN_CONTENT_RATIO = 0.72;

export interface ExternalMemoryLengthInfo {
    /** Unicode 字符数（emoji 等代理对按 1 个字符计算），完全在本地统计。 */
    count: number;
    limit: number;
    overLimit: boolean;
    overBy: number;
    /** 超限时建议拆成几次导入；未超限为 1。 */
    suggestedBatches: number;
}

export function getExternalMemoryLengthInfo(rawText: string): ExternalMemoryLengthInfo {
    const count = Array.from(rawText).length;
    return {
        count,
        limit: EXTERNAL_MEMORY_MAX_CHARS,
        overLimit: count > EXTERNAL_MEMORY_MAX_CHARS,
        overBy: Math.max(0, count - EXTERNAL_MEMORY_MAX_CHARS),
        suggestedBatches: Math.max(1, Math.ceil(count / EXTERNAL_MEMORY_MAX_CHARS)),
    };
}

export function getExternalMemoryOverLimitMessage(rawText: string): string {
    const info = getExternalMemoryLengthInfo(rawText);
    if (!info.overLimit) return '';
    return `当前 ${info.count.toLocaleString()} 字，超过单次上限 ${info.limit.toLocaleString()} 字。`
        + `建议按原文顺序拆成 ${info.suggestedBatches} 批，每批不超过 5 万字，优先在日期或完整事件段落之间切开。`
        + '当前内容不会上传，也不会调用 API。';
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];
const VALID_MOODS = new Set([
    'happy', 'sad', 'angry', 'anxious', 'tender', 'excited',
    'peaceful', 'confused', 'hurt', 'grateful', 'nostalgic', 'neutral',
]);

export interface ExternalMemoryBatchResult {
    index: number;
    total: number;
    extracted: number;
    ok: boolean;
    error?: string;
}

export interface ExternalMemoryExtractionResult {
    memories: MemoryNode[];
    batches: ExternalMemoryBatchResult[];
}

/** 保留原文顺序，优先在换行处分批；不对内容做摘要或字符截断。 */
export function splitExternalMemoryText(
    rawText: string,
    chunkChars: number = EXTERNAL_MEMORY_CHUNK_CHARS,
): string[] {
    const text = rawText.replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    const lengthInfo = getExternalMemoryLengthInfo(text);
    if (lengthInfo.overLimit) {
        throw new Error(getExternalMemoryOverLimitMessage(text));
    }
    if (chunkChars < 1) throw new Error('分批长度必须大于 0');

    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
        let end = Math.min(cursor + chunkChars, text.length);
        if (end < text.length) {
            // 至少走过本批 60% 后才回找自然边界，避免遇到很早的换行就切出碎片。
            const minNaturalBreak = cursor + Math.floor(chunkChars * 0.6);
            const newline = text.lastIndexOf('\n', end);
            if (newline >= minNaturalBreak) end = newline + 1;
        }
        const chunk = text.slice(cursor, end).trim();
        if (chunk) chunks.push(chunk);
        cursor = end;
    }
    return chunks;
}

export function buildExternalMemoryPrompt(charName: string, userName: string): string {
    const userLabel = userName || 'the user';
    return `You are an External Memory Migration Organizer. This text comes from another app, device, or memory system and must be migrated into ${charName}'s memories.

You must satisfy both non-negotiable goals:
A. Return one complete JSON array that the program can parse directly and whose fields follow the schema below.
B. Migrate the source losslessly: organize only time and structure without compressing content. Translate all natural-language output faithfully into English while preserving every fact and nuance.

1. Do not summarize, generalize, polish, paraphrase, merge similar items, or deduplicate. Never replace an experience with a one-sentence conclusion or use omissions such as "etc." or "same as above."
2. Preserve every concrete fact, person, form of address, place, number, line of dialogue, action, causal link, sequence, emotion, and subtle reaction. Split into more entries if necessary; omit nothing. Translate non-English narration and dialogue faithfully into English without shortening or changing their meaning.
3. Establish each person's identity before making any necessary perspective conversion. Never mechanically assign every "I/you/he/she/they" to the same person.
   - The memory owner is always "${charName}"; the user who talks and spends time with them is always "${userLabel}".
   - Identity evidence priority: explicit name or role label in the source > speaker label and context > pronoun. Explicit evidence wins; guesses must never override a name.
   - When the source explicitly identifies ${charName} as the narrator, the narrator's "I" may become the memory's first-person "I." When ${userLabel}/the user is the narrator, "I" must become "${userLabel}" and must never become ${charName}'s "I."
   - Keep third parties under their original names or forms of address; never silently turn them into ${charName} or ${userLabel}.
   - First-person language inside quoted dialogue belongs to the original speaker. Translate the dialogue faithfully but never replace its "I" with the memory owner.
   - If a fragment has no speaker label and a pronoun cannot be resolved reliably, retain the original form of address or pronoun in faithful English and do not invent a relationship.
   Example: if the source is labeled "${userLabel}: I took the doll outside," write "${userLabel} took the doll outside," not "I took the doll outside." Only a source labeled "${charName}: I did not dare ask" may become "I did not dare ask."
   ${buildUserPronounRule(userLabel)} This is a rewriting rule for pronouns only; it never overrides the identity evidence above, and it never changes who did what.
4. The 1,500-character guidance is only a splitting cue for one content value, not a compression target. If an event is too long, split it continuously at natural paragraph boundaries and carry every detail forward. Never delete, abbreviate, or truncate to meet a length target.
5. Set date to the event's actual date in YYYY-MM-DD format. If the source gives only a month, use YYYY-MM; if only a year, use YYYY; if completely uncertain, use null. Never guess a date.
6. Assign room by the memory's subject and purpose; do not put something in attic merely because it is negative:
   - living_room: Pure everyday trivia.
   - bedroom: Shared experiences, intimacy, and deep bonds between ${userLabel} and me, even when sadness or conflict is involved.
   - study: Work, learning, skills, and career.
   - user_room: ${userLabel}'s personal information, experiences, family, friends, colleagues, and interpersonal events, even when negative.
   - self_room: My own growth, changes in identity, and personal experiences.
   - attic: Only memories that are explicitly still unresolved and fundamentally concern conflict, ongoing confusion, or harm/trauma that continues to have an effect.
   - windowsill: Hopes, goals, and future wishes.
   Classify by the event's subject first. Sadness, anger, arguments, injury, or low valence alone do not imply attic. If the source does not explicitly say something remains unresolved or troubling, prefer the appropriate bedroom, user_room, self_room, study, or living_room.
7. importance is 1-10. mood must be one of happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral. tags must be English and preserve concrete people, places, and event keywords.
8. This batch may be a middle segment of a larger source. Process only content that actually appears in this batch. Do not invent context or add placeholders such as "what happened next is unknown."

The output format is equally strict:
- Output exactly one complete JSON array, with no explanation, title, Markdown fence, or other characters before or after it.
- Use double quotes as required by JSON. Escape double quotes, backslashes, and newlines inside strings according to JSON rules.
- Do not include comments, trailing commas, or unclosed objects, and do not return only the first part of the batch.
- Every memory object must contain date, content, room, importance, mood, valence, arousal, and tags.
- Every natural-language value in the output must be English.

Format:
[
  {
    "date": "YYYY-MM-DD",
    "content": "A first-person English memory preserving every detail",
    "room": "user_room",
    "importance": 7,
    "mood": "nostalgic",
    "valence": 0.2,
    "arousal": -0.1,
    "tags": ["specific person", "specific event"]
  }
]

If the source contains no valid content, return [].`;
}

/** 搬家不能使用通用 JSON 的“截断抢救”：只接受完整、独立、可解析的 JSON 数组。 */
export function parseCompleteExternalMemoryReply(raw: string): any[] {
    const cleaned = raw.trim();
    if (!cleaned.startsWith('[') || !cleaned.endsWith(']')) {
        throw new Error('模型没有返回完整 JSON 数组');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        throw new Error('模型返回的 JSON 格式无效');
    }
    if (!Array.isArray(parsed)) throw new Error('模型返回结果不是 JSON 数组');
    return parsed;
}

function meaningfulCharCount(text: string): number {
    return Array.from(text).filter(char => !/\s/u.test(char)).length;
}

/**
 * 防止“格式看似正确、内容却明显缩水”的硬兜底。
 * 语义是否被细微改写仍由提示词约束；这里拒绝可确定的大幅摘要或漏段。
 */
export function assertExternalMemoryCoverage(source: string, nodes: MemoryNode[]): void {
    const sourceChars = meaningfulCharCount(source);
    if (sourceChars === 0) return;
    const outputChars = nodes.reduce((sum, node) => sum + meaningfulCharCount(node.content), 0);
    const ratio = outputChars / sourceChars;
    if (nodes.length === 0 || ratio < EXTERNAL_MEMORY_MIN_CONTENT_RATIO) {
        throw new Error(
            `模型输出疑似删减或压缩内容（仅保留约 ${Math.round(ratio * 100)}%），已拒绝写入`,
        );
    }
}

function clampVA(value: unknown): number | undefined {
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
    return Math.max(-1, Math.min(1, value));
}

function parseExternalDate(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return null;
    const normalized = raw
        .replace(/[年\/.]/g, '-')
        .replace(/月/g, '-')
        .replace(/日/g, '')
        .replace(/-+/g, '-');
    const match = normalized.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = match[2] ? Number(match[2]) : 1;
    const day = match[3] ? Number(match[3]) : (match[2] ? 15 : 1);
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (
        date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day
    ) return null;
    return date.getTime();
}

/** 确认模型不只是“能解析”，而是每一项都严格符合搬家契约。 */
export function assertExternalMemorySchema(parsed: any[]): void {
    parsed.forEach((item, index) => {
        const label = `第 ${index + 1} 条`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`${label}不是 JSON 对象`);
        }
        if (typeof item.content !== 'string' || !item.content.trim()) {
            throw new Error(`${label}缺少有效 content`);
        }
        if (item.date !== null && (typeof item.date !== 'string' || parseExternalDate(item.date) === null)) {
            throw new Error(`${label}的 date 格式无效`);
        }
        if (!VALID_ROOMS.includes(item.room as MemoryRoom)) {
            throw new Error(`${label}的 room 不在允许范围内`);
        }
        if (typeof item.importance !== 'number' || item.importance < 1 || item.importance > 10) {
            throw new Error(`${label}的 importance 必须是 1-10 的数字`);
        }
        if (typeof item.mood !== 'string' || !VALID_MOODS.has(item.mood)) {
            throw new Error(`${label}的 mood 不在允许范围内`);
        }
        if (typeof item.valence !== 'number' || item.valence < -1 || item.valence > 1) {
            throw new Error(`${label}的 valence 必须是 -1 到 1 的数字`);
        }
        if (typeof item.arousal !== 'number' || item.arousal < -1 || item.arousal > 1) {
            throw new Error(`${label}的 arousal 必须是 -1 到 1 的数字`);
        }
        if (!Array.isArray(item.tags) || item.tags.some((tag: unknown) => typeof tag !== 'string')) {
            throw new Error(`${label}的 tags 必须是字符串数组`);
        }
    });
}

export function parseExternalMemoryItems(
    parsed: any[],
    charId: string,
    importedAt: number = Date.now(),
    orderOffset: number = 0,
): MemoryNode[] {
    return parsed
        .filter(item => item && typeof item.content === 'string' && item.content.trim())
        .map((item, index): MemoryNode => {
            const content = item.content.trim();
            const parsedDate = parseExternalDate(item.date);
            // 无日期内容仍保持原文顺序；每条错开一分钟，列表排序稳定。
            const createdAt = parsedDate ?? importedAt + (orderOffset + index) * 60_000;
            const room = VALID_ROOMS.includes(item.room as MemoryRoom)
                ? item.room as MemoryRoom
                : 'living_room';
            return {
                id: `mn_ext_${Date.now()}_${orderOffset + index}_${Math.random().toString(36).slice(2, 8)}`,
                charId,
                content,
                room,
                tags: Array.isArray(item.tags)
                    ? item.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean)
                    : [],
                importance: Math.max(1, Math.min(10, Math.round(Number(item.importance) || 5))),
                mood: typeof item.mood === 'string' && item.mood.trim() ? item.mood.trim() : 'neutral',
                valence: clampVA(item.valence),
                arousal: clampVA(item.arousal),
                embedded: false,
                createdAt,
                lastAccessedAt: createdAt,
                accessCount: 0,
                pinnedUntil: null,
                eventBoxId: null,
                origin: 'extraction',
            };
        });
}

/**
 * 清洗一份外部文本。这里仅调用对话模型并产出节点，不写数据库；
 * 调用方可选择写传统记忆，或继续走 embedding + 建链。
 */
export async function extractExternalMemoryText(
    rawText: string,
    charId: string,
    charName: string,
    userName: string,
    llmConfig: LightLLMConfig,
    onProgress?: (stage: string) => void,
): Promise<ExternalMemoryExtractionResult> {
    const chunks = splitExternalMemoryText(rawText);
    const memories: MemoryNode[] = [];
    const batches: ExternalMemoryBatchResult[] = [];
    const systemPrompt = buildExternalMemoryPrompt(charName, userName);
    const importedAt = Date.now();

    for (let index = 0; index < chunks.length; index++) {
        onProgress?.(`正在清洗第 ${index + 1}/${chunks.length} 批（只整理时间，不压缩内容）…`);
        let lastError: unknown;
        let completed = false;
        for (let attempt = 0; attempt < 2 && !completed; attempt++) {
            try {
                if (attempt > 0) {
                    onProgress?.(`第 ${index + 1}/${chunks.length} 批格式或完整性未通过，正在无损重试…`);
                }
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
                                {
                                    role: 'user',
                                    content: `${attempt > 0
                                        ? 'The previous output failed the completeness check. Reprocess the entire batch: return complete JSON, translate all natural-language values into English, and do not omit, paraphrase, or compress any source content.\n\n'
                                        : ''}This is external-memory source batch ${index + 1}/${chunks.length}:\n\n${chunks[index]}`,
                                },
                            ],
                            temperature: 0.05,
                            max_tokens: 16_000,
                            stream: false,
                        }),
                    },
                    2,
                    180_000,
                    { appName: '记忆搬家', purpose: '外部记忆清洗' },
                );
                if (data.choices?.[0]?.finish_reason === 'length') {
                    throw new Error('模型输出达到长度上限，内容可能被截断');
                }
                const reply = data.choices?.[0]?.message?.content || '';
                const parsed = parseCompleteExternalMemoryReply(reply);
                assertExternalMemorySchema(parsed);
                const nodes = parseExternalMemoryItems(parsed, charId, importedAt, memories.length);
                assertExternalMemoryCoverage(chunks[index], nodes);
                memories.push(...nodes);
                batches.push({ index: index + 1, total: chunks.length, extracted: nodes.length, ok: true });
                completed = true;
            } catch (error) {
                lastError = error;
            }
        }
        if (!completed) {
            batches.push({
                index: index + 1,
                total: chunks.length,
                extracted: 0,
                ok: false,
                error: (lastError as any)?.message || String(lastError),
            });
            // 搬家按整次原子处理：一批失败后不再消耗后续 API，caller 也不会写入前面批次。
            break;
        }
    }

    return { memories, batches };
}
