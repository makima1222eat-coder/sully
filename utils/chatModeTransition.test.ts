import { describe, expect, it } from 'vitest';

import type { Message } from '../types';
import { buildChatRequestPayload } from './chatRequestPayload';
import { detectChatModeTransition } from './chatPrompts';

const message = (
    id: number,
    role: Message['role'],
    source?: string,
    metadata: Record<string, unknown> = {},
): Message => ({
    id,
    charId: 'char-return',
    role,
    type: role === 'system' ? 'system' : 'text',
    content: `message-${id}`,
    timestamp: id,
    metadata: source ? { source, ...metadata } : metadata,
} as Message);

describe('detectChatModeTransition', () => {
    it.each([
        ['call', message(2, 'assistant', 'call'), 'call'],
        ['video', message(2, 'assistant', 'call', { callMode: 'video' }), 'video'],
        ['date', message(2, 'assistant', 'date'), 'date'],
        ['story', message(2, 'assistant', 'story_theater_memory'), 'story'],
    ] as const)('识别从 %s 回到 ChatApp 的第一轮', (_label, modeMessage, expected) => {
        expect(detectChatModeTransition([
            message(1, 'assistant'),
            modeMessage,
            message(3, 'user'),
        ])).toBe(expected);
    });

    it('用户连续发送多个气泡时仍能越过它们找到刚结束的模式', () => {
        expect(detectChatModeTransition([
            message(1, 'assistant'),
            message(2, 'assistant', 'date'),
            message(3, 'system'),
            message(4, 'user'),
            message(5, 'user'),
        ])).toBe('date');
    });

    it('已经产生普通 ChatApp assistant 回复后不再重复提醒', () => {
        expect(detectChatModeTransition([
            message(1, 'assistant', 'story_theater_memory'),
            message(2, 'user'),
            message(3, 'assistant'),
            message(4, 'user'),
        ])).toBeNull();
    });

    it('特殊模式之后还没有新的 ChatApp 用户输入时不误报', () => {
        expect(detectChatModeTransition([
            message(1, 'assistant'),
            message(2, 'assistant', 'call'),
            message(3, 'system', 'call-end-popup'),
        ])).toBeNull();
    });
});

describe('buildChatRequestPayload 模式切换接线', () => {
    it('即使 recentMsgsHint 已过滤通话记录，也按完整 API 历史注入视频转文字提醒', async () => {
        const historyMsgs = [
            message(1, 'assistant'),
            message(2, 'assistant', 'call', { callMode: 'video' }),
            message(3, 'system', 'call-end-popup', { callMode: 'video' }),
            message(4, 'user'),
        ];
        const payload = await buildChatRequestPayload({
            char: {
                id: 'char-return',
                name: '阿一',
                timeAwarenessEnabled: false,
                scheduleFeatureEnabled: false,
            } as any,
            userProfile: { name: '小明' } as any,
            groups: [],
            emojis: [],
            categories: [],
            historyMsgs,
            // 模拟 Chat.tsx 的可见消息：call / call-end-popup 均不在这份 React state 中。
            recentMsgsHint: [message(1, 'assistant'), message(4, 'user')],
            contextLimit: 20,
            realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        });

        const joined = payload.fullMessages.map(item => String(item.content || '')).join('\n');
        expect(joined).toContain('System | Mode switch (highest priority)');
        expect(joined).toContain('You just ended a video call');
        expect(joined).toContain('now back in the ChatApp text-chat interface');
        expect(joined).toContain('If ChatApp currently has voice messages enabled, you may still follow their own voice-message format');
    });
});
