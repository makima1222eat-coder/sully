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

it('三个选项出现在聊天区，选择后只保留所选组，依次发送多条且双击不重复提交', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(generateReplySuggestions).mockResolvedValue([['好的'], ['具体怎么想的？', '我想听听你的看法'], ['聊聊音乐吧']]);
    const container = document.createElement('div');
    const root = createRoot(container);
    const target = document.createElement('div');
    let finish!: () => void;
    const onSend = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
        await act(async () => root.render(React.createElement(ReplySuggestions, {
            config: {} as APIConfig, user: { name: '我', bio: '内向', avatar: '' }, characters: [],
            loadHistory: async () => [], onSend, optionsTarget: target,
        })));
        await act(async () => container.querySelector('button')!.click());
        expect(onSend).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain('深度交流');
        expect(target.querySelectorAll('button')).toHaveLength(3);
        const choice = Array.from(target.querySelectorAll('button')).find(button => button.textContent?.includes('具体怎么想的'))!;
        await act(async () => { choice.click(); choice.click(); });
        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onSend).toHaveBeenCalledWith('具体怎么想的？', 0);
        expect(target.querySelectorAll('button')).toHaveLength(1);
        expect(target.textContent).not.toContain('聊聊音乐吧');
        await act(async () => finish());
        expect(onSend).toHaveBeenNthCalledWith(2, '我想听听你的看法', 1);
        await act(async () => finish());
        expect(target.textContent).toBe('');
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
    expect(source).toContain("handleSendText(text, 'text', undefined, true, bubbleIndex > 0)");
    expect(source).toContain("if (!suppressAutoReply && type === 'text'");
});

it('部分发送失败重试时不会重复已发送的消息', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(generateReplySuggestions).mockResolvedValue([['第一条', '第二条'], ['其他'], ['换话题']]);
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSend = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('failed')).mockResolvedValue(undefined);
    try {
        await act(async () => root.render(React.createElement(ReplySuggestions, {
            config: {} as APIConfig, user: { name: '我', bio: '', avatar: '' }, characters: [], loadHistory: async () => [], onSend,
        })));
        await act(async () => container.querySelector('button')!.click());
        await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('第一条'))!.click());
        expect(container.textContent).toContain('重试剩余消息');
        expect(container.textContent).not.toContain('换话题');
        await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('第二条'))!.click());
        expect(onSend.mock.calls).toEqual([['第一条', 0], ['第二条', 1], ['第二条', 1]]);
    } finally { await act(async () => root.unmount()); }
});

it('逐条落库引起聊天刷新时继续发送，外部新消息到达时丢弃未选选项', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(generateReplySuggestions).mockResolvedValue([['第一条', '第二条'], ['深入聊聊'], ['换话题']]);
    const container = document.createElement('div');
    const root = createRoot(container);
    let finish!: () => void;
    const onSend = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const render = (historyRevision: number) => root.render(React.createElement(ReplySuggestions, {
        config: {} as APIConfig, user: { name: '我', bio: '', avatar: '' }, characters: [], loadHistory: async () => [], onSend, historyRevision,
    }));
    try {
        await act(async () => render(1));
        await act(async () => container.querySelector('button')!.click());
        await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('第一条'))!.click());
        await act(async () => { render(2); });
        await act(async () => finish());
        expect(onSend).toHaveBeenNthCalledWith(2, '第二条', 1);
        await act(async () => { render(3); });
        await act(async () => finish());
        await act(async () => container.querySelector('button')!.click());
        expect(container.textContent).toContain('深入聊聊');
        await act(async () => render(4));
        expect(container.textContent).not.toContain('深入聊聊');
    } finally { await act(async () => root.unmount()); }
});
