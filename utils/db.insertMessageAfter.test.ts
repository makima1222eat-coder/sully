import { describe, it, expect } from 'vitest';
import { DB } from './db';

// 「消息操作 → 插入消息」的排序不变式：消息顺序由主键决定，插中间靠
// afterId 与全库下一个主键之间的浮点中点。三个关键场景：
//  1. 插在两条消息中间 → 读取顺序正确；
//  2. 两条同会话消息之间夹着别的会话的整数 id → 不撞键、顺序仍正确；
//  3. afterId 是全库最后一条 → 走自增追加。
describe('insertMessageAfter 排序不变式', () => {
    it('插在两条消息中间，默认读取顺序为 A → 插入 → B', async () => {
        const idA = await DB.saveMessage({ charId: 'ins-mid', role: 'user', type: 'text', content: 'A' } as any);
        await DB.saveMessage({ charId: 'ins-mid', role: 'assistant', type: 'text', content: 'B' } as any);

        const inserted = await DB.insertMessageAfter(idA, { charId: 'ins-mid', role: 'assistant', type: 'text', content: 'X' } as any);
        expect(inserted.id).toBeGreaterThan(idA);

        const msgs = await DB.getRecentMessagesByCharId('ins-mid', 10);
        expect(msgs.map(m => m.content)).toEqual(['A', 'X', 'B']);
    });

    it('同会话相邻消息之间夹着别的会话的 id 时不撞键，顺序仍正确', async () => {
        const idA = await DB.saveMessage({ charId: 'ins-gap', role: 'user', type: 'text', content: 'A' } as any);
        // 别的会话占掉紧邻的整数 id——插入 ins-gap 会话时中点必须避开它
        await DB.saveMessage({ charId: 'ins-other', role: 'user', type: 'text', content: 'other-1' } as any);
        await DB.saveMessage({ charId: 'ins-other', role: 'user', type: 'text', content: 'other-2' } as any);
        await DB.saveMessage({ charId: 'ins-gap', role: 'assistant', type: 'text', content: 'B' } as any);

        await DB.insertMessageAfter(idA, { charId: 'ins-gap', role: 'user', type: 'text', content: 'X' } as any);

        const msgs = await DB.getRecentMessagesByCharId('ins-gap', 10);
        expect(msgs.map(m => m.content)).toEqual(['A', 'X', 'B']);
        // 别的会话不受影响
        const others = await DB.getRecentMessagesByCharId('ins-other', 10);
        expect(others.map(m => m.content)).toEqual(['other-1', 'other-2']);
    });

    it('afterId 是全库最后一条时走自增追加', async () => {
        const idA = await DB.saveMessage({ charId: 'ins-tail', role: 'user', type: 'text', content: 'A' } as any);
        const inserted = await DB.insertMessageAfter(idA, { charId: 'ins-tail', role: 'assistant', type: 'text', content: 'X' } as any);
        expect(Number.isInteger(inserted.id)).toBe(true);
        expect(inserted.id).toBeGreaterThan(idA);

        const msgs = await DB.getRecentMessagesByCharId('ins-tail', 10);
        expect(msgs.map(m => m.content)).toEqual(['A', 'X']);
    });

    it('反复往同一条消息后插入，每条都紧贴锚点、旧插入依次后移', async () => {
        const idA = await DB.saveMessage({ charId: 'ins-rep', role: 'user', type: 'text', content: 'A' } as any);
        await DB.saveMessage({ charId: 'ins-rep', role: 'assistant', type: 'text', content: 'B' } as any);

        await DB.insertMessageAfter(idA, { charId: 'ins-rep', role: 'user', type: 'text', content: 'X1' } as any);
        await DB.insertMessageAfter(idA, { charId: 'ins-rep', role: 'user', type: 'text', content: 'X2' } as any);

        const msgs = await DB.getRecentMessagesByCharId('ins-rep', 10);
        expect(msgs.map(m => m.content)).toEqual(['A', 'X2', 'X1', 'B']);
    });

    it('浮点 id 消息能被正常编辑和删除（主键完整往返）', async () => {
        const idA = await DB.saveMessage({ charId: 'ins-crud', role: 'user', type: 'text', content: 'A' } as any);
        await DB.saveMessage({ charId: 'ins-crud', role: 'assistant', type: 'text', content: 'B' } as any);
        const inserted = await DB.insertMessageAfter(idA, { charId: 'ins-crud', role: 'user', type: 'text', content: 'X' } as any);
        expect(Number.isInteger(inserted.id)).toBe(false);

        await DB.updateMessage(inserted.id, 'X-edited');
        let msgs = await DB.getRecentMessagesByCharId('ins-crud', 10);
        expect(msgs.map(m => m.content)).toEqual(['A', 'X-edited', 'B']);

        await DB.deleteMessage(inserted.id);
        msgs = await DB.getRecentMessagesByCharId('ins-crud', 10);
        expect(msgs.map(m => m.content)).toEqual(['A', 'B']);
    });
});
