// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import InnerVoiceBubble from '../components/chat/InnerVoiceBubble';
import { readFileSync } from 'node:fs';

it('心声修改会使消息缓存失效，保存通过 metadata 更新而非改写正文', () => {
    const messageItem = readFileSync('components/chat/MessageItem.tsx', 'utf8');
    expect(messageItem).toContain('prev.msg.metadata?.innerVoice === next.msg.metadata?.innerVoice');
    const chat = readFileSync('apps/Chat.tsx', 'utf8');
    expect(chat).toContain('DB.updateMessageMetadata(id, prev => ({ ...(prev || {}), innerVoice: voice }))');
});

it('心声有独立编辑入口，保存只提交心声，点击不会触发外层消息操作', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onMessageClick = vi.fn();
    try {
        await act(async () => root.render(React.createElement('div', { onClick: onMessageClick },
            React.createElement(InnerVoiceBubble, { voice: '原来的心声', onSave }),
            React.createElement('p', {}, '第一条正文'))));
        await act(async () => container.querySelector('button')!.click());
        expect(onMessageClick).not.toHaveBeenCalled();
        const textarea = document.querySelector('textarea')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '新的心声');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const save = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '保存')!;
        await act(async () => save.click());
        expect(onSave).toHaveBeenCalledWith('新的心声');
        expect(container.textContent).toContain('第一条正文');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(onMessageClick).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); container.remove(); }
});

it('取消编辑不保存，保存失败保留编辑器以便重试', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSave = vi.fn().mockRejectedValue(new Error('storage failure'));
    try {
        await act(async () => root.render(React.createElement(InnerVoiceBubble, { voice: '原来的心声', onSave })));
        await act(async () => container.querySelector('button')!.click());
        await act(async () => Array.from(document.querySelectorAll('button')).find(b => b.textContent === '取消')!.click());
        expect(onSave).not.toHaveBeenCalled();
        await act(async () => container.querySelector('button')!.click());
        await act(async () => Array.from(document.querySelectorAll('button')).find(b => b.textContent === '保存')!.click());
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('保存失败');
        expect(document.querySelector('textarea')?.value).toBe('原来的心声');
    } finally { await act(async () => root.unmount()); }
});
