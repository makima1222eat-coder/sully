import { describe, it, expect } from 'vitest';
import { ContextBuilder } from './context';
import { TIME_FRAMING_CONVERSATIONAL } from './timeFramingNote';

// 时间块贴在生成点前、注意力最强的位置，人设却躺在几千字之外的开头。只报一句
// 「现在是深夜 23:47」的话，模型每轮都会把话题收到「快睡吧」上，聊到哪都一样，
// 而用户往人设/世界书里怎么写都盖不过它。这句框定跟着时间一起注入，钉住它别丢。
//
// 措辞刻意全正向（只说时间该起什么作用，不点名任何要避开的话术）——把禁语写进
// 提示词反而会激活它，同 context.ts 里「表达底线」的设计。

const charAt = (timeAwarenessEnabled?: boolean) => ({
    id: 'char-time',
    name: '阿一',
    ...(timeAwarenessEnabled === undefined ? {} : { timeAwarenessEnabled }),
}) as any;

describe('时间块的分寸框定', () => {
    it('对话场合报时的同时说明时间该起什么作用', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { conversational: true });
        expect(block).toContain('It is now');
        expect(block).toContain('Time is the backdrop you are in right now');
        expect(block).toContain('follow whatever you two are actually talking about');
    });

    // 这个函数同样服务日程生成、歌单、攻略、手册、小剧场，以及角色跟角色之间的对话。
    // 那些场合没有「对方」在这个点跟你说话，末句会变成摆在注意力最强位置上的一句假话
    // ——日程生成器会以为用户正在聊天，角色间对话里的「对方」其实是另一个角色。
    it('没人在对话时只报时，不带那句语境框定', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined));
        expect(block).toContain('It is now');
        expect(block).not.toContain('Time is the backdrop you are in right now');
        expect(block).not.toContain('still talking with you');
    });

    it('全正向：不靠列举要避开的话术来防守', () => {
        // 只检查框定那句本身（整个时间块的基础句里本来就有一个 never，不在检查范围）
        expect(TIME_FRAMING_CONVERSATIONAL).not.toMatch(/don't|do not|never/i);
        expect(TIME_FRAMING_CONVERSATIONAL).not.toContain('good night');
    });

    it('时间感知关掉时整段都不出现，这句自然也不该单独漏出来', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(false));
        expect(block).toBe('');
    });

    it('见面纯架空（skipTimeAwareness）同样整段不出现', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { skipTimeAwareness: true, conversational: true });
        expect(block).toBe('');
    });
});
