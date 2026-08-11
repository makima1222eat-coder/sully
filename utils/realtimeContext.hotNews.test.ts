import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOTNEWS_API_BASE_URL, RealtimeContextManager } from './realtimeContext';

function jsonResponse(body: unknown, ok = true, status = 200) {
    return {
        ok,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(body),
    } as any;
}

beforeEach(() => {
    RealtimeContextManager.clearCache();
    vi.restoreAllMocks();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('RealtimeContextManager.fetchHotNews', () => {
    it('uses the migrated news.orz.ai API and supports desc/content summaries', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            status: '200',
            data: [
                { title: 'First headline', url: 'https://example.com/1', desc: '  Upstream summary  ' },
                { title: 'Second headline', url: 'https://example.com/2', content: 'Upstream content' },
                { title: 'Third headline', url: 'https://example.com/3', content: 'Third headline' },
            ],
            msg: 'success',
        })));

        const items = await RealtimeContextManager.fetchHotNews(['weibo']);

        expect(fetch).toHaveBeenCalledOnce();
        const requestedUrl = vi.mocked(fetch).mock.calls[0][0] as string;
        expect(requestedUrl).toBe(`${HOTNEWS_API_BASE_URL}/?platform=weibo`);
        expect(requestedUrl).not.toContain('https://orz.ai/');
        expect(items).toEqual([
            { title: 'First headline', source: RealtimeContextManager.HOTNEWS_PLATFORM_LABELS.weibo, url: 'https://example.com/1', desc: 'Upstream summary' },
            { title: 'Second headline', source: RealtimeContextManager.HOTNEWS_PLATFORM_LABELS.weibo, url: 'https://example.com/2', desc: 'Upstream content' },
            { title: 'Third headline', source: RealtimeContextManager.HOTNEWS_PLATFORM_LABELS.weibo, url: 'https://example.com/3', desc: undefined },
        ]);
    });

    it('returns an empty list on upstream HTTP errors so existing fallbacks can run', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 503)));

        await expect(RealtimeContextManager.fetchHotNews(['weibo'])).resolves.toEqual([]);
    });
});

describe('RealtimeContextManager 区域新闻', () => {
    it('英国模式向 Brave 传 GB + 最近 24 小时，并保留摘要', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            results: [{
                title: 'UK headline',
                description: '  A useful summary.  ',
                url: 'https://www.bbc.co.uk/news/example',
                meta_url: { netloc: 'bbc.co.uk' },
            }],
        })));

        const items = await RealtimeContextManager.fetchBraveNews('brave-key', 'GB', 'en', 20);

        const [rawUrl, init] = vi.mocked(fetch).mock.calls[0];
        const url = new URL(rawUrl as string);
        expect(url.pathname).toBe('/news');
        expect(url.searchParams.get('q')).toBe('UK top news');
        expect(url.searchParams.get('country')).toBe('GB');
        expect(url.searchParams.get('freshness')).toBe('pd');
        expect(url.searchParams.get('search_lang')).toBe('en');
        expect((init?.headers as Record<string, string>)['X-Brave-API-Key']).toBe('brave-key');
        expect(items).toEqual([{
            title: 'UK headline', source: 'bbc.co.uk', url: 'https://www.bbc.co.uk/news/example', desc: 'A useful summary.',
        }]);
    });

    it('按新闻地区时区分段，并用地区后缀隔离快照', () => {
        const at = new Date('2026-08-11T23:30:00Z');
        expect(RealtimeContextManager.getNewsSlot({ newsRegion: 'GB' }, at)).toMatchObject({
            id: '2026-08-12#0#GB', date: '2026-08-12', slot: 0,
        });
        expect(RealtimeContextManager.getNewsSlot({ newsRegion: 'ALL' }, at)).toMatchObject({
            id: '2026-08-11#5#ALL', date: '2026-08-11', slot: 5,
        });
        expect(RealtimeContextManager.getNewsPlatforms({ newsRegion: 'GB' })).toEqual(['brave:GB']);
        expect(RealtimeContextManager.getNewsPlatforms({ newsRegion: 'ALL' })).toEqual(['brave:ALL']);
    });
});
