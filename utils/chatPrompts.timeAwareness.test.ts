import { describe, expect, it } from 'vitest';

import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const userProfile = { name: '测试用户' } as any;
const timestamp = new Date(2026, 7, 9, 21, 37, 0).getTime();
const formattedTimestamp = ChatPrompts.formatDate(timestamp);

const messages = [
    {
        id: 1,
        charId: 'char-time-test',
        role: 'assistant',
        type: 'text',
        content: '上一条消息',
        timestamp: timestamp - 2 * 60 * 60_000,
    },
    {
        id: 2,
        charId: 'char-time-test',
        role: 'user',
        type: 'text',
        content: '现在聊点别的',
        timestamp,
    },
] as any[];

const build = (timeAwarenessEnabled?: boolean) => ChatPrompts.buildMessageHistory(
    messages,
    20,
    { id: 'char-time-test', name: '测试角色', timeAwarenessEnabled } as any,
    userProfile,
    [],
).apiMessages;

describe('聊天时间感知总闸', () => {
    it('默认开启时，历史消息带精确到分钟的时间戳和聊天间隔', () => {
        const apiMessages = build();
        expect(apiMessages[1].content).toContain(`[${formattedTimestamp}]`);
        expect(apiMessages[1].content).toContain('hours since the last message');
    });

    it('显式关闭时，历史消息不含系统时间戳或聊天间隔', () => {
        const apiMessages = build(false);
        const joined = apiMessages.map(message => String(message.content)).join('\n');

        expect(joined).not.toContain(formattedTimestamp);
        expect(joined).not.toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
        expect(joined).not.toContain('since the last message');
        expect(apiMessages[1].content).toBe('[Chat] 现在聊点别的');
    });

    it('显式关闭时，图片等特殊消息同样不携带时间戳', () => {
        const imageMessages = ChatPrompts.buildMessageHistory(
            [{
                id: 3,
                charId: 'char-time-test',
                role: 'user',
                type: 'image',
                content: 'https://example.com/test.png',
                timestamp,
            }] as any[],
            20,
            { id: 'char-time-test', name: '测试角色', timeAwarenessEnabled: false } as any,
            userProfile,
            [],
        ).apiMessages;

        const textPart = imageMessages[0].content[0].text;
        expect(textPart).toBe('[User sent an image]');
        expect(textPart).not.toContain(formattedTimestamp);
    });

    it('显式关闭时，注入私聊的群聊背景同样不携带绝对或相对时间', async () => {
        const groupId = 'group-time-awareness-off';
        await DB.saveMessage({
            charId: 'user',
            groupId,
            role: 'user',
            type: 'text',
            content: '群聊里的原始内容',
            timestamp,
        } as any);

        const parts = await ChatPrompts.buildSystemPromptParts(
            { id: 'char-time-test', name: '测试角色', timeAwarenessEnabled: false } as any,
            userProfile,
            [{ id: groupId, name: '测试群', members: ['char-time-test'] }] as any,
            [],
            [],
            [],
        );

        expect(parts.volatileState).toContain('[Group: 测试群] 测试用户: 群聊里的原始内容');
        expect(parts.volatileState).not.toContain(formattedTimestamp);
        expect(parts.volatileState).not.toMatch(/约\s*\d+\s*(?:分钟|小时|天)前/);
    });
});
