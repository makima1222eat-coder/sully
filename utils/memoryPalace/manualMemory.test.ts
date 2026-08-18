import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryNodeDB, MemoryVectorDB } from './db';
import type { EmbeddingConfig, MemoryNode } from './types';
import { createManualMemoryNode } from './vectorStore';

const originalFetch = global.fetch;
const embeddingConfig: EmbeddingConfig = {
    baseUrl: 'https://embedding.test/v1',
    apiKey: 'test-key',
    model: 'test-embedding',
    dimensions: 3,
};

const CHAR_ID = 'manual_memory_char';

const draft = () => ({
    content: '  她今天把那盆快枯掉的绿萝救回来了  ',
    room: 'user_room' as const,
    importance: 7,
    mood: 'tender',
    tags: ['绿萝', '', '养花'],
});

beforeEach(async () => {
    global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
    })) as any;

    for (const n of await MemoryNodeDB.getByCharId(CHAR_ID)) {
        await MemoryNodeDB.delete(n.id);
    }
});

afterAll(() => {
    global.fetch = originalFetch;
});

describe('手动新建单条记忆', () => {
    it('落库时正文去空白、标签去空项，并写入同 id 的向量', async () => {
        const node = await createManualMemoryNode(CHAR_ID, draft(), embeddingConfig);

        const stored = await MemoryNodeDB.getById(node.id);
        const vector = await MemoryVectorDB.getByMemoryId(node.id);

        expect(stored?.content).toBe('她今天把那盆快枯掉的绿萝救回来了');
        expect(stored?.tags).toEqual(['绿萝', '养花']);
        expect(stored?.room).toBe('user_room');
        expect(stored?.importance).toBe(7);
        expect(stored?.embedded).toBe(true);
        // 手动写的记忆不是提取/消化来的，来源要标出来，免得被当成管线产物再消化一遍
        expect(stored?.origin).toBe('system');
        expect(vector?.memoryId).toBe(node.id);
        expect(node.embedded).toBe(true);
    });

    it('补录旧事时 createdAt 听用户的，lastAccessedAt 跟着走', async () => {
        const backdated = new Date(2025, 11, 24, 12, 0, 0).getTime();
        const node = await createManualMemoryNode(
            CHAR_ID, { ...draft(), createdAt: backdated }, embeddingConfig,
        );

        const stored = await MemoryNodeDB.getById(node.id);
        expect(stored?.createdAt).toBe(backdated);
        expect(stored?.lastAccessedAt).toBe(backdated);
    });

    // 用户自己写下的这条就是要它进去。走语义去重的话，和已有记忆撞了会被静默跳过，
    // 界面上却是"保存成功"——变成一条查无此人的记忆。
    it('内容和已有记忆几乎一样也照存不误', async () => {
        const first = await createManualMemoryNode(CHAR_ID, draft(), embeddingConfig);
        const second = await createManualMemoryNode(CHAR_ID, draft(), embeddingConfig);

        expect(second.id).not.toBe(first.id);
        const all = await MemoryNodeDB.getByCharId(CHAR_ID);
        expect(all.filter((n: MemoryNode) => n.content.includes('绿萝'))).toHaveLength(2);
    });

    it('空正文和缺 Embedding 配置都在调 API 之前就拦下来', async () => {
        await expect(
            createManualMemoryNode(CHAR_ID, { ...draft(), content: '   ' }, embeddingConfig),
        ).rejects.toThrow('记忆内容不能为空');

        await expect(
            createManualMemoryNode(CHAR_ID, draft(), { ...embeddingConfig, apiKey: '' }),
        ).rejects.toThrow('请先配置 Embedding API');

        expect(fetch).not.toHaveBeenCalled();
    });

    it('重要性超出 1-10 会被夹回范围，情绪留空退回 neutral', async () => {
        const high = await createManualMemoryNode(
            CHAR_ID, { ...draft(), importance: 99, mood: '  ' }, embeddingConfig,
        );
        const low = await createManualMemoryNode(
            CHAR_ID, { ...draft(), importance: -3 }, embeddingConfig,
        );

        expect(high.importance).toBe(10);
        expect(high.mood).toBe('neutral');
        expect(low.importance).toBe(1);
    });
});
