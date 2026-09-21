import { describe, expect, it, vi } from 'vitest';
import { buildReplySuggestionMessages, generateReplySuggestions, parseReplySuggestions } from './replySuggestions';
import { safeFetchJson } from './safeApi';
import type { APIConfig, CharacterProfile, Message } from '../types';

vi.mock('./safeApi', () => ({ safeFetchJson: vi.fn(), extractContent: (data: any) => data.choices[0].message.content }));
const user = { name: '小林', bio: '内向，喜欢简短表达和音乐', avatar: '' };
const replies = ['听起来不错', '你当时是怎么想的？', '对了，最近听到一首歌'];
const config = { baseUrl: 'https://main.test/v1', apiKey: 'main', model: 'main-model' } as APIConfig;

describe('用户备选回复', () => {
    it('保留用户性格与群成员身份，媒体不会作为原始内容发送', () => {
        const messages = buildReplySuggestionMessages(user, [{ id: 'a', name: '小夏', description: '朋友' } as CharacterProfile], [
            { role: 'assistant', charId: 'a', type: 'text', content: '今天听什么？' },
            { role: 'user', charId: 'user', type: 'image', content: 'data:image/png;base64,SECRET' },
        ] as Message[], '音乐群');
        const context = JSON.parse(messages[1].content);
        expect(context.user.personality).toBe(user.bio);
        expect(context.history[0].speaker).toBe('小夏');
        expect(context.history[1].speaker).toBe('小林');
        expect(messages[1].content).not.toContain('SECRET');
        expect(context.conversation.type).toBe('群聊');
    });
    it('严格要求三个不同的纯文本回复', () => {
        expect(parseReplySuggestions('```json\n' + JSON.stringify({ replies }) + '\n```')).toEqual(replies);
        for (const bad of [[], ['a', 'b'], ['a', 'a', 'b'], ['a', '', 'b'], ['a', '[[ACTION:BLOCK]]', 'b']]) {
            expect(() => parseReplySuggestions(JSON.stringify({ replies: bad }))).toThrow();
        }
    });
    it('独立配置使用自己的地址、密钥和模型，关闭后回到主 API', async () => {
        vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ replies }) } }] });
        const independent = { enabled: true, baseUrl: 'https://secondary.test/v1/', apiKey: 'secondary', model: 'secondary-model' };
        await generateReplySuggestions({ ...config, replySuggestionsApi: independent }, user, [], []);
        let [url, options] = vi.mocked(safeFetchJson).mock.calls.at(-1)!;
        expect(url).toBe('https://secondary.test/v1/chat/completions');
        expect(options.headers).toMatchObject({ Authorization: 'Bearer secondary' });
        expect(JSON.parse(options.body as string).model).toBe('secondary-model');
        await generateReplySuggestions({ ...config, replySuggestionsApi: { ...independent, enabled: false } }, user, [], []);
        expect(vi.mocked(safeFetchJson).mock.calls.at(-1)![0]).toBe('https://main.test/v1/chat/completions');
    });
    it('启用但缺失配置时不偷偷调用主 API', async () => {
        vi.mocked(safeFetchJson).mockClear();
        await expect(generateReplySuggestions({ ...config, replySuggestionsApi: { enabled: true, baseUrl: '', apiKey: '', model: '' } }, user, [], [])).rejects.toThrow('请先');
        expect(safeFetchJson).not.toHaveBeenCalled();
    });
});
