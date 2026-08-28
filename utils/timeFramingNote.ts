/**
 * 「现在几点」后面跟的那句语境框定 —— 纯常量零依赖，浏览器与 Cloudflare Worker
 * 共用同一份（同 utils/scheduleChangeParse.ts 的路子）。
 *
 * 为什么需要它：报时那一段贴在生成点前、注意力最强的位置，而人设躺在几千字之外。
 * 光给一句「现在是深夜 23:47」，模型每轮都会把话题收到「快睡吧、明天见」上，聊到
 * 哪都一样，像撞上了健康提醒。这句话把时间的作用限定回「背景」：影响语气和状态，
 * 但不决定这段对话该不该结束。
 *
 * 写法全正向：只说时间该起什么作用，不点名任何要避开的话术——禁语写进提示词反而
 * 会激活它。
 *
 * 只在真的有人在对话时给。日程生成、歌单、攻略、手册、小剧场、角色间对话、以及
 * 「到点主动找人说话」的主动消息，都走各自的时间注入，但那些场合没有「对方」在这个
 * 点跟角色说话，末句会变成摆在注意力最强位置上的一句假话。
 */
export const TIME_FRAMING_CONVERSATIONAL = 'Time is the backdrop you are in right now: it seeps into your tone, your state, the things you mention in passing. As for where this conversation goes and whether it continues, follow whatever you two are actually talking about — a topic finds its own natural end. That they are still talking with you at this hour is itself their choice.';
