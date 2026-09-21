// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ReplySuggestions from '../components/chat/ReplySuggestions';
import { generateReplySuggestions } from './replySuggestions';
import type { APIConfig } from '../types';
import { readFileSync } from 'node:fs';

vi.mock('./replySuggestions', () => ({
    REPLY_LABELS: ['正常回复', '深度交流', '转移话题'],
    generateReplySuggestions: vi.fn(),
}));

it('生成不会发送；选择仅发送该条，双击不重复提交', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(generateReplySuggestions).mockResolvedValue(['好的', '具体怎么想的？', '聊聊音乐吧']);
    const container = document.createElement('div');
    const root = createRoot(container);
    let finish!: () => void;
    const onSend = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
        await act(async () => root.render(React.createElement(ReplySuggestions, {
            config: {} as APIConfig, user: { name: '我', bio: '内向', avatar: '' }, characters: [],
            loadHistory: async () => [], onSend,
        })));
        await act(async () => container.querySelector('button')!.click());
        expect(onSend).not.toHaveBeenCalled();
        expect(container.textContent).toContain('深度交流');
        const choice = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('具体怎么想的'))!;
        await act(async () => { choice.click(); choice.click(); });
        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onSend).toHaveBeenCalledWith('具体怎么想的？');
        await act(async () => finish());
        expect(container.textContent).not.toContain('具体怎么想的？');
    } finally { await act(async () => root.unmount()); }
});

it('切换聊天卸载组件时取消未完成的生成请求', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const mounted = createRoot(container);
    vi.mocked(generateReplySuggestions).mockImplementation(() => new Promise(() => {}));
    await act(async () => mounted.render(React.createElement(ReplySuggestions, {
        config: {} as APIConfig, user: { name: '我', bio: '', avatar: '' }, characters: [],
        loadHistory: async () => [], onSend: vi.fn(),
    })));
    await act(async () => container.querySelector('button')!.click());
    const signal = vi.mocked(generateReplySuggestions).mock.calls.at(-1)![5]!;
    await act(async () => mounted.unmount());
    expect(signal.aborted).toBe(true);
});

it('单聊选项发送显式绕过即时自动回复开关', () => {
    const source = readFileSync('apps/Chat.tsx', 'utf8');
    expect(source).toContain("handleSendText(text, 'text', undefined, true)");
    expect(source).toContain("if (!suppressAutoReply && type === 'text'");
});
