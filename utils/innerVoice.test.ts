import { describe, it, expect } from 'vitest';

import { extractInnerVoice } from './applyAssistantPostProcessing';
import { buildInnerVoicePrompt } from './innerVoicePrompt';
import { buildChatRequestPayload } from './chatRequestPayload';
import type { BuildChatPayloadInput } from './chatRequestPayload';
import { sanitizeForNotification } from './sanitize';
import { computeStreamPreviewBubbles } from './streamPreview';

// 【心声】三条硬约束的回归守卫：
//  1. 开关（innerVoiceEnabled）决定教学块进不进 system prompt；
//  2. 回复开头的 [心声] 行永远不变成聊天气泡（抽 metadata / 关着也剥掉）；
//  3. 心声只活在 metadata —— 通知横幅、流式预览这些终态输出一律不带。
// （不进下一轮 / 不给总结模型：心声不写进 content，buildMessageHistory 及所有
//  读 content 的下游天然看不到，无需单测。）

describe('extractInnerVoice', () => {
    it('抽出行首 [心声] 行，正文剥干净', () => {
        const r = extractInnerVoice('[心声] 又来了，好烦。\n今天天气不错~\n出去走走？');
        expect(r.voice).toBe('又来了，好烦。');
        expect(r.rest).toBe('今天天气不错~\n出去走走？');
    });

    it('全角括号【心声】与冒号变体也认', () => {
        expect(extractInnerVoice('【心声】哼。\n没什么').voice).toBe('哼。');
        expect(extractInnerVoice('[心声]: fine, whatever\nok').voice).toBe('fine, whatever');
    });

    it('模型多写了几行心声：全部收拢进 voice，不漏进气泡', () => {
        const r = extractInnerVoice('[心声] 第一句\n[心声] 第二句\n正文');
        expect(r.voice).toBe('第一句\n第二句');
        expect(r.rest).toBe('正文');
    });

    it('没有心声行时原样返回', () => {
        const r = extractInnerVoice('普通回复\n第二行');
        expect(r.voice).toBeNull();
        expect(r.rest).toBe('普通回复\n第二行');
    });

    it('正文中间漏出的 [心声] 行同样被剥掉', () => {
        const r = extractInnerVoice('先说一句\n[心声] 中途嘀咕\n再说一句');
        expect(r.voice).toBe('中途嘀咕');
        expect(r.rest).toBe('先说一句\n\n再说一句');
    });
});

describe('终态输出不带心声', () => {
    it('通知横幅（sanitizeForNotification）剥掉 [心声] 行', () => {
        expect(sanitizeForNotification('[心声] 内心戏\n晚安啦')).not.toContain('内心戏');
        expect(sanitizeForNotification('[心声] 内心戏\n晚安啦')).toContain('晚安啦');
    });

    it('流式预览不展示 [心声] 行', () => {
        const bubbles = computeStreamPreviewBubbles('[心声] 别让ta看到\n今天吃了火锅\n');
        expect(bubbles.join('\n')).not.toContain('别让ta看到');
        expect(bubbles.join('\n')).toContain('今天吃了火锅');
    });
});

describe('提示词注入开关', () => {
    const baseInput = (): BuildChatPayloadInput => ({
        char: { id: 'char-iv', name: '阿一' } as any,
        userProfile: { name: '小明' } as any,
        groups: [],
        emojis: [],
        categories: [],
        historyMsgs: [
            { id: 1, charId: 'char-iv', role: 'user', type: 'text', content: '在吗', timestamp: Date.now() },
        ] as any[],
        contextLimit: 20,
    });

    it('buildInnerVoicePrompt 教学块包含标签与"恰好一条"约束', () => {
        const p = buildInnerVoicePrompt('阿一');
        expect(p).toContain('[心声]');
        expect(p).toContain('exactly one');
    });

    it('开着注入、关着不注入', async () => {
        const on = await buildChatRequestPayload({ ...baseInput(), innerVoice: { enabled: true } });
        expect(on.systemPrompt).toContain('【心声】 Inner Voice');

        const off = await buildChatRequestPayload(baseInput());
        expect(off.systemPrompt).not.toContain('【心声】 Inner Voice');
    });
});
