import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBox, MemoryNode, ScoredMemory } from './types';
import { MemoryNodeDB, EventBoxDB } from './db';
import { strengthenCoActivated } from './links';
import { expandAndFormat } from './formatter';
import { reinforceFormattedMemories } from './reinforcement';

vi.mock('./db', () => ({
    MemoryNodeDB: { getByCharId: vi.fn(), getById: vi.fn(), touchAccess: vi.fn() },
    EventBoxDB: { getById: vi.fn() },
}));
vi.mock('./links', () => ({ strengthenCoActivated: vi.fn() }));

function node(id: string, extra: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id, charId: 'char', content: `memory-${id}`, room: 'living_room',
        importance: 5, mood: 'neutral', tags: [], embedded: true,
        createdAt: 1, lastAccessedAt: 1, accessCount: 0, ...extra,
    };
}
function hit(n: MemoryNode, score = 1): ScoredMemory {
    return { node: n, finalScore: score, similarity: score, roomScore: score, bm25Score: 0 };
}
async function renderAndReinforce(hits: ScoredMemory[], directIds: string[], cap = 15) {
    let ids: string[] = [];
    const text = await expandAndFormat(hits, 'char', [], undefined, cap, output => { ids = output; });
    if (text) await reinforceFormattedMemories(new Set(directIds), ids);
    return text;
}
function touched() {
    return vi.mocked(MemoryNodeDB.touchAccess).mock.calls.map(([id]) => id);
}

describe('reinforcement follows final output and direct hits', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        localStorage.clear();
        vi.mocked(MemoryNodeDB.getByCharId).mockResolvedValue([]);
        vi.mocked(MemoryNodeDB.touchAccess).mockResolvedValue(undefined);
        vi.mocked(strengthenCoActivated).mockResolvedValue(undefined);
    });

    it('does not strengthen cut or archived candidates; explicit entity recall keeps its guarantee', async () => {
        const exact = { ...hit(node('exact'), 0.1), recallGuarantee: 'explicit_entity' as const };
        const text = await renderAndReinforce([
            hit(node('cut'), 1), exact, hit(node('archived', { archived: true }), 2),
        ], ['cut', 'exact', 'archived'], 1);
        expect(text).toContain('memory-exact');
        expect(text).not.toContain('memory-cut');
        expect(touched()).toEqual(['exact']);
        expect(strengthenCoActivated).not.toHaveBeenCalled();
    });

    it('excludes incidental box siblings and directly hit nodes omitted by the per-box limit', async () => {
        const live = Array.from({ length: 9 }, (_, i) => node(`live${i}`, { eventBoxId: 'box', createdAt: i + 1 }));
        const summary = node('summary', { eventBoxId: 'box' });
        vi.mocked(MemoryNodeDB.getByCharId).mockResolvedValue([...live, summary]);
        vi.mocked(EventBoxDB.getById).mockResolvedValue({
            id: 'box', charId: 'char', name: 'test box', tags: [], summaryNodeId: summary.id,
            liveMemoryIds: live.map(n => n.id), archivedMemoryIds: [], compressionCount: 1,
            createdAt: 1, updatedAt: 1, lastCompressedAt: 1,
        } satisfies EventBox);
        const text = await renderAndReinforce([hit(live[0]), hit(live[8])], ['live0', 'live8']);
        expect(text).toContain('memory-summary');
        expect(text).toContain('memory-live1');
        expect(text).not.toContain('memory-live8');
        expect(touched()).toEqual(['live0']);
    });

    it('counts rerank/direct pinned hits once but excludes passive pinned, spreading and rumination output', async () => {
        const pinned = node('pinned', { pinnedUntil: Date.now() + 100000 });
        const passive = node('passive', { pinnedUntil: Date.now() + 100000 });
        vi.mocked(MemoryNodeDB.getByCharId).mockResolvedValue([pinned, passive]);
        const text = await renderAndReinforce([
            hit(node('rerank')), hit(node('spread')), hit(node('rumination')), hit(pinned), hit(pinned),
        ], ['rerank', 'pinned']);
        expect(text).toContain('memory-spread');
        expect(text).toContain('memory-passive');
        expect(touched()).toEqual(['rerank', 'pinned']);
        expect(strengthenCoActivated).toHaveBeenCalledTimes(1);
        expect(strengthenCoActivated).toHaveBeenCalledWith(['rerank', 'pinned']);
    });

    it('does not reinforce an empty output', async () => {
        expect(await renderAndReinforce([], ['old-receipt'])).toBe('');
        expect(touched()).toEqual([]);
        expect(strengthenCoActivated).not.toHaveBeenCalled();
    });

    it('keeps output usable when reinforcement writes fail', async () => {
        vi.mocked(MemoryNodeDB.touchAccess).mockRejectedValue(new Error('write failed'));
        vi.mocked(strengthenCoActivated).mockRejectedValue(new Error('link failed'));
        const text = await renderAndReinforce([hit(node('a')), hit(node('b'))], ['a', 'b']);
        expect(text).toContain('memory-a');
        expect(text).toContain('memory-b');
    });
});
