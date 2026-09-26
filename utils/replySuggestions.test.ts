import { describe, expect, it, vi } from 'vitest';
import { buildReplySuggestionMessages, generateReplySuggestions, parseReplySuggestions } from './replySuggestions';
import { safeFetchJson } from './safeApi';
import type { APIConfig, CharacterProfile, Message } from '../types';

vi.mock('./safeApi', () => ({ safeFetchJson: vi.fn(), extractContent: (data: any) => data.choices[0].message.content }));
const user = { name: '小林', bio: '内向，喜欢简短表达和音乐', avatar: '' };
const replies = [['听起来不错', '我也想试试'], ['你当时是怎么想的？'], ['对了', '最近听到一首歌']];
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
        for (const bad of [[], ['a', 'b'], ['a', 'a', 'b'], ['a', '', 'b'], ['a', '[[ACTION:BLOCK]]', 'b'], [[], ['b'], ['c']], [['a', 1], ['b'], ['c']], [Array(7).fill('a'), ['b'], ['c']]]) {
            expect(() => parseReplySuggestions(JSON.stringify({ replies: bad }))).toThrow();
        }
    });
    it('保留星号聊天提示及连续气泡，不执行为工具命令', () => {
        const options = [['*语音消息*', '我刚才还没说完'], ['*发来一张困猫的照片*', '它又睡着了'], ['对了，周末有空吗？']];
        expect(parseReplySuggestions(JSON.stringify({ replies: options }))).toEqual(options);
    });
    it('标明用户末尾连续气泡的续写起点，系统记录不打断用户回合', () => {
        const history = [
            { role: 'assistant', type: 'text', content: '你觉得怎么样？' },
            { role: 'user', type: 'text', content: '我有两个想法' },
            { role: 'system', type: 'text', content: '时间提示' },
            { role: 'user', type: 'text', content: '首先是配色' },
        ] as Message[];
        const context = JSON.parse(buildReplySuggestionMessages(user, [], history)[1].content);
        expect(context.generation).toEqual({ mode: 'continue_user_turn', continuationStartIndex: 1 });
        expect(context.history.slice(context.generation.continuationStartIndex)).toEqual([
            { role: 'user', speaker: user.name, content: '我有两个想法' },
            { role: 'user', speaker: user.name, content: '首先是配色' },
        ]);
        const answered = JSON.parse(buildReplySuggestionMessages(user, [], [...history, { role: 'assistant', type: 'text', content: '配色怎么了？' } as Message])[1].content);
        expect(answered.generation).toEqual({ mode: 'reply_to_other' });
        expect(JSON.parse(buildReplySuggestionMessages(user, [], [])[1].content).generation).toEqual({ mode: 'start_conversation' });
    });
    it('续写位置以实际发送的最近 40 条历史为准', () => {
        const history = Array.from({ length: 45 }, (_, i) => ({ role: i < 43 ? 'assistant' : 'user', type: 'text', content: String(i) })) as Message[];
        const context = JSON.parse(buildReplySuggestionMessages(user, [], history)[1].content);
        expect(context.history).toHaveLength(40);
        expect(context.generation).toEqual({ mode: 'continue_user_turn', continuationStartIndex: 38 });
        expect(context.history[38].content).toBe('43');
    });
    it('兼容单条文本和换行分气泡，不按标点或空格拆分', () => {
        expect(parseReplySuggestions(JSON.stringify({ replies: ['你好，今天好吗？', '嗯\n我想听听你的看法', ['换个话题', '听歌吧']] })))
            .toEqual([['你好，今天好吗？'], ['嗯', '我想听听你的看法'], ['换个话题', '听歌吧']]);
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
