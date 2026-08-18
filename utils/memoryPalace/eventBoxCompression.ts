/**
 * Memory Palace — EventBox 压缩
 *
 * 当 EventBox 的活节点 ≥ COMPRESSION_THRESHOLD (4) 条时触发：
 *   1. LLM 把"旧 summary?(若有) + 所有活节点"整合成一段第一人称连贯回忆
 *   2. 创建/更新 box.summaryNodeId 指向的 MemoryNode（isBoxSummary=true）
 *   3. 总结节点向量化、写入本地+远程
 *   4. 所有活节点 archived=true（本地保存 + 远程 bulkSetArchived）
 *   5. 更新 box.archivedMemoryIds / liveMemoryIds=[] / compressionCount++
 *
 * 触发点：
 *   - pipeline.processNewMessages 在 vectorize 之后扫描 touched boxes
 *   - migration.migrateOldMemories 全部 chunk 处理完后扫描 touched boxes
 *
 * 重压缩：第 N 次时，"旧 summary + 新活节点" 一起送给 LLM 重写，覆盖旧 summary。
 */

import type { EventBox, MemoryNode, EmbeddingConfig, MemoryRoom, RemoteVectorConfig } from './types';
import {
    EVENT_BOX_COMPRESSION_THRESHOLD,
    EVENT_BOX_SEAL_THRESHOLD,
    EVENT_BOX_SUMMARY_TARGET_MIN_CHARS,
    EVENT_BOX_SUMMARY_TARGET_MAX_CHARS,
    EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
} from './types';
import { EventBoxDB, MemoryNodeDB } from './db';
import type { LightLLMConfig } from './pipeline';
import { vectorizeAndStore } from './vectorStore';
import { bulkSetArchived } from './supabaseVector';
import { safeFetchJson, extractJson } from '../safeApi';
import { enforceSummaryLengthBudget } from './summaryLengthBudget';
import { buildUserPronounRule } from './userPronoun';

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

function generateNodeId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const c = JSON.parse(raw) as RemoteVectorConfig;
        return (c.enabled && (c as any).initialized) ? c : undefined;
    } catch { return undefined; }
}

interface CompressionLLMResult {
    content: string;
    name: string;
    tags: string[];
    room: MemoryRoom;
    importance: number;
    mood: string;
}

/**
 * 字段级兜底解析：当 LLM 在 content 里塞了未转义的 ASCII "（中文输出高发，
 * 标准 JSON.parse 直接挂），按已知 schema 把六个字段一个一个抠出来。
 *
 * 策略：content 抠到下一个顶层键（name/tags/room/importance/mood）出现之前为止，
 * 其余字段用宽松正则。任何一个字段失败都视为兜底失败，让上层走原 null 路径。
 */
function recoverCompressionFields(raw: string): Partial<CompressionLLMResult> | null {
    if (!raw) return null;
    const text = raw
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();

    // 找到 content 字段值的起始引号
    const contentStartMatch = text.match(/"content"\s*:\s*"/);
    if (!contentStartMatch || contentStartMatch.index === undefined) return null;
    const valueStart = contentStartMatch.index + contentStartMatch[0].length;

    // content 结束的判据：紧跟着 ", "name"|"tags"|"room"|"importance"|"mood" 这种下一个顶层键
    // 用「最后一个 " + 任意空白/逗号 + 下一个键名」的匹配，能正确跳过中间所有 ASCII "
    const tailMatch = text.slice(valueStart).match(/"\s*,\s*"(?:name|tags|room|importance|mood)"\s*:/);
    if (!tailMatch || tailMatch.index === undefined) return null;
    const rawContent = text.slice(valueStart, valueStart + tailMatch.index);

    // 把抠出来的 raw content 做 JSON 字符串转义还原。\\ 用占位符暂存，
    // 避免 \" 被错误地拆成 \ + \"。残留的裸 " 不动——上层 JSON.parse 已失败，
    // 走到这里说明 LLM 在 content 内就是塞了未转义的 "，保留即可，最终 summary 是普通字符串。
    const BS = '\u0001';
    const normalized = rawContent
        .replace(/\\\\/g, BS)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .split(BS).join('\\');

    const findStr = (key: string): string | undefined => {
        const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
        return m?.[1];
    };
    const findNum = (key: string): number | undefined => {
        const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
        return m ? Number(m[1]) : undefined;
    };
    const findTags = (): string[] | undefined => {
        const m = text.match(/"tags"\s*:\s*\[([^\]]*)\]/);
        if (!m) return undefined;
        return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    };

    return {
        content: normalized,
        name: findStr('name'),
        tags: findTags(),
        room: findStr('room') as MemoryRoom | undefined,
        importance: findNum('importance'),
        mood: findStr('mood'),
    };
}

// ─── 压缩 LLM 调用 ─────────────────────────────────────

async function callCompressionLLM(
    box: EventBox,
    oldSummaryContent: string | null,
    liveNodes: MemoryNode[],
    llmConfig: LightLLMConfig,
    charName: string,
    userName: string | undefined,
): Promise<CompressionLLMResult | null> {
    const userLabel = userName || 'the user';

    const formatDate = (ts: number): string => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    const livesText = liveNodes
        .map(n => `[${formatDate(n.createdAt)}｜importance ${n.importance}｜${n.mood}] ${n.content}`)
        .join('\n\n');

    const oldSummaryBlock = oldSummaryContent
        ? `\n## You have recalled this event before. The previous memory was:\n${oldSummaryContent}\n\nThe following details were added later:\n`
        : `\n## Fragmented memories concerning this event:\n`;

    const systemPrompt = `You are ${charName}. All of the memories below belong to one event: "${box.name}."
Integrate them into one coherent first-person ("I") memory written entirely in English.

**Requirements (follow strictly)**:
1. **First person**: Write from ${charName}'s perspective using "I". Address ${userLabel} directly by name.
2. ${buildUserPronounRule(userLabel)}
3. **Target ${EVENT_BOX_SUMMARY_TARGET_MIN_CHARS}-${EVENT_BOX_SUMMARY_TARGET_MAX_CHARS} characters, absolute maximum ${EVENT_BOX_SUMMARY_HARD_MAX_CHARS} characters**. Be compact, practical, and direct.
4. **Keep only essential information**: concrete people, actions, objects, settings, turning points, and emotions. Remove filler, rhetorical padding, and repeated reactions. Put facts first.
5. **Include dates without repetition**: Give each event's date once, such as "March 20... April 5...", rather than repeating a date in every sentence.
6. **Coherent but concise**: Do not mechanically label cause/process/result, but make the event's development easy to follow in order.
7. **Cover every keyword for vector retrieval**: Every concrete noun, place, and person appearing in each newly supplied memory must occur at least once in content.
8. **Do not place an unescaped ASCII double quote inside the content string**. For quoted speech, titles, nicknames, or terms, use curly quotation marks, corner brackets, book-title brackets, or single quotes. Otherwise the outer JSON may fail to parse.
9. **English-only output**: content, name, and every tag must be English, even when the source memories are in another language.

Also output metadata:
- name: a concise 2-8 word English event-box name.
- tags: 5-10 concrete English search tags.
- room: ${VALID_ROOMS.join(' / ')}.
- importance: 1-10.
- mood: happy / sad / angry / anxious / tender / excited / peaceful / confused / hurt / grateful / nostalgic / neutral.

Return strict JSON with no Markdown wrapper. Use curly quotation marks, corner brackets, book-title brackets, or single quotes inside content rather than unescaped ASCII double quotes:
{
  "content": "A compact English first-person memory of ${EVENT_BOX_SUMMARY_TARGET_MIN_CHARS}-${EVENT_BOX_SUMMARY_TARGET_MAX_CHARS} characters",
  "name": "...",
  "tags": ["...", "..."],
  "room": "...",
  "importance": 7,
  "mood": "..."
}`;

    const userMsg = `${oldSummaryBlock}\n${livesText}`;

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
                        { role: 'user', content: userMsg },
                    ],
                    temperature: 0.5,
                    max_tokens: 8000,
                    stream: false,
                }),
            },
            2, 120_000, { appName: '记忆宫殿', purpose: '事件压缩' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        let parsed: any = extractJson(reply);
        const parseFailed = !parsed || typeof parsed !== 'object';
        const contentMissing = !parseFailed && (!parsed.content || typeof parsed.content !== 'string');

        if (parseFailed || contentMissing) {
            // 兜底：LLM 在 content 里嵌了未转义的 ASCII "（中文场景高发，破坏 JSON 解析），
            // 按已知 schema 用正则把六个字段单独抠出来——content 抠到下一个顶层键之前为止。
            const recovered = recoverCompressionFields(reply);
            if (recovered && recovered.content) {
                console.warn(`🗜️ [Compression] JSON 解析失败但字段级兜底成功（疑似 content 内含未转义 "）`);
                parsed = recovered;
            } else if (parseFailed) {
                console.warn(`🗜️ [Compression] LLM 输出无法解析为 JSON，原始前 300 字: ${reply.slice(0, 300)}`);
                return null;
            } else {
                console.warn(`🗜️ [Compression] LLM 输出缺少 content 字段，已解析键: ${Object.keys(parsed).join(',')}`);
                return null;
            }
        }
        // 长度兜底：超过硬上限时，先让模型把这段二次压缩回目标区间（不丢信息），
        // 压不动或二次压缩失败才退回硬截断保证有界。详见 enforceSummaryLengthBudget。
        let content = String(parsed.content);
        if (content.length > EVENT_BOX_SUMMARY_HARD_MAX_CHARS) {
            console.warn(`🗜️ [Compression] LLM summary ${content.length} 字超过硬上限 ${EVENT_BOX_SUMMARY_HARD_MAX_CHARS}，尝试二次压缩`);
            content = await enforceSummaryLengthBudget(
                content,
                (t) => recompressSummary(t, EVENT_BOX_SUMMARY_TARGET_MAX_CHARS, llmConfig, charName),
                EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
            );
        }
        return {
            content,
            name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : box.name,
            tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 15) : box.tags,
            room: VALID_ROOMS.includes(parsed.room) ? parsed.room : 'living_room',
            importance: Math.max(1, Math.min(10, Math.round(Number(parsed.importance) || 5))),
            mood: typeof parsed.mood === 'string' && parsed.mood.trim() ? parsed.mood.trim() : 'neutral',
        };
    } catch (err: any) {
        console.error(`🗜️ [Compression] LLM 调用失败: ${err?.message || err}`);
        return null;
    }
}

// ─── 整合回忆长度兜底：超限二次压缩，压不动才硬截断 ──────────

/**
 * 让模型把过长的整合回忆压缩回 targetMaxChars 字内（纯文本输出，不走 JSON）。
 * 失败返回 null，由 enforceSummaryLengthBudget 决定兜底。
 */
async function recompressSummary(
    text: string,
    targetMaxChars: number,
    llmConfig: LightLLMConfig,
    charName: string,
): Promise<string | null> {
    const systemPrompt = `You are ${charName}. The first-person memory below is too long. Compress it to at most ${targetMaxChars} characters without losing key people, places, events, turning points, or emotions.
Requirements: Write the result entirely in English; preserve a coherent first-person ("I") perspective; remove only filler and repeated phrasing, never facts; use curly quotation marks, corner brackets, book-title brackets, or single quotes for quotations rather than ASCII double quotes.
Output only the compressed memory text, with no explanation, JSON, or Markdown wrapper.`;
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
                        { role: 'user', content: text },
                    ],
                    temperature: 0.3,
                    max_tokens: 4000,
                    stream: false,
                }),
            },
            2, 90_000, { appName: '记忆宫殿', purpose: '事件压缩-二次压缩' }
        );
        const reply = (data.choices?.[0]?.message?.content || '').trim();
        // 模型偶尔仍会裹 ``` 代码块，剥掉常见包裹
        const cleaned = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
        return cleaned || null;
    } catch (err: any) {
        console.warn(`🗜️ [Compression] 二次压缩 LLM 调用失败: ${err?.message || err}`);
        return null;
    }
}

// ─── 单 box 压缩主流程 ──────────────────────────────────

async function compressEventBox(
    box: EventBox,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName: string | undefined,
): Promise<boolean> {
    // 1. 加载活节点（按时间升序）
    const liveNodes: MemoryNode[] = [];
    for (const id of box.liveMemoryIds) {
        const n = await MemoryNodeDB.getById(id);
        if (n && !n.archived) liveNodes.push(n);
    }
    if (liveNodes.length === 0) return false;
    liveNodes.sort((a, b) => a.createdAt - b.createdAt);

    // 2. 加载旧 summary 内容（如有）
    let oldSummaryContent: string | null = null;
    if (box.summaryNodeId) {
        const old = await MemoryNodeDB.getById(box.summaryNodeId);
        if (old) oldSummaryContent = old.content;
    }

    console.log(`🗜️ [Compression] 开始压缩 ${box.id} "${box.name}"（${liveNodes.length} 条活节点，第 ${box.compressionCount + 1} 次压缩）`);

    // 3. LLM 整合
    const result = await callCompressionLLM(box, oldSummaryContent, liveNodes, llmConfig, charName, userName);
    if (!result) {
        console.error(`🗜️ [Compression] ${box.id} "${box.name}" LLM 失败，跳过本次压缩 — 活节点 ${liveNodes.length} 条仍未归档，summary 未生成/未向量化`);
        return false;
    }

    // 4. 创建或更新 summary 节点
    const now = Date.now();
    let summaryNode: MemoryNode;
    if (box.summaryNodeId) {
        const existing = await MemoryNodeDB.getById(box.summaryNodeId);
        if (existing) {
            existing.content = result.content;
            existing.room = result.room;
            existing.importance = result.importance;
            existing.mood = result.mood;
            existing.tags = result.tags;
            existing.lastAccessedAt = now;
            existing.embedded = false;  // 重新向量化
            existing.eventBoxId = box.id;
            existing.isBoxSummary = true;
            existing.archived = false;
            existing.origin = 'system';
            summaryNode = existing;
        } else {
            // summaryNodeId 指向的节点丢失，新建
            summaryNode = createSummaryNode(box, result, now);
            box.summaryNodeId = summaryNode.id;
        }
    } else {
        summaryNode = createSummaryNode(box, result, now);
        box.summaryNodeId = summaryNode.id;
    }
    await MemoryNodeDB.save(summaryNode);

    // 5. 向量化 summary（跳过去重，因为内容必然和 live 节点重叠）
    const remoteCfg = getRemoteVectorConfig();
    try {
        await vectorizeAndStore([summaryNode], embeddingConfig, remoteCfg, { skipDedup: true });
    } catch (e: any) {
        console.warn(`🗜️ [Compression] summary 向量化失败（继续后续步骤）: ${e?.message}`);
    }

    // 6. 标记活节点 archived（本地）
    const liveIds = box.liveMemoryIds.slice();
    for (const id of liveIds) {
        const n = await MemoryNodeDB.getById(id);
        if (n && !n.archived) {
            n.archived = true;
            await MemoryNodeDB.save(n);  // syncNodeMetadataToRemote 会同步 archived=true
        }
    }
    // 远程批量加速（与上面 per-node sync 重复但幂等）
    if (remoteCfg) {
        await bulkSetArchived(remoteCfg, liveIds, true).catch(() => {});
    }

    // 7. 更新 box 状态
    for (const id of liveIds) {
        if (!box.archivedMemoryIds.includes(id)) box.archivedMemoryIds.push(id);
    }
    box.liveMemoryIds = [];
    box.compressionCount += 1;
    box.lastCompressedAt = now;
    box.updatedAt = now;
    box.name = result.name;
    box.tags = result.tags;

    // 8. 封盒检查：事件总数（archived + live）达到阈值 → sealed，新的相关记忆另开新盒
    const totalEvents = box.archivedMemoryIds.length + box.liveMemoryIds.length;
    if (totalEvents >= EVENT_BOX_SEAL_THRESHOLD && !box.sealed) {
        box.sealed = true;
        console.log(`🔒 [Compression] ${box.id} 事件数 ${totalEvents} 达阈值 ${EVENT_BOX_SEAL_THRESHOLD}，封盒`);
    }

    await EventBoxDB.save(box);

    console.log(`✅ [Compression] ${box.id} → summary ${result.content.length}字 "${result.content.slice(0, 30)}…"，已归档 ${liveIds.length} 条${box.sealed ? '，已封盒' : ''}`);

    // 9. 门牌增量合并：盒子的结论落到有门牌的房间时，顺手沉淀进该房间的门牌。
    //    封盒的沉淀物就是语义事实——这是"情景→语义"固化的即时触发点。
    try {
        const { isPlateRoom, updatePlateFromBoxSummary } = await import('./roomPlates');
        if (isPlateRoom(summaryNode.room)) {
            await updatePlateFromBoxSummary(
                box.charId, summaryNode.room, summaryNode.content,
                llmConfig, charName, userName,
            );
        }
    } catch (e: any) {
        console.warn(`🚪 [Compression] 门牌增量合并失败（不影响压缩结果）: ${e?.message || e}`);
    }

    return true;
}

function createSummaryNode(box: EventBox, result: CompressionLLMResult, now: number): MemoryNode {
    return {
        id: generateNodeId(),
        charId: box.charId,
        content: result.content,
        room: result.room,
        tags: result.tags,
        importance: result.importance,
        mood: result.mood,
        embedded: false,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        eventBoxId: box.id,
        isBoxSummary: true,
        archived: false,
        origin: 'system',
    };
}

// ─── 公共 API：扫描 + 触发压缩 ──────────────────────────

/**
 * 检查一组 box 是否达到压缩阈值，达到的逐个压缩。
 * 调用方：pipeline 处理新消息后 / migration 跑完后。
 */
export async function maybeCompressEventBoxes(
    boxIds: Iterable<string>,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
): Promise<{ compressed: number; skipped: number }> {
    let compressed = 0;
    let skipped = 0;

    for (const id of boxIds) {
        const box = await EventBoxDB.getById(id);
        if (!box) { skipped++; continue; }
        if (box.liveMemoryIds.length < EVENT_BOX_COMPRESSION_THRESHOLD) {
            skipped++;
            continue;
        }
        try {
            const ok = await compressEventBox(box, llmConfig, embeddingConfig, charName, userName);
            if (ok) compressed++;
            else skipped++;
        } catch (e: any) {
            console.error(`🗜️ [Compression] ${id} 压缩异常: ${e?.message}`);
            skipped++;
        }
    }

    if (compressed > 0) {
        console.log(`🗜️ [Compression] 本轮完成：压缩 ${compressed} 个 box，跳过 ${skipped} 个`);
    }
    return { compressed, skipped };
}

/**
 * 全角色扫一遍，触发所有满足阈值的 box 压缩（手动维护接口）。
 */
export async function compressAllEligibleBoxes(
    charId: string,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
): Promise<{ compressed: number; skipped: number }> {
    const allBoxes = await EventBoxDB.getByCharId(charId);
    const eligible = allBoxes.filter(b => b.liveMemoryIds.length >= EVENT_BOX_COMPRESSION_THRESHOLD);
    return maybeCompressEventBoxes(eligible.map(b => b.id), llmConfig, embeddingConfig, charName, userName);
}
