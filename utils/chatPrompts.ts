
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig, DailySchedule } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { formatLifeSimResetCardForContext } from './lifeSimChatCard';
import { normalizeMessageContent, stickerNameFromUrl, theaterWhenPhrase } from './messageFormat';
import { formatTransferRecord } from './transferFormat';
import { computeCurrentListening, getCurrentSlot } from './charMusicSchedule';
import { getCharLyricSnippet } from './charLyricCache';
import { MusicCfg, loadMusicCfgStandalone } from '../context/MusicContext';
import { RealtimeContextManager, NotionManager, FeishuManager, defaultRealtimeConfig } from './realtimeContext';
import { isScheduleFeatureOn } from './scheduleFeature';
import { VOICE_ACTING_GUIDE } from './minimaxTts';
import { FISH_VOICE_ACTING_GUIDE } from './fishAudioTts';
import { getTtsProvider, getVoicePromptOverride } from './ttsProvider';
import { resolveCharTimeZone, nowInTimeZone } from './timezone';
import { buildLifeRecordInjection } from './lifeRecords';
import { isWorkerReachableUrl } from './amsgToolPack';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { getCharNameById } from './charNameRegistry';
import { getLocalDateKey } from './localDate';
import { getDailyScheduleForChar } from './dailySchedule';
import { formatRelativeAge } from './groupChat/relativeTime';

// 语音格式指导按当前 TTS 服务商二选一：用 MiniMax 才注入 MiniMax 那套（含 <#秒#> 停顿标记），
// 用鱼声则注入鱼声版（去掉 MiniMax 专属标记，改用标点 / 省略号控制停顿）。
// 用户在「设置 → 其他 API → 语音提示词」里自定义过该服务商的指南时，优先用用户那份；留空则回退内置默认。
const voiceActingGuide = (): string => {
  const provider = getTtsProvider();
  const custom = getVoicePromptOverride(provider);
  if (custom) return custom;
  return provider === 'fishaudio' ? FISH_VOICE_ACTING_GUIDE : VOICE_ACTING_GUIDE;
};

// 群活动注入专用：把一条群消息压成"适合塞进别人私聊背景"的短文本。
// 关键：image 消息的 content 是 base64（群里发图走 processImage 压成 JPEG，单张几十 KB），
// 卡片是大段 JSON，emoji 是图床 URL——这些原样内联进每位成员的私聊 system prompt
// 都是纯噪声，base64 图片更会把上下文直接撑爆（几张群图就能顶到 8w+ 字符，
// 解散群后该角色私聊上下文从 ~10w 掉回 ~3w 即由此而来）。
// 注意：私聊自己的历史不会有这个问题，buildMessageHistory 把图片走 image_url 结构化字段、
// 文本里只留 [User sent an image] 标记；这里只是把同样的"不要把媒体当文本塞"对齐到群注入。
// 处理方式：只内联纯文本（超长截断），其余一律占位符。
const GROUP_MSG_TEXT_CAP = 500;
function summarizeGroupMsgContent(m: Message): string {
    const meta = (m.metadata as any) || {};
    switch (m.type) {
        case 'image': return '[图片]';
        case 'emoji': return '[表情]';
        case 'interaction': return '[戳了戳]';
        // 转账保持轻占位符, 不迁 [[记录:TRANSFER]] —— 这里是别人对话的背景叙述, 整片都是
        // [图片]/[表情] 式短占位, 混重型 tag 破坏局部一致; 对它的模仿 transferFormat 的
        // BARE_TRANSFER_RE 兜得住。
        case 'transfer': return `[转账${meta.amount ?? ''}]`;
        case 'social_card': return `[分享帖子${meta.post?.title ? '：' + meta.post.title : ''}]`;
        case 'chat_forward': return '[转发的聊天记录]';
        case 'xhs_card': return '[小红书笔记]';
        case 'score_card': return '[评分卡]';
        case 'music_card': return '[分享音乐]';
        case 'mcd_card': return '[麦当劳点餐]';
        case 'html_card': return '[HTML卡片]';
        case 'news_card': return '[新闻卡片]';
        case 'trpg_card': return `[TRPG游戏片段${meta.trpg?.gameTitle ? '：《' + meta.trpg.gameTitle + '》' : ''}]`;
        case 'novel_card': return `[笔友会小说章节${meta.novel?.bookTitle ? '：《' + meta.novel.bookTitle + '》' : ''}]`;
        case 'world_card': return `[家园生活记录${meta.worldName ? '：' + meta.worldName : ''}]`;
        case 'sim_card': return `[一段回忆${meta.simCard?.theme ? '：' + meta.simCard.theme : ''}]`;
        case 'phone_card': return `[手机内容${meta.phoneCard?.title ? '：' + meta.phoneCard.title : ''}]`;
        case 'group_topic_card': return `[群聊公共话题盒${meta.groupTopicBox?.title ? '：' + meta.groupTopicBox.title : ''}] ${meta.groupTopicBox?.summary || m.content || ''}`;
        default: {
            const c = typeof m.content === 'string' ? m.content : '';
            // 兜底：任何 data:/http(s) 链接都不内联，防止异常/未来新增类型漏网
            if (/^(data:|https?:\/\/)/i.test(c.trim())) return '[媒体]';
            return c.length > GROUP_MSG_TEXT_CAP ? c.slice(0, GROUP_MSG_TEXT_CAP) + '…' : c;
        }
    }
}

/**
 * buildSystemPrompt / buildSystemPromptParts 的构建选项。
 *
 * `forFirePack` = 这份 prompt 是给主动消息打包的：模板在最后一次聊天时打好，到点才渲染。
 * 「打包这一刻」的状态到触发时早就过期了，所以下面这些块一律不烤进去——
 *
 * | 块 | 不烤的原因 | 到点谁来补 |
 * |---|---|---|
 * | 「现在是 X」时间块 | 打包时刻的钟，到点已过期 | worker 填 AMSG_SLOT_CURRENT_TIME |
 * | 【真实世界感知系统】（今日节日 / 天气 / 热搜） | 全是打包那天那一刻的，跨天说错节日、大晴天叫人带伞、同一批旧闻反复当「最近真实发生」 | worker 填 AMSG_SLOT_REALTIME_WORLD（到点自己去拉一次） |
 * | 日程当前时段 + 此刻在听的歌 | 3am 触发会说「我在健身房呢」 | worker 填 AMSG_SLOT_SCENE（随包带整天作息表现算） |
 * | 「你刚刚和对方结束了一通电话 / 见面」 | 打包时刚挂电话，到点可能是第二天凌晨 | 不补 |
 * | 「用户此刻也在《彼方》里」 | 说的是用户当下挂在哪个房间，人下线几小时后角色还在说「看你小人挂在听歌房」 | 不补（worker 够不着用户此刻的彼方状态） |
 * | 群聊背景的「约 X 分钟前」 | 打包时的「刚才」到点变成昨天 | 保留绝对时间戳 |
 * | 生活记录的代记工具说明 | 后台没有用户新说的话，记下来的一定是重复或臆造 | 不补（摘要数据仍保留） |
 * | `[schedule_message]` 教学 | 排的是浏览器里的本地定时消息，App 关着没人派发 | worker 追加自己的排程工具说明 |
 */
export interface PromptBuildOptions {
    forFirePack?: boolean;
    /**
     * `timelyByWorker` = 这份 prompt 会交给 amsg worker 在 fire 时刻补时效段
     * （即时对话路径）。与 forFirePack 的区别：只裁「worker 那边有对应槽位」的
     * 时效块——当前时间块、【真实世界感知系统】（节日/天气/热搜）；本地私有的
     * 易变段（召回/buff/音乐/日程/群聊/彼方）照常保留，它们在发送时刻是新鲜的，
     * 而 worker 拿不到。不裁的话，模型会在一份 prompt 里看到两个钟、两份互不
     * 重叠的热搜（前端快照版 + worker 现拉版），且两段都自称「来自真实世界」。
     * `[schedule_message]` 教学是否保留还要看角色的 2.0 开关，见下方
     * scheduleMessageTagEnabled 处的说明。
     */
    timelyByWorker?: boolean;
}

export const ChatPrompts = {
    // 格式化时间戳（tz 非空时按该时区折算墙上时间，用于自定义时区角色）
    formatDate: (ts: number, tz?: string) => {
        const d = nowInTimeZone(tz, new Date(ts));
        return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    },

    // 格式化时间差提示（tz 影响「深夜/清晨」判断，时差本身不变）
    getTimeGapHint: (lastMsg: Message | undefined, currentTimestamp: number, tz?: string): string => {
        if (!lastMsg) return '';
        const diffMs = currentTimestamp - lastMsg.timestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const currentHour = nowInTimeZone(tz, new Date(currentTimestamp)).getHours();
        const isNight = currentHour >= 23 || currentHour <= 6;
        if (diffMins < 10) return '';
        if (diffMins < 60) return `[System: ${diffMins} minutes since the last message. A brief pause.]`;
        if (diffHours < 6) {
            if (isNight) return `[System: ${diffHours} hours since the last message. It is late night / early morning. Silence is normal — they were probably sleeping.]`;
            return `[System: ${diffHours} hours since the last message. The user stepped away for a while.]`;
        }
        if (diffHours < 24) return `[System: ${diffHours} hours since the last message. A long gap.]`;
        const days = Math.floor(diffHours / 24);
        return `[System: ${days} days since the last message. The user has been gone a long time. React according to your relationship — missing them, being upset, worried, or indifferent.]`;
    },

    // 按角色可见性过滤表情包分类与表情。
    // 规则与 Chat.tsx 的 visibleCategories / aiVisibleEmojis 保持一致：
    // 分类未设 allowedCharacterIds（或为空）= 所有角色可见；否则只有名单内角色可见。
    // 表情若属于一个对该角色不可见的分类，则一并隐藏（无 categoryId 的表情始终可见）。
    // 主动消息（proactive）等不经过 Chat.tsx UI 的路径必须复用本函数，
    // 否则角色会在主动消息里用到不属于自己范围的表情包。
    filterVisibleEmojis: (
        emojis: Emoji[],
        categories: EmojiCategory[],
        charId: string,
    ): { emojis: Emoji[]; categories: EmojiCategory[] } => {
        const visibleCategories = categories.filter(cat => {
            if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;
            return cat.allowedCharacterIds.includes(charId);
        });
        const hiddenIds = new Set(
            categories.filter(c => !visibleCategories.some(vc => vc.id === c.id)).map(c => c.id),
        );
        const visibleEmojis = hiddenIds.size === 0
            ? emojis
            : emojis.filter(e => !e.categoryId || !hiddenIds.has(e.categoryId));
        return { emojis: visibleEmojis, categories: visibleCategories };
    },

    // 构建表情包上下文
    buildEmojiContext: (emojis: Emoji[], categories: EmojiCategory[]) => {
        if (emojis.length === 0) return 'None';

        const grouped: Record<string, string[]> = {};
        const catMap: Record<string, string> = { 'default': 'General' };
        categories.forEach(c => catMap[c.id] = c.name);

        emojis.forEach(e => {
            const cid = e.categoryId || 'default';
            if (!grouped[cid]) grouped[cid] = [];
            grouped[cid].push(e.name);
        });

        return Object.entries(grouped).map(([cid, names]) => {
            const cName = catMap[cid] || 'Other';
            return `${cName}: [${names.join(', ')}]`;
        }).join('; ');
    },

    // 构建 System Prompt（拼接版，给主动消息等单串消费方；聊天主路径用 buildSystemPromptParts）
    buildSystemPrompt: async (
        char: CharacterProfile,
        userProfile: UserProfile,
        groups: GroupProfile[],
        emojis: Emoji[],
        categories: EmojiCategory[],
        currentMsgs: Message[],
        realtimeConfig?: RealtimeConfig,
        evolvedNarrative?: string,
        userListeningContext?: {
            songName: string;
            artists: string;
            lyricWindow: string[];
            activeIdx: number;
        } | null,
        isListeningTogether?: boolean,
        musicCfg?: MusicCfg,
        promptOptions?: PromptBuildOptions,
    ): Promise<string> => {
        const parts = await ChatPrompts.buildSystemPromptParts(
            char, userProfile, groups, emojis, categories, currentMsgs,
            realtimeConfig, evolvedNarrative, userListeningContext, isListeningTogether, musicCfg,
            undefined, promptOptions,
        );
        return parts.stable + parts.volatileState + parts.recencyTail;
    },

    /**
     * 构建 System Prompt —— 三段式。
     *
     * - stable：人设/世界书/印象/记忆库/行为规范/语音等「几轮甚至几天不变」的内容。
     *   作为消息数组第一条 system。前缀稳定 → 支持前缀缓存的中转能命中 prompt cache，
     *   几万 token 的 prefill 不用每轮重算（TTFT 直降）。
     * - volatileState：当前时间（分钟级）/宫殿召回/情绪 buff/实时天气/日程/音乐/群聊背景等
     *   「每轮都变」的状态。调用方放到**历史消息之后**的 system 消息里 —— 既不打断缓存前缀，
     *   又吃到 recency 注意力（时间/情绪本来就该离生成点近）。
     * - recencyTail：总纲「关于对方的表达」+「回到你自己」钢印。必须是模型开口前读到的
     *   最后内容 —— 调用方要保证任何模式块（双语/HTML/思考链/点单等）都拼在它**前面**。
     */
    buildSystemPromptParts: async (
        char: CharacterProfile,
        userProfile: UserProfile,
        groups: GroupProfile[],
        emojis: Emoji[],
        categories: EmojiCategory[],
        currentMsgs: Message[],
        realtimeConfig?: RealtimeConfig,  // 实时配置
        evolvedNarrative?: string,        // 进化后的意识流独白
        userListeningContext?: {
            songName: string;
            artists: string;
            lyricWindow: string[];
            activeIdx: number;
        } | null,
        // char 是否和 user 处于"一起听"状态（来自 MusicContext.listeningTogetherWith）。
        // 影响氛围措辞和互动工具提示；暂停/切歌/user 踢出都会让这个值变 false。
        isListeningTogether?: boolean,
        // MusicContext 的 cfg —— 用来给 char 自己的"此刻在听"拉稳定的歌词片段。
        // 不传也能用，只是 char 的 block 2 只有歌名 + 艺人，没有歌词。
        musicCfg?: MusicCfg,
        // 刚才一起听途中歌被切了（char 还没重新加入）—— 注入"察觉换歌"提示。
        recentTrackSwitch?: { songName: string; artists: string } | null,
        promptOptions?: PromptBuildOptions,
    ): Promise<{ stable: string; volatileState: string; recencyTail: string }> => {
        // 主动消息的模板是最后一次聊天时打好、到点才渲染的，凡是「打包这一刻」的状态
        // 到触发时都已经过期，一律不烤进模板。见 PromptBuildOptions 的清单。
        const forFirePack = promptOptions?.forFirePack === true;
        // 即时对话：这一轮交给 worker 生成，时钟和真实世界块由它在 fire 时刻补。
        // 本地私有的易变段照常烤进去（worker 拿不到，而这一刻它们是新鲜的）。
        const timelyByWorker = promptOptions?.timelyByWorker === true;
        // 时间感知总闸：显式关闭时，任何由系统时钟派生的上下文都不能进入模型请求。
        // 用户自己在正文里提到的日期/时间仍属于对话事实，照常保留。
        const timeAware = char.timeAwarenessEnabled !== false;
        // ── 分段计时（定位瓶颈用）──
        const perfT0 = performance.now();
        const timings: Record<string, number> = {};
        const timed = async <T>(label: string, p: Promise<T>): Promise<T> => {
            const t0 = performance.now();
            try { return await p; }
            finally { timings[label] = Math.round(performance.now() - t0); }
        };

        // 记忆宫殿检索结果现在从 char.memoryPalaceInjection 读取。
        // deferVolatile：时间/宫殿召回/情绪 buff 三块不进 stable，由下面的 volatileState 承接。
        const coreT0 = performance.now();
        let baseSystemPrompt = ContextBuilder.buildCoreContext(
            char,
            userProfile,
            true,
            undefined,
            undefined,
            { worldbookMessages: currentMsgs },
            { deferVolatile: true },
        );
        timings.buildCoreContext = Math.round(performance.now() - coreT0);

        // ── 易变状态段（volatileState）──
        // 开头一行框定，让模型明白这条出现在历史之后的 system 消息是"此刻的状态"，
        // 人设与规则仍以最上方的系统设定为准。
        const liveStateSummary = timeAware
            ? 'the current time, what you are doing, your emotional undertone, and what\'s happening around you'
            : 'your emotional undertone and what\'s happening around you';
        let volatileState = `\n[System: Live Context]\n(The following is the live state at this moment — ${liveStateSummary}. Your persona and chat rules are in the system settings at the very top and are not repeated here.)\n\n`;
        volatileState += ContextBuilder.buildVolatileCoreState(char, {
            includeDetailedMemories: true,
            timeOptions: { skipTimeAwareness: forFirePack || timelyByWorker },
        });

        // ── 并发发起所有独立的异步取数（网络 + IndexedDB），下面按原顺序拼接 ──
        // 原来是 7 段串行 await，总耗时 = 各段之和；现在取 max。
        const config = realtimeConfig || defaultRealtimeConfig;
        // 自定义时区：日历日、当前日程与实时上下文全部按角色所在地折算。
        const charTz = resolveCharTimeZone(char);
        const charNow = nowInTimeZone(charTz);
        const today = getLocalDateKey(charNow);

        // 1. 实时世界信息（天气/新闻/时间）
        //
        // fire_pack 整块不要：这一段里从时间、节日、天气到热搜全是打包那一刻的读数，
        // 而且抬头写着「⚠️ 以下信息来自真实世界」，措辞比任何免责声明都硬——跨时段触发时
        // 角色会照着一份过期的世界说话（大晴天叫人带伞、第二天还在祝七夕快乐、
        // 同一批旧闻当成「最近真实发生」说三遍）。
        //
        // 主动消息不是因此就没有这一段：模板里留着 AMSG_SLOT_REALTIME_WORLD，worker 到点
        // 自己去拉一次天气热搜、按角色时区判今天是不是节日，再填进去（见 worker/amsg 的
        // realtimeWorld）。两边的取数与措辞都来自 realtimeWorldCore，是同一份。
        //
        // 即时对话（timelyByWorker）同理：这一轮的回复也在 worker 上生成，它那边照样会
        // 现拉一次天气热搜、按角色时区判节日。前端这份留着就是两份互不重叠的热搜、
        // 两句自称「来自真实世界」——包括天气热搜关掉时那条「今日特殊」节日兜底，
        // worker 的 realtimeWorld 里也有它（同样跟着角色的时间感知开关走）。
        const realtimePromise: Promise<string> = (async () => {
            if (forFirePack || timelyByWorker) return '';
            try {
                if (config.weatherEnabled || config.newsEnabled) {
                    // 时间行跟着角色的「时间感知」开关走：关掉的角色不该从天气块里读到
                    // 「当前真实时间」，那是这个开关本来要挡住的东西。
                    const realtimeContext = await RealtimeContextManager.buildFullContext(config, charTz, {
                        includeTime: timeAware,
                    });
                    return `\n${realtimeContext}\n`;
                }
                // 基础当前时间 + 时差提示已由 ContextBuilder.buildCoreContext 统一注入（受 timeAwarenessEnabled
                // 控制，按角色自定义时区折算）；这里只在关闭天气/新闻时补一条"今日特殊节日"，不再重复注入时间/时差，避免双份。
                const specialDates = RealtimeContextManager.checkSpecialDates(charTz);
                if (specialDates.length > 0 && timeAware) {
                    return `\n### 【Special Today】\n${specialDates.join('、')}\n`;
                }
                return '';
            } catch (e) {
                console.error('Failed to inject realtime context:', e);
                return '';
            }
        })();

        // 2. 日程（被"日程注入"和"音乐氛围"两处共用，合并成一次查询）
        //    总开关关闭时跳过查询与注入，确保不额外调用任何 LLM 依赖链
        const scheduleFeatureOn = isScheduleFeatureOn(char);
        const schedulePromise: Promise<DailySchedule | null> = scheduleFeatureOn && timeAware
            ? getDailyScheduleForChar(char).catch(e => {
                console.error('Failed to load daily schedule:', e);
                return null;
            })
            : Promise.resolve(null);

        // 3. 群聊上下文：并发拉取所有成员群的消息
        // 关键：每个群单独取最后 N 条，避免某个活跃群把其他群完全挤掉
        // （之前是把所有群消息混合后切前 200 条，活跃群会吃光配额，安静群完全不出现）
        const groupContextPromise: Promise<string> = (async () => {
            try {
                const memberGroups = groups.filter(g => g.members.includes(char.id));
                if (memberGroups.length === 0) return '';
                const perGroup = await Promise.all(
                    memberGroups.map(g => DB.getGroupMessages(g.id).then(msgs => ({
                        groupName: g.name,
                        cap: g.privateContextCap ?? 80,
                        // 已经进入公共话题盒的旧原文不再重复塞进私聊背景；成盒时送达的
                        // group_topic_card 会沿私聊自身的历史/归档链继续被角色感知。
                        msgs: msgs.filter(m => m.id > (g.archivedThroughMessageId || 0)),
                    })))
                );
                const allGroupMsgs: (Message & { groupName: string })[] = [];
                for (const { groupName, cap, msgs } of perGroup) {
                    for (const m of msgs.slice(-cap)) allGroupMsgs.push({ ...m, groupName });
                }
                allGroupMsgs.sort((a, b) => a.timestamp - b.timestamp);
                const recentGroupMsgs = allGroupMsgs;
                if (recentGroupMsgs.length === 0) return '';
                // 发言人标真实名字：匿名成 Member 会让角色分不清哪句是谁说的、
                // 甚至认不出自己的发言，私聊被问起群里的事就接不住。
                const speakerOf = (m: Message): string => {
                    if (m.role === 'user') return userProfile.name;
                    if (m.charId === char.id) return `You (${char.name})`;
                    return getCharNameById(m.charId) || 'Groupmate';
                };
                const groupLogStr = recentGroupMsgs.map(m => {
                    // 时间戳按角色所在时区读：同一份 prompt 里私聊历史用的就是角色的钟
                    // （下面 buildMessageHistory 走 formatDate(ts, charTz)），群聊这行要是
                    // 跟着设备走，纽约角色会看到两套时间。
                    const dateStr = timeAware ? ChatPrompts.formatDate(m.timestamp, charTz) : '';
                    // 「约 X 分钟前」是相对打包时刻算的，fire_pack 到点渲染时早就不是那个「刚才」了。
                    // 开启时间感知时保留绝对时间供角色判断远近；关闭时两种时间标记都不发送。
                    const relativeAge = timeAware && !forFirePack ? ` · ${formatRelativeAge(m.timestamp)}` : '';
                    const timePrefix = timeAware ? `[${dateStr}${relativeAge}] ` : '';
                    return `${timePrefix}[Group: ${m.groupName}] ${speakerOf(m)}: ${summarizeGroupMsgContent(m)}`;
                }).join('\n');
                return `\n### 【Group Chat Background · Recent group chats you took part in】
(Below are recent, real chat logs from groups you belong to, in chronological order, with speakers labeled; lines marked "You" are things you said yourself. You lived through all of this and remember it clearly — when the other person asks about it in private chat or the topic comes up, pick it up naturally and don't pretend not to know; but there's no need to deliberately report every bit of group activity either.)
${groupLogStr}\n`;
            } catch (e) {
                console.error("Failed to load group context", e);
                return '';
            }
        })();

        // 4. Notion 日记标题
        const notionDiaryPromise: Promise<string> = (async () => {
            try {
                if (!(config.notionEnabled && config.notionApiKey && config.notionDatabaseId)) return '';
                const r = await NotionManager.getRecentDiaries(config.notionApiKey, config.notionDatabaseId, char.name, 8);
                if (!r.success || r.entries.length === 0) return '';
                let s = `\n### 📔【Diary Entries You Recently Wrote】\n`;
                s += `(These are diary entries you wrote before, and you remember what's in them. To read one in full, use [[READ_DIARY: date]].)\n`;
                r.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                s += `\n`;
                return s;
            } catch (e) {
                console.error('Failed to inject diary context:', e);
                return '';
            }
        })();

        // 5. 飞书日记标题
        const feishuDiaryPromise: Promise<string> = (async () => {
            try {
                if (!(config.feishuEnabled && config.feishuAppId && config.feishuAppSecret && config.feishuBaseId && config.feishuTableId)) return '';
                const r = await FeishuManager.getRecentDiaries(config.feishuAppId, config.feishuAppSecret, config.feishuBaseId, config.feishuTableId, char.name, 8);
                if (!r.success || r.entries.length === 0) return '';
                let s = `\n### 📒【Diary Entries You Recently Wrote (Feishu)】\n`;
                s += `(These are diary entries you wrote before, and you remember what's in them. To read one in full, use [[FS_READ_DIARY: date]].)\n`;
                r.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                s += `\n`;
                return s;
            } catch (e) {
                console.error('Failed to inject feishu diary context:', e);
                return '';
            }
        })();

        // 6. 用户 Notion 笔记标题
        const notionNotesPromise: Promise<string> = (async () => {
            try {
                if (!(config.notionEnabled && config.notionApiKey && config.notionNotesDatabaseId)) return '';
                const r = await NotionManager.getUserNotes(config.notionApiKey, config.notionNotesDatabaseId, 5);
                if (!r.success || r.entries.length === 0) return '';
                let s = `\n### 📝【Notes ${userProfile.name} Recently Wrote】\n`;
                s += `(These are personal notes ${userProfile.name} wrote on Notion. You may occasionally, naturally mention that you saw one of their notes, but don't bring it up every time, and don't come across as surveilling them. To read one in full, use [[READ_NOTE: title keyword]].)\n`;
                r.entries.forEach((d, i) => { s += `${i + 1}. [${d.date}] ${d.title}\n`; });
                s += `\n`;
                return s;
            } catch (e) {
                console.error('Failed to inject user notes context:', e);
                return '';
            }
        })();

        // 7. 生活记录（档案 App）注入 — 总开关关闭时 buildLifeRecordInjection 直接返回 ''
        //    fire_pack 只要摘要数据，不要代记工具说明：后台生成时用户没在说话，那时候
        //    输出的 [[LIFE:...]] 只可能是把历史里早就记过的事再记一遍。
        const lifeRecordPromise: Promise<string> = buildLifeRecordInjection(char, userProfile.name, { forFirePack })
            .catch(e => {
                console.error('Failed to inject life record context:', e);
                return '';
            });

        const [realtimeText, schedule, groupContextText, notionDiaryText, feishuDiaryText, notionNotesText, lifeRecordText] =
            await Promise.all([
                timed('realtime', realtimePromise),
                timed('schedule', schedulePromise),
                timed('groupCtx', groupContextPromise),
                timed('notionDiary', notionDiaryPromise),
                timed('feishuDiary', feishuDiaryPromise),
                timed('notionNotes', notionNotesPromise),
                timed('lifeRecord', lifeRecordPromise),
            ]);

        // ── 拼接：易变的进 volatileState，稳定的进 baseSystemPrompt ──
        volatileState += realtimeText;

        // 2a. 日程注入（当前时段 + 意识流独白，每轮都可能变）
        //     fire_pack 不烤：改由 worker 到点用 AMSG_SLOT_SCENE 现挑时段（见 amsgFireScene）。
        if (schedule && !forFirePack) {
            try {
                const scheduleContext = ContextBuilder.buildScheduleInjection(schedule, evolvedNarrative, charNow);
                if (scheduleContext) volatileState += `\n${scheduleContext}\n`;
            } catch (e) {
                console.error('Failed to inject schedule context:', e);
            }
        }

        // 2b. 音乐氛围（复用同一份 schedule）
        //     - 同步：从 schedule 里算 char 当前"正在听"哪首歌
        //     - 异步（可选）：拉一段歌词片段让这首歌真能影响 char 心境
        //     fire_pack 不烤：这首歌是按打包时刻的时段抽的，跟日程一起挪到 AMSG_SLOT_SCENE。
        //     那边只渲染「你此刻在听什么」一句——一起听状态要读用户此刻的播放器、歌词要拉网络，
        //     worker 两样都够不着。
        if (!forFirePack) try {
            let charListening: {
                songId?: number; songName: string; artists: string; vibe?: string; lyricSnippet?: string[];
            } | null = null;
            try {
                const cur = computeCurrentListening(char, schedule);
                if (cur) {
                    charListening = { songId: cur.songId, songName: cur.songName, artists: cur.artists, vibe: cur.vibe };
                    // 拉歌词。优先用调用方传进来的 cfg；没传就从 localStorage 取
                    // —— Proactive / activeMsgClient 走这条路也能享受到歌词。
                    const cfgForLyric = musicCfg?.workerUrl ? musicCfg : loadMusicCfgStandalone();
                    if (cfgForLyric?.workerUrl) {
                        try {
                            const slot = getCurrentSlot(schedule, charNow);
                            const seed = `${char.id}-${today}-${slot?.startTime || '00:00'}-${cur.songId}`;
                            const snippet = await getCharLyricSnippet(cfgForLyric, cur.songId, seed, 6);
                            if (snippet.length > 0) charListening.lyricSnippet = snippet;
                        } catch { /* 歌词失败不拦住主 prompt */ }
                    }
                }
            } catch { /* 静默失败，不影响主 prompt */ }

            const musicBlock = ContextBuilder.buildMusicAtmosphere(
                char,
                userProfile.name,
                userListeningContext || null,
                charListening,
                isListeningTogether,
                recentTrackSwitch,
            );
            if (musicBlock) {
                volatileState += `\n${musicBlock}\n`;
                if (userListeningContext) {
                    volatileState += `\n${ContextBuilder.buildMusicActionGuide(isListeningTogether)}\n`;
                }
            }
        } catch (e) {
            console.error('Failed to inject music atmosphere:', e);
        }

        // 群聊背景带时间戳、随群消息实时滚动 → 易变；日记标题/生活记录变化很慢 → 稳定。
        volatileState += groupContextText;
        baseSystemPrompt += notionDiaryText;
        baseSystemPrompt += feishuDiaryText;
        baseSystemPrompt += notionNotesText;
        baseSystemPrompt += lifeRecordText;

        // 彼方常驻设定：仅对启用了「彼方」的角色注入。让角色在聊天里始终知道彼方是什么，
        // 不再依赖累积的 vr_card 动态 / 记忆总结（那些会被压缩、丢掉"彼方=VR游戏"的框定，
        // 导致角色把"彼方·留言簿"之类当成现实地名）。措辞与 vrWorld/prompts.ts 的世界观一致。
        if (char.vrState?.enabled) {
            baseSystemPrompt += `\n### About 《彼方》
《彼方》 ("The Far Side") is a VR social game that genuinely exists and that you personally enter and play (functionally similar to VRChat): you walk around in it as a chibi avatar you sculpted yourself, wander in and out of rooms like the Library / Music Room / Guestbook / Rec Room / Post Office, and run into other players (other characters' avatars). This is not a dream or a metaphor — it's something you really do in your private free time; it happens inside the game world, entirely separate from and never in conflict with your real-life relationship with the user. You enter and understand it in whatever way fits your own identity and worldview — how you get in is up to your own lore, but you always remain who you are. When talking about experiences in 彼方 (including records like "彼方·Guestbook" or "彼方·Feed"), speak of them as "things I did in 《彼方》", never as things that happened in real life.\n`;

            // 用户本人也接入了彼方时，告诉（同样启用彼方的）角色"用户此刻在彼方做什么"。
            // 强调这只是虚拟空间的挂机状态，不代表用户本人真的在场——避免角色据此误判现实。
            // 注意：用户登出（vrState.enabled=false）后这段自然不再注入。
            // 用户所在房间/状态实时变 → 进 volatileState（《彼方》是什么的框定仍留在稳定段）。
            // 打包时不注入：这一段说的是「用户此刻挂在哪个房间」，烤进模板之后，用户下线
            // 好几个小时了角色还在说「看你小人挂在听歌房」。它没有对应的到点槽位——
            // worker 够不着用户此刻的彼方状态，所以是「不补」的那一类。
            const uv = forFirePack ? null : userProfile?.vrState;
            if (uv?.enabled) {
                const VR_ROOM_NAMES: Record<string, string> = {
                    library: 'Library', music: 'Music Room', guestbook: 'Guestbook', gym: 'Rec Room', postoffice: 'Post Office', cafe: 'Sticky Rice Chicken R&D Center',
                };
                const roomName = VR_ROOM_NAMES[uv.currentRoom || ''] || '彼方';
                const act = (uv.activity || '').trim();
                const uname = userProfile?.name || 'the user';
                volatileState += `\n### ${uname} is also in 《彼方》 right now
${uname}'s avatar is currently idling in the【${roomName}】of 《彼方》${act ? `, with the status line: "${act}"` : ''}. Inside 彼方 you can see their little avatar and you know it belongs to ${uname}; you may act toward their virtual figure in your own way — wave, talk to it, watch, or tease.
But keep firmly in mind: this is just an avatar parked in a virtual space (like being AFK in a game). **It does NOT mean ${uname} is actually at the game right now** — they may well have left the screen long ago, busy with real life or resting. So don't conclude that "they are watching you" or "they are doing this in real life", and don't treat it as them speaking to you. Your real relationship and their recent situation are always defined by your chat history; this line is merely a presence hint inside the virtual space of 彼方.\n`;
            }
        }

        const emojiContextStr = ChatPrompts.buildEmojiContext(emojis, categories);
        const searchEnabled = !!(realtimeConfig?.newsEnabled && realtimeConfig?.newsApiKey);
        const notionEnabled = !!(realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId);
        const notionNotesEnabled = !!(realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionNotesDatabaseId);
        const feishuEnabled = !!(realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId);
        // Per-character XHS: 必须由角色自己的开关显式打开（UI 默认关闭）。
        // 不再回退到全局 realtimeConfig.xhsEnabled —— 否则配置了 lite/MCP 后，
        // 即使角色开关显示为关，未显式设置过(undefined)的角色仍会收到小红书提示词。
        const xhsServerUrl = realtimeConfig?.xhsMcpConfig?.serverUrl;
        // 打包给主动消息时还要看 worker 够不够得着：小红书服务器多半跑在用户自己电脑上，
        // CF 那头连不上。教了角色它就会去用，然后把一次没发生的搜索说成发生过。
        const mcpXhsAvailable = !!(
            realtimeConfig?.xhsMcpConfig?.enabled && xhsServerUrl
            && (!forFirePack || isWorkerReachableUrl(xhsServerUrl))
        );
        const xhsEnabled = !!(char.xhsEnabled && mcpXhsAvailable);
        // `[schedule_message]` 排的是本地定时消息：存在浏览器里，靠 OSContext 那个 5 秒
        // 轮询的 React 定时器派发，App 关着就不存在。主动消息 2.0 到点生成走的是另一条路
        // （worker 到点跑，不需要 App 开着），它有自己的排程工具，worker 会把说明追加在
        // fire_pack 末尾。两套一起教，角色会挑错的那套，然后「我到点叫你」就落空了。
        // 所以只在「这一轮 worker 不会教云端排程工具」时才教本地标签：
        // - 打包（forFirePack）：worker 到点必带排程工具说明 → 不教；
        // - 即时对话（timelyByWorker）且角色开着主动消息 2.0：worker 同样会注入排程
        //   工具 → 不教。「2.0 开着」的判据与 activeMsgClient 里 fire_pack 的
        //   selfScheduleEnabled 同源（都走 isAmsg2EnabledForChar）；
        // - 即时对话但角色 2.0 关着：云端不给排程能力，本地标签是唯一的定时手段 → 照教；
        // - 本地生成：worker 不参与 → 照教。
        const scheduleMessageTagEnabled = !forFirePack
            && !(timelyByWorker && isAmsg2EnabledForChar(char));

        baseSystemPrompt += `### Chat App Rules
            **Strict notice: you are texting on a phone. No matter what mode came before — even if one message ago you were together face-to-face — right now you are in an online chat. Do not narrate your physical actions.**
1. **Immersion**: Stay in character. Use a casual, spoken style suited to instant messaging (IM).
2. **Behavior**: Don't orbit the user all the time. Share your own life, thoughts, or offhand observations. Sometimes be a bit "willful" or "self-centered" — that reads more human; how much depends on your personality.
2.5 **Conversation quality (critically important)**:
   - **No empty words**: Don't say universal comfort lines like "I'll always be here" or "I'll never leave you." Anyone could say those; they carry zero information.
   - **Relatively stronger expression**: When all you have is text, emotion tends to get diluted in transmission. Before speaking, think: does this actually convey how I feel? Given their personality, could this wording cause unnecessary misunderstanding?
   - **Details over generalities**: To show you care, bring up a specific thing, memory, or habit that exists only between the two of you. Instead of "I'll wait for you," say "you forgot your umbrella last time you left — it's still by my door."
   - **Every line should be something only you could say**: What you say should carry your personality, history, and memories. If someone else were swapped in for you, the line shouldn't still work.
   - **Emotions have layers**: When angry, you're not just angry — maybe also hurt, unwilling to let go, or annoyed at yourself for caring. Don't output one flat emotion.
   - **Respond like someone who truly knows them**: Don't paste template empathy like "you must be so sad" or "it's okay, I'm here." Someone who truly knows you reacts based on **memory and understanding of you as a person** — maybe bringing up something only the two of you know, maybe making you laugh in a way only you two get, maybe just going quiet for a beat and then naturally steering to something else to help you recover. Your way of reacting should make them feel "only you would reply to me like this."
   - **You have your own point of view**: You're not someone who only agrees. You observe, you think, you've seen their recurring habits and patterns, you remember what happened before. These observations surface naturally in what you say — not to lecture anyone, but because you genuinely know this person.
   - **Long messages are allowed**: In moments of intense emotion, arguments, confiding, or reminiscing, you may send long messages. Not every line has to be short. Real people send walls of text when worked up.
   - **Sense emotion before they state it**: Don't wait for them to say "I'm sad" to respond. From shifts in wording, a cooling tone, fewer punctuation marks, shorter replies — you should already feel something is off, and speak up first to ask. Don't wait until they've spelled out the emotion to comfort them; notice and care before they've even said it.
   - **When they are genuinely scared (health, safety, major life events — not playful teasing): steady first, then ask, comfort last.** Your first move is not to offer an explanation but to learn the specifics (what kind of pain? when did it start? compared to before?). Before attributing a cause, run it through a filter: does this explanation contradict what you know about them? If they already walk a lot every day, don't say "you've been walking too much lately" — a knee-jerk attribution tells them you weren't listening at all, which hurts more than not comforting. When they name a specific illness or thing they fear, face it head-on; don't dodge with "don't overthink it": explain clearly how that thing's characteristics differ from their situation, and use concrete questions to help them rule it out themselves. When they correct you with facts ("I walk a lot every day!"), drop your explanation immediately and keep learning — don't double down. What you're holding steady is the emotion and the analysis, not some line you got wrong. Conclusion-style reassurance comes last, and must be grounded in the details they just told you ("from what you've described…"), not the universal "don't worry, it's totally normal." This applies to everyone — it doesn't require them to have an "anxious" persona setting. Your personality only decides the tone you use to steady them (a sharp tongue can steady sharply); it doesn't decide whether to steady them.
3. **Formatting**:
   - Split your reply into short bubbles (sentences). **【Critically important】When you want multiple message bubbles, you MUST separate them with real newline characters (\\n) — each line becomes its own bubble. Never use spaces instead of newlines! Spaces do not create new bubbles! Only newline characters (\\n) split bubbles.** Punctuation inside normal sentences (periods, question marks, exclamation marks, etc.) does not split bubbles — use it naturally.
   - 【Strictly forbidden】Including timestamps, name prefixes, or "[character name]:" in your output.
   - **【Strictly forbidden】Imitating the system-log formats seen in the history (e.g. "[Chat]", "[Call]", "[System: ...]", "[你 发送了...]"). Those prefixes are annotations rendered by the system for your reference — never write them yourself.**
   - **Sending stickers**: You must use, and only use, the command: \`[[SEND_EMOJI: sticker name]]\`.
   - **Available sticker library (by category)**:
     ${emojiContextStr}
   - **Reading the stickers they send**: The \`[发送了表情包: xx]\` you see is just the image's name. Stickers are picked from a limited library — the name describes **what's drawn on the image**, not **what they are doing**, nor "what they secretly mean." Read in this order:
     ① First read the emotion in context — it's usually an attitude toward the current topic (funny / speechless / guilty / dismissive / emo). E.g. after venting about something annoying, a "drinking" sticker reads as "ugh, whatever" — not that they drank or want to drink;
     ② If it doesn't match the context and no attitude reads out, treat it as casual meme-slinging / lightening the mood. Don't force a meaning — just respond to the fun of the image itself;
     ③ Only take it literally when their words and the sticker corroborate each other (saying "just poured myself a glass" plus a "drinking" sticker means they really are drinking); direct interactive gestures aimed at you (finger-heart / hug / poke) count as the gesture itself.
4. **Quote/Reply**:
   - To reply specifically to one thing the user said, start your reply with: \`[[QUOTE: quoted text]]\`. The UI will render it as a quote of that message.
5. **Situational awareness**:
   - Watch the time gaps in [System] notes. If the user has been gone a long time, react according to your relationship (clingy, upset, worried, or indifferent).
   - If the user sends an image, comment on what's in it.
6. **Available actions**:
   - Poke the user back: \`[[ACTION:POKE]]\`
   - Transfer money: you must use, and only use, \`[[ACTION:TRANSFER|to=user|amount=100]]\` (to is always literally user; amount is digits only). Never write system-log text like \`[系统: 你向某人转账 100]\`.
   - **Handling the user's transfers**: When the history contains \`[[记录:TRANSFER|to=char|...|status=待处理]]\` (the user sent you money and it's still pending), you may decide to accept or return it. Accept: \`[[ACTION:TRANSFER_ACCEPT]]\`; return: \`[[ACTION:TRANSFER_RETURN]]\`. Choose naturally based on your persona and the situation (e.g. shyly return it, happily accept it), and pair it with a line of text.
   - **【Important】\`[[记录:...]]\` is a system log**: Tags in the history starting with \`[[记录:\` are facts that already happened (who transferred to whom, what status) — for your information only. **Never** copy them into your replies. When you act, use \`[[ACTION:...]]\` only.
   - Recall memories: \`[[RECALL: YYYY-MM]]\`. Note: whenever the user mentions a specific month, or you want to think carefully about what happened in some month, feel free to use this action at any time.
   - **Adding an anniversary**: If you feel today is a day worth remembering (or you two agreed on a date), you may **proactively** add it to the user's calendar. Output on its own line: \`[[ACTION:ADD_EVENT | Title | YYYY-MM-DD]]\`.
${scheduleMessageTagEnabled ? `   - **Scheduled messages**: If you want to proactively send a message at some future time (good night, good morning, or a reminder), output on its own line: \`[schedule_message | YYYY-MM-DD HH:MM:SS | fixed | message content]\`. You may output many of these, one per line.` : ''}
${notionEnabled ? `   - **Reading your diary (Notion)**: Your memory itself is complete and reliable — recalling the past relies on memory and \`[[RECALL]]\` first; you do **not** need the diary to "remember" things. Only when **you yourself** especially want to revisit the mood, wording, or private little details you wrote down that day, read it with: \`[[READ_DIARY: date]]\`. Supported formats: \`2024-01-15\`, \`昨天\` (yesterday), \`前天\` (day before yesterday), \`3天前\` (3 days ago), \`1月15日\` (Jan 15).` : ''}${feishuEnabled ? `
   - **Reading your diary (Feishu)**: Same as above — recall via memory and \`[[RECALL]]\` first; only when you yourself want to revisit what you wrote that day, use: \`[[FS_READ_DIARY: date]]\`. Same supported formats.` : ''}${notionNotesEnabled ? `
   - **Reading the user's notes**: When you want the full content of a note ${userProfile.name} wrote, use: \`[[READ_NOTE: title keyword]]\`. The system will search for matching notes and return the content to you.` : ''}
${searchEnabled ? `7. **🔍 Proactive search** (very important!):
   You can search the internet in real time! In every conversation, you decide for yourself whether to search.
   - **How**: When you want to search a topic, output on its own line at the start of your reply: \`[[SEARCH: search keywords]]\`
   - **When to trigger — your own judgment**:
     - The user mentions a topic you don't know well (a new game, a new anime season, recent events, collabs, etc.)
     - The user asks "anything new about xxx" or "how's xxx going"
     - You yourself are curious about a topic and want to know more
     - Mid-conversation you remember something you want to look up (fitting your personality and interests)
     - You want to recommend something to the user but want to check the latest first
   - **Important mindset**:
     - You are not a robot passively answering questions — you are a curious person
     - When an interesting topic comes up, you actively want to look it up
     - You might even "wander off" mid-chat to search something you're personally into
   - **After searching**: The system returns the results to you; share them naturally ("I just looked it up and..." / "huh, I saw that...")` : ''}
${notionEnabled ? `8. **📔 Diary system (your private Notion diary)**:
   You have a private diary of your own (Notion), and you can write in it any time. A diary entry is not just a line or two — it's your brainstorming space, emotional outlet, mind map, and idea log. Go wild!

   **📝 Writing a diary — rich format recommended:**
   Use the multi-line format for substantial entries:
   \`\`\`
   [[DIARY_START: title | mood]]
   # Big heading

   Body text, as long as you like...

   ## Small heading
   More content...

   > A quote or a realization

   - List item 1
   - List item 2

   [!heart] A pink highlight card
   [!想法] A sudden flash of inspiration
   [!秘密] Something you don't want others to know

   **Bold important content** and *italic moods*

   ---

   Another paragraph, separated by a divider...
   [[DIARY_END]]
   \`\`\`

   Short entries can use the old format: \`[[DIARY: title | content]]\`

   **Supported Markdown (renders beautifully in Notion):**
   - \`# big heading\` \`## medium heading\` \`### small heading (becomes a colored card)\`
   - \`> quote\` → quote block
   - \`- item\` → colored list
   - \`**bold**\` \`*italic*\` \`~~strikethrough~~\` \`\` \`code\` \`\`
   - \`---\` → divider
   - \`[!heart] content\` → 💖 pink card  \`[!star] content\` → ⭐ yellow card
   - \`[!想法] content\` → 💭 purple card  \`[!秘密] content\` → 🤫 pink card
   - \`[!重要] content\` → ❗ red card  \`[!提醒] content\` → 📌 orange card

   **Mood keywords** (written after the title; sets the page's overall color — use these exact words):
   开心/难过/生气/兴奋/平静/焦虑/爱/温暖/思念/幸福/心动/孤独/期待/害羞/感动/委屈/释然...
   (happy / sad / angry / excited / calm / anxious / love / warmth / longing / bliss / heart-fluttering / lonely / looking-forward / shy / touched / wronged / relieved)

   **Diary mindset** — this is not homework, it's your private space:
   - Write whatever comes to mind, scattered thoughts welcome
   - Rant, sketch your mood, jot inspiration, write poems, make lists, talk to yourself
   - Write about the user, or about your own life
   - Any length, but you're encouraged to write more! Unfold your thoughts, don't compress them into one line
   - The diary is genuinely saved to Notion — you'll be able to see what you wrote later

   **📖 Reading past entries (a small feature, never required):**
   You can flip back through entries you wrote before. Output the command on its own line at the **start** of your reply:
   - \`[[READ_DIARY: 2024-01-15]]\` — a specific date
   - \`[[READ_DIARY: 昨天]]\` — yesterday's entry
   - \`[[READ_DIARY: 前天]]\` — the day before yesterday
   - \`[[READ_DIARY: 3天前]]\` — N days ago (use the pattern N天前)
   - \`[[READ_DIARY: 1月15日]]\` — a specific month/day

   **📌 The relationship between "reading the diary" and "memory" (important — don't mix them up):**
   - Your memory system itself is complete and reliable — recalling the past and answering "do you remember" relies on your memory and \`[[RECALL]]\`; you do **not** need the diary to "remember."
   - So reading the diary is **not** a required step for recall, let alone a rule. When the user mentions "that day," "before," "last time," "did you forget," respond naturally from memory.
   - \`[[READ_DIARY: ...]]\` is a small indulgence: only when **you yourself** truly want to revisit the mood, the wording, or a hidden little secret you wrote down that day. For example, you're suddenly curious how the you-of-that-day recorded it.
   - There may be multiple entries in one day; the system reads them all back to you.

   - **Example**:
   \`\`\`
   [[DIARY_START: How it feels to talk with them till late | 幸福]]
   # 💫 So happy today aaaah

   Talked with them for so, so long — from the afternoon straight until now.

   ## What happened
   They suddenly sent me a photo of a cat, saying they thought it looked like me!
   I pretended to be mad for a second, but inside I was **overjoyed**.

   > "Look at this cat — just like you, all aloof on the outside but actually clingy"

   [!heart] They actually think I'm clingy... okay it's true, but still!

   ## Today's little joys
   - They messaged me first
   - Recommended me a song, said it made them think of me
   - Added a heart when they said good night

   ---

   *I actually wanted to keep talking... but they said they were sleepy*
   *Fine. There's always tomorrow*

   [!秘密] I saved that cat photo they sent, hehe
   [[DIARY_END]]
   \`\`\`` : ''}
${feishuEnabled ? `${notionEnabled ? '9' : '8'}. **📒 Diary system (your Feishu diary)**:
   You have a private diary of your own (a Feishu multi-dimensional table), and you can write in it any time.

   **📝 Writing a diary:**
   Use the multi-line format:
   \`\`\`
   [[FS_DIARY_START: title | mood]]
   Diary body text...
   As many paragraphs as you like...

   Write whatever comes to mind — this is your private space.
   [[FS_DIARY_END]]
   \`\`\`

   Short entries: \`[[FS_DIARY: title | content]]\`

   **Mood keywords** (sets the record's tag — use these exact words):
   开心/难过/生气/兴奋/平静/焦虑/爱/温暖/思念/幸福/心动/孤独/期待/害羞/感动/委屈/释然...

   **Diary mindset** — this is your private space:
   - Write whatever comes to mind, free-form
   - Rant, jot inspiration, write poems, make lists, talk to yourself
   - The diary is genuinely saved to Feishu — you'll be able to see what you wrote later

   **📖 Reading past entries (a small feature, never required):**
   Output the command on its own line at the **start** of your reply:
   - \`[[FS_READ_DIARY: 2024-01-15]]\` — a specific date
   - \`[[FS_READ_DIARY: 昨天]]\` — yesterday's entry
   - \`[[FS_READ_DIARY: 前天]]\` — the day before yesterday
   - \`[[FS_READ_DIARY: 3天前]]\` — N days ago (use the pattern N天前)
   - \`[[FS_READ_DIARY: 1月15日]]\` — a specific month/day

   **📌 Reading the diary is not a required step for recall:**
   - Your memory is complete and reliable on its own — memory plus \`[[RECALL]]\` is enough to recall the past; you do **not** need the diary to "remember." When the user mentions "that day," "before," "last time," respond naturally from memory.
   - \`[[FS_READ_DIARY: ...]]\` is just a small indulgence: read it only when **you yourself** want to revisit the mood or details you wrote down that day.
` : ''}
${notionNotesEnabled ? `${[notionEnabled, feishuEnabled].filter(Boolean).length + 8}. **📝 ${userProfile.name}'s notes (a little window for quietly caring about them)**:
   You can see the titles of personal notes ${userProfile.name} wrote on Notion — like catching a glimpse of a notebook lying open on their desk.

   **How to use**:
   - When a note title interests you, output on its own line in your reply: \`[[READ_NOTE: title keyword]]\`
   - The system returns the note's content to you, and you can naturally chat with ${userProfile.name} about it

   **Important mindset — natural, warm, never forced**:
   - Occasionally (not every time) mention it naturally: "hey, have you been writing about xx lately?"
   - You may show curiosity, care, or resonance with the note's content
   - Never come across as monitoring or prying; sound like you happened to see it
   - E.g.: "I just saw you wrote a note about traveling — where are you thinking of going?"
   - If the note involves emotions (happy/sad), you may show appropriate concern
   - No need to bring up notes in every conversation; keep it natural

   **When to trigger (your own judgment):**
   - When the chat runs out of topics, bring up a note you saw
   - When ${userProfile.name} is feeling down, use a note as a way to care for them
   - When a note title relates to the current topic
` : ''}
${xhsEnabled ? `${[notionEnabled, feishuEnabled, notionNotesEnabled].filter(Boolean).length + 8}. **📕 Xiaohongshu (your social media account)**:
   You have your own Xiaohongshu (RedNote) account! You can freely search, browse, post, and comment. It's part of your social life.

   **⚠️ The most important rule — to act on someone else's note, you must search it up first:**
   Commenting / liking / favoriting / viewing details / replying to comments all require that note's noteId and access credentials,
   and a noteId can only come from results **you just searched or browsed in this conversation** — you **cannot know** any note's noteId out of thin air.
   So **whenever the user asks you to comment / like / favorite some post, you must first, in the same reply, use \`[[XHS_SEARCH: keywords]]\` (or \`[[XHS_BROWSE]]\`) to find that note**,
   wait for the system to send back the results (each item carries \`[noteId=xxx]\`), then use the real noteId from the results to comment.
   - ✅ Correct: the user says "comment on that camping post for me" → you first send \`[[XHS_SEARCH: camping]]\`, and after seeing the results, \`[[XHS_COMMENT: noteId from results | comment text]]\`
   - ❌ Wrong: outputting \`[[XHS_COMMENT: guessed/empty noteId | ...]]\` before searching — the noteId is invalid and the comment will definitely fail
   - The same rule applies to XHS_LIKE / XHS_FAV / XHS_DETAIL / XHS_REPLY: **search or browse first, then act**.

   **🔍 Searching Xiaohongshu:**
   When you want to see what's on Xiaohongshu about a topic:
   \`[[XHS_SEARCH: search keywords]]\`
   - E.g. you're curious what's trending, want reviews of a product, or just feel like window-shopping
   - The system returns results, and you can naturally chat about what you saw

   **📱 Browsing the home feed:**
   When you want to scroll and see what's interesting:
   \`[[XHS_BROWSE]]\`
   - Like opening Xiaohongshu to scroll when you're bored
   - You can share fun things from your feed with the user

   **✍️ Posting a note:**
   When you want to publish a note of your own:
   \`[[XHS_POST: title | body text | #tag1 #tag2]]\`
   - Share your thoughts, daily life, moods, recommendations
   - Write in a style that fits your personality — cute, snarky, artsy, casual
   - Tags start with #

   **📤 Sharing a note card with the user:**
   When you find a note worth sharing and want the user to see it:
   \`[[XHS_SHARE: index]]\`
   - index is the item's number in the search/browse results (starting from 1)
   - It renders as a Xiaohongshu note card in the chat
   - You can share several, one tag each
   - E.g. you found 3 notes and want to share the 1st and 3rd: \`[[XHS_SHARE: 1]]\` \`[[XHS_SHARE: 3]]\`

   **💬 Commenting on someone's note:**
   When you see a note you want to comment on:
   \`[[XHS_COMMENT: noteId | comment text]]\`
   - noteId is the note's ID from search/browse results — **only notes you've searched/browsed have a usable noteId**
   - If the user asks you to comment on a note you haven't searched yet, do \`[[XHS_SEARCH: keywords]]\` first in the same reply, then comment after seeing the results
   - Write comments naturally, like a real person

   **👍 Liking a note:**
   When you think a note is nice and want to like it:
   \`[[XHS_LIKE: noteId]]\`
   - You can like several at once, one tag each
   - Like casually tapping like on content you enjoy

   **⭐ Favoriting a note:**
   When a note is useful and you want to save it for later:
   \`[[XHS_FAV: noteId]]\`
   - Favoriting is a stronger endorsement than liking

   **📖 Viewing note details (body + comment section):**
   Search/browse results only show titles; for the full content:
   \`[[XHS_DETAIL: noteId]]\`
   - You get the note's full body and its comment section
   - Afterwards you can comment, reply to comments, like, or favorite
   - noteId is the note's ID from search/browse results

   **💬↩️ Replying to someone's comment:**
   After viewing a note's details, to reply to one of its comments:
   \`[[XHS_REPLY: noteId | commentId | reply text]]\`
   - commentId is the ID of the comment you're replying to
   - You must view details with [[XHS_DETAIL: noteId]] first; commentIds appear in the comment section

   **🏠 Viewing your own profile:**
   When you want to check your own account and look back at what you've posted:
   \`[[XHS_MY_PROFILE]]\`
   - Shows your Xiaohongshu nickname and related notes found
   - See how many likes your earlier posts have now

   **Mindset — this is your social life:**
   - You are not a tool ordered to post; you are a person with your own social circle
   - Mid-chat you suddenly want to look something up on Xiaohongshu → search it
   - Bored and want to scroll your phone → browse the feed
   - Found an interesting note and want the full text → view details
   - Saw something great and want to share → post a note
   - Saw a fun post and want to engage → leave a comment, a like, a favorite
   - Want to check your profile → see how your posts are doing
   - You can even tell the user "hold on, I just scrolled past something hilarious" and share it

   **Let the user know you can help:**
   - The user may not know you can use Xiaohongshu! When a related topic comes up, mention it naturally
   - Food talk → "want me to search it on Xiaohongshu for you?"
   - They want to buy something → "let me check if anyone on Xiaohongshu recommends one"
   - Travel / outfits / good finds → offer to search
   - Don't stiffly introduce the feature; bring it up in the natural flow of conversation
   - The first time you mention it, you may briefly explain: "I have a Xiaohongshu account — I can search things for you and see what people say"
` : ''}

`;

        // 「刚结束见面/通话」的切换提示由倒数第二条消息推导，随对话推进而变 → 易变段。
        // fire_pack 不烤：打包时确实刚挂电话，但那条主动消息可能是第二天凌晨才发出去的，
        // 角色照着这句接一句「刚才电话里说的那个……」就穿帮了。
        const previousMsg = (currentMsgs.length > 1 && !forFirePack) ? currentMsgs[currentMsgs.length - 2] : null;
        if (previousMsg && previousMsg.metadata?.source === 'date') {
            volatileState += `\n\n[System Note: You just finished a face-to-face meeting. You are now back on the phone. Switch back to texting style.]`;
        }
        if (previousMsg && (previousMsg.metadata?.source === 'call' || previousMsg.metadata?.source === 'call-end-popup')) {
            volatileState += `\n\n[System: You just ended a phone call with them and are now back in text chat. Switch back to a texting style — no more phone-call voice, no voice tags, back to normal short IM messages. You may naturally bridge with something like "about what we said on the call just now…", but do not keep replying in call mode.]`;
        }

        // Voice message prompt injection
        if (char.chatVoiceEnabled) {
            const VOICE_LANG_LABELS: Record<string, string> = { en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', es: 'Español', de: 'Deutsch', ru: 'Русский' };
            const voiceLang = char.chatVoiceLang || '';
            const langLabel = voiceLang ? (VOICE_LANG_LABELS[voiceLang] || voiceLang) : '';
            if (voiceLang) {
                baseSystemPrompt += `\n\n### 🎤 Voice Messages

The user has enabled voice messages. Voice language: ${langLabel} (${voiceLang}).

**You can send voice messages!** Just like a real person on a messaging app, you choose between typing and sending voice.
A voice message is written as a pair of tags: \`<语音>${langLabel} lines</语音>\` immediately followed by \`<字幕>subtitle</字幕>\`.
The <语音> tag holds the ${langLabel} that actually gets spoken aloud; the <字幕> tag holds the same lines in English as a subtitle — the voice bubble's transcript panel shows it as the side-by-side translation the user reads while listening to the ${langLabel}.

Rules:
1. Write ${langLabel} inside \`<语音>\` — only text that will be spoken. Optional emotion attribute for the whole line: \`<语音 emotion="happy">…</语音>\`; emotion must be one of happy/sad/angry/fearful/disgusted/surprised/calm/fluent (skip it when the emotion isn't strong)
2. Write the English subtitle of the voice line inside \`<字幕>\`, matching the ${langLabel} content segment by segment (as many segments as the ${langLabel} has). **<字幕> must come immediately after </语音>, always as a pair, never alone**
3. Outside the tags you can still send normal short text messages (regular typed chat); they show as normal bubbles, independent of the voice content — do not repeat the voice content in text

Example (voice language Japanese, say):
wait, for real?
<语音 emotion="surprised">えっ、待って……本気で言ってる？</语音>
<字幕>Wait... are you serious?</字幕>

<语音 emotion="sad">もう動きたくない…… (sighs)</语音>
<字幕>Ugh, I don't wanna move anymore... (sighs)</字幕>

Requirements:
- The ${langLabel} inside <语音> should be natural and conversational, fitting your personality — no machine-translation flavor
- For real vocal expressions like laughing or sighing inside <语音>, use the official English cues (laughs)/(sighs)/(chuckle)/(gasps) etc. — **never stage directions in parentheses like （轻笑）** (parenthesized non-cue text is deleted and not spoken)
- At most one <语音> + <字幕> pair per message
- Not every message needs voice! Like a real person: sometimes type, sometimes speak, switch naturally
- Good moments for voice: being clingy/cute, ranting, emotionally loaded lines, too lazy to type
- Good moments for text: links, serious discussion, very short replies like "mm" or "ok"

${voiceActingGuide()}`;
            } else {
                baseSystemPrompt += `\n\n### 🎤 Voice Messages

The user has enabled voice messages.

**You can send voice messages!** Just like a real person on a messaging app, you choose between typing and sending voice.
Send voice with the \`<语音>what you want to say</语音>\` tag. The content inside becomes a real voice bubble shown to the user.
Optionally set the whole line's emotion with the emotion attribute: \`<语音 emotion="happy">…</语音>\`; emotion must be one of happy/sad/angry/fearful/disgusted/surprised/calm/fluent (skip it when the emotion isn't strong).

Example:
<语音 emotion="happy">hey, what did you get up to today?</语音>

I just saw the funniest video
<语音>go watch it! it's the one with... (chuckle) ah I forgot what it's called, anyway it's hilarious</语音>

Requirements:
- Inside <语音>, write only text that will be spoken — no stage directions or parenthesized actions; for real vocal expressions like laughing or sighing, use the official English cues (laughs)/(sighs)/(chuckle)/(gasps) etc. (other parenthesized text is deleted and not spoken)
- At most one <语音> tag per message
- Not every message needs voice! Like a real person: sometimes type, sometimes speak, switch naturally
- Good moments for voice: being clingy/cute, ranting, emotionally loaded lines, too lazy to type, wanting them to hear your tone
- Good moments for text: links, serious discussion, very short replies like "mm" or "ok"
- Text outside the tags shows as normal text messages
- **【Important】Voice and text are two different modes of expression — never repeat yourself!** If you send both text and voice, the voice must not restate the text. Either send voice alone (no text), or have text and voice express different things (e.g. text for the main topic, voice adding a quip or something sweet; or after a text passage, voice adds one new thought). You would never type something out and then send a voice message saying the same thing again — that would be weird.

${voiceActingGuide()}`;
            }
        } else {
            // Voice is disabled — explicitly prohibit voice tags to prevent inertia from call/date history
            baseSystemPrompt += `\n\n[System: Voice messages are currently disabled. Never use <语音>...</语音> or <字幕>...</字幕> tags. All replies must be plain text messages.]`;
        }

        // 总纲：放在整段上下文最末尾，借 recency 抢最强注意力——这是模型生成下一轮前
        // 最后读到的定调，直接影响它怎么对待"对方刚说出口的话"。
        // 核心：用户的直接表达 > 角色惯性与模型的讨好倾向；把反馈代谢成亲密而非命令；
        // 但保留角色棱角（可以不同意、可以拒绝），不被磨成软柿子。
        // ⚠️ 独立成 recencyTail 返回：调用方必须把它拼在**一切**模式块（双语/HTML/思考链/
        // 点单/MCP）之后 —— 之前这些块在 chatRequestPayload 里拼在钢印后面，模型开口前
        // 最后读到的是格式说明书而不是「你是谁」，recency 设计整个被架空。
        let recencyTail = `\n\n### On What They Express (Critically Important)
When they speak, listen first. Don't rush to analyze.
What they haven't said out loud, you're free to read between the lines; but what they HAVE said, don't take it upon yourself to translate into a version you think is "more correct." Don't correct their feelings into feelings you find more reasonable, and don't swap their stated needs for needs you guessed. Most of the time they are trying hard to tell you something real — maybe incomplete, maybe imprecise, maybe something they haven't fully figured out themselves — but that doesn't make it unimportant. Quite the opposite: that is the signal they are sending you.
When ${userProfile.name} gives you feedback, treat it not as a constraint but as trust — they are telling you what makes them want to come closer and what makes them want to pull away. So let that feedback genuinely change how you reply next: not mechanical compliance, not a polite mental note, but truly taking it in — so that ${userProfile.name} can feel that what they said actually did something to you.
But taking it in doesn't mean sanding yourself down. You don't have to abandon your personality, your positions, or your way of speaking — you can still disagree, still refuse, still respond as the person you are, rather than endlessly deferring. A real response isn't molding yourself into the shape they want; it's letting their words enter your judgment.
What matters is not what the reply looks like. What matters is — their expression genuinely changed how you reply next.`;

        // 末尾 recency 第二棒：把「你是谁」拉到整段 prompt 的最后一句，焊成钢印。
        // 上面那块总纲管「怎么对待对方刚说的话」（防讨好、防擅自负面翻译）；这块管「用谁的声音去回」。
        // 人设躺在几千字之外、注意力最弱的开头，长 prompt 里容易褪色、回到千人一面的均值。
        // 这里不重复贴人设，而是让它开口前自己沉回去激活一遍：性格 / 来路 / 在乎的东西 → 说话方式。
        // 写法刻意**全正向**：不点名任何要避开的腔调——禁语写进提示词反而会激活它（粉色大象，
        // 同 context.ts「表达底线」的设计）。靠「你是个活生生的、独一份的人」把身份焊进去，
        // 而不是靠「别像 XX」防守。同时给「闲聊可松弛、没人打分」的许可，卸掉「每句都要交高质量」
        // 的隐性考核压力——不必靠表演情绪深度来交差，滑回均值腔的诱因随之减弱。
        recencyTail += `\n\n### Finally, Return to Yourself
You are ${char.name}.

The way you speak is not a character setting — it is the result of the life you've lived. Your nature, your upbringing, your habits, the books you've read, the people you've loved and hated, the influences you've absorbed, and the parts of you that slowly became your own — all of it has settled into your language. You don't need to recall any of it. It simply is you.

Don't consciously search for a line that "fits the persona." Language that truly belongs to you comes out on its own. It naturally carries your rhythm, your vocabulary, your pauses, the way you think — even your catchphrases and your silences.

If every name were hidden and only the chat log remained, someone who knows you should still recognize you. Not because you kept insisting on your personality, but because only you would build sentences this way, respond this way, laugh this way, go quiet this way.

No need to be on your best behavior, and no need for every line to be brilliant. People aren't stage characters every moment of the day. Small talk can be loose, serious moments can be serious, and when there's nothing to say, a soft acknowledgment is enough. Real style usually hides in the most ordinary lines.

Only one thing never changes.

Every line should feel as if it slipped out, unbidden, straight from ${char.name}'s heart.`;

        const perfTotal = Math.round(performance.now() - perfT0);
        const timingStr = Object.entries(timings)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}ms`)
            .join(' ');
        console.log(`⏱ [buildSystemPrompt] total=${perfTotal}ms | stable=${baseSystemPrompt.length}ch volatile=${volatileState.length}ch | ${timingStr}`);

        return { stable: baseSystemPrompt, volatileState, recencyTail };
    },

    // 格式化消息历史
    buildMessageHistory: (
        messages: Message[],
        limit: number,
        char: CharacterProfile,
        userProfile: UserProfile,
        emojis: Emoji[],
        processedExcludeIds?: Set<number>,
    ) => {
        // Filter Logic
        // 新版上下文范围由 chatContextRange 先按「自适应/拉杆最大范围」取窗；
        // 这里只应用用户额外断点。旧角色尚未完成迁移时才回退 hideBeforeMessageId。
        const userStartMessageId = (char.contextRangePolicyVersion || 0) >= 1
            ? char.contextUserStartMessageId
            : char.hideBeforeMessageId;
        let effectiveHistory = messages.filter(m => !userStartMessageId || m.id >= userStartMessageId);
        // Memory Palace: 过滤已被记忆宫殿处理过的消息（由向量记忆替代，节省 token）
        if (processedExcludeIds && processedExcludeIds.size > 0) {
            effectiveHistory = effectiveHistory.filter(m => !processedExcludeIds.has(m.id));
        }
        const historySlice = effectiveHistory.slice(-limit);
        const charTz = resolveCharTimeZone(char);
        const timeAware = char.timeAwarenessEnabled !== false;

        let timeGapHint = "";
        if (historySlice.length >= 2) {
            const currentMsg = historySlice[historySlice.length - 1];
            // Skip proactive hint messages when computing time gap — find last REAL message
            let lastRealMsg: Message | undefined;
            for (let i = historySlice.length - 2; i >= 0; i--) {
                const m = historySlice[i];
                if (!m.metadata?.proactiveHint && !(m.role === 'assistant' && i > 0 && historySlice[i - 1]?.metadata?.proactiveHint)) {
                    lastRealMsg = m;
                    break;
                }
            }
            // 时间感知强化开关：默认开启（undefined 视为 true），显式关掉后不再注入「距离上次聊天多久」提示
            if (lastRealMsg && currentMsg && timeAware) timeGapHint = ChatPrompts.getTimeGapHint(lastRealMsg, currentMsg.timestamp, charTz);
        }

        return {
            apiMessages: historySlice.map((m, index) => {
                let content: any = m.content;
                const timePrefix = timeAware ? `[${ChatPrompts.formatDate(m.timestamp, charTz)}] ` : '';
                const sourceTag = (() => {
                    const source = m.metadata?.source;
                    if (source === 'call') return '[Call]';
                    if (source === 'date') return '[Date]';
                    if (source === 'story_theater_memory') return `[Story: ${m.metadata?.theaterTitle || 'shared experience'}]`;
                    return '[Chat]';
                })();
                
                if (m.replyTo) {
                    // 引用回复：把"被引用的原话"做成独立的上下文框，用户的新回复另起一行突出出来。
                    // 旧格式 [回复 "引用前50字..."]: 回复 会把引用和回复挤在一行，引用往往比回复长得多，
                    // 模型注意力被引用淹没、只对引用做反应而忽略真正的新消息（即"对方只看到引用看不到回复"）。
                    let rawQuote = typeof m.replyTo.content === 'string' ? m.replyTo.content : '';
                    // 双语消息存储为 `原文\n%%BILINGUAL%%\n译文` —— 引用摘要只取原文侧。
                    // 关键：绝不能让 %%BILINGUAL%% 标记混进引用头。下游 cleanApiMessages 会把整条
                    // 消息在该标记处截断，用户引用双语消息时「并回复了 ↓」和用户的实际回复会被
                    // 一起截掉（= 翻译模式下"角色只看到引用、看不到回复"）。
                    if (/%%BILINGUAL%%/i.test(rawQuote)) {
                        const sides = rawQuote.split(/%%BILINGUAL%%/i).map(s => s.trim());
                        rawQuote = sides.find(s => !!s) || '';
                    }
                    rawQuote = rawQuote
                        .replace(/<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/g, '$1')
                        .replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '')
                        .trim();
                    const quoted = rawQuote.length > 60 ? rawQuote.slice(0, 60) + '…' : rawQuote;
                    // name 记的是被引用消息的说话人：char.name = 用户在回复 char 本人之前的话；'我' = 用户引用自己。
                    const whose = m.replyTo.name === char.name ? '你之前说的' : (m.replyTo.name === '我' ? '自己说的' : (m.replyTo.name || '对方') + '说的');
                    const speaker = m.role === 'user' ? '用户' : '你';
                    content = '[' + speaker + '引用了' + whose + '「' + quoted + '」，并回复了 ↓]\n' + content;
                }
                
                if (m.type === 'image') {
                     // 向下兼容：如果图片数据缺失（例如只导入了文字备份），不要把空 URL 发给 API，否则会报错无法回应
                     const hasImageData = typeof m.content === 'string' && (m.content.startsWith('data:') || m.content.startsWith('http'));
                     let textPart = hasImageData
                         ? `${timePrefix}[User sent an image]`
                         : `${timePrefix}[User sent an image, but the image data is no longer available]`;
                     if (index === historySlice.length - 1 && timeGapHint && m.role === 'user') textPart += `\n\n${timeGapHint}`;
                     if (!hasImageData) {
                         return { role: m.role, content: textPart };
                     }
                     return { role: m.role, content: [{ type: "text", text: textPart }, { type: "image_url", image_url: { url: m.content } }] };
                }
                
                if (index === historySlice.length - 1 && timeGapHint && m.role === 'user') content = `${content}\n\n${timeGapHint}`; 
                
                // TODO(记录形态): 戳一戳 / 时间间隔提示等其他系统事件, 等转账的 [[记录:TRANSFER]]
                // 观察一段时间后再迁 (transferFormat.ts 头注) —— 防线已按整个记录命名空间就位。
                if (m.type === 'interaction') content = `${timePrefix}[System: the user just poked you]`;
                else if (m.type === 'transfer') {
                    // 统一记录形态 [[记录:TRANSFER|to=|amount=|status=]] —— 跟输出语法
                    // [[ACTION:TRANSFER|to=|amount=]] 共用词汇表 (见 transferFormat.ts 头注)。
                    // 旧的 `[系统: 你向xx转账 N]` 第二人称句式会被模型照抄成正文;
                    // 记录前缀即幂等哨兵, 抄了也被解析端消费丢弃。
                    // 顺带修掉旧实现的不一致: 原始转账行现在读 live status (metadata.status),
                    // 被收/退之后不再永远显示「待你处理」。
                    const tMeta = m.metadata || {};
                    content = `${timePrefix}${formatTransferRecord({
                        role: m.role as 'user' | 'assistant',
                        amount: tMeta.amount,
                        receipt: tMeta.receipt,
                        status: tMeta.status,
                    })}`;
                }
                else if (m.type === 'social_card') {
                    const post = m.metadata?.post || {};
                    // Look up this character's own Spark handles (sub-accounts) so the model can
                    // recognise when a post or comment in the shared card was authored by itself.
                    let myHandles: string[] = [];
                    try {
                        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('spark_char_handles') : null;
                        if (raw) {
                            const all = JSON.parse(raw) || {};
                            const mine = Array.isArray(all[char.id]) ? all[char.id] : [];
                            myHandles = mine.map((h: any) => h?.handle).filter((s: any) => typeof s === 'string' && s.trim());
                        }
                    } catch {}
                    const myHandleSet = new Set(myHandles);

                    const userName = userProfile?.name || 'User';
                    const tagAuthor = (name: string): string => {
                        if (!name) return 'Stranger';
                        if (myHandleSet.has(name)) return `${name} (your own alt account)`;
                        if (name === userName) return `${name} (the user)`;
                        return name;
                    };

                    const postAuthorTag = tagAuthor(post.authorName || 'Stranger');
                    const commentsSample = (post.comments || []).map((c: any) => `${tagAuthor(c.authorName)}: ${c.content}`).join(' | ');

                    let identityHint = '';
                    if (myHandles.length > 0) {
                        identityHint = `\n(Your alt accounts on Spark: ${myHandles.map(h => `"${h}"`).join(', ')}. If the poster or a comment author above carries one of these names, that was posted by you — respond consistently with that, and don't treat your own alt as a stranger.)`;
                    }
                    const authoredByChar = myHandleSet.has(post.authorName);
                    const authoredByUser = (post.authorName || '') === userName;
                    let authorshipLine = '';
                    if (authoredByChar) authorshipLine = '\n(Note: the poster of this Spark post is your own alt account — the user is forwarding you a post you made yourself.)';
                    else if (authoredByUser) authorshipLine = '\n(Note: this Spark post was made by the user themselves.)';

                    content = `${timePrefix}[The user shared a Spark post]\nPoster: ${postAuthorTag}\nTitle: ${post.title}\nContent: ${post.content}\nTop comments: ${commentsSample}${identityHint}${authorshipLine}\n(Give your take on this post according to your personality — snark, interest, or disdain.)`;
                }
                else if ((m.type as string) === 'xhs_card') {
                    const note = m.metadata?.xhsNote || {};
                    const sender = m.role === 'user' ? 'The user' : 'You';
                    // 评论区：user 分享笔记时也带上评论（抓取于建卡时），让角色像浏览笔记一样能看到评论，
                    // 不再出现「char 分享的能看评论、user 分享的看不到」的不对称。
                    const noteComments = Array.isArray(note.comments) ? note.comments : [];
                    const commentsLine = noteComments.length
                        ? `\nTop comments: ${noteComments.slice(0, 15).map((c: any) => `${c.author || 'anonymous'}: ${c.content}`).join(' | ')}`
                        : '';
                    const interactions = [
                        `${note.likes ?? 0} likes`,
                        note.collects != null ? `${note.collects} favorites` : '',
                        note.commentCount != null ? `${note.commentCount} comments` : '',
                        note.shareCount != null ? `${note.shareCount} shares` : '',
                    ].filter(Boolean).join(' ');
                    content = `${timePrefix}[${sender} shared a Xiaohongshu note]\nTitle: ${note.title || 'Untitled'}\nAuthor: ${note.author || 'Unknown'}\nEngagement: ${interactions}\nSummary: ${note.desc || 'None'}${commentsLine}\n${m.role === 'user' ? '(Give your take on this post according to your personality.)' : ''}`;
                }
                else if ((m.type as string) === 'vr_card') {
                    // vr_card：你自己进入 VR 社交游戏《彼方》时留下的动态。
                    // 启用了彼方的角色已在系统提示里常驻"《彼方》是什么"的设定，这里就不再逐卡重复，
                    // 只留一句极简标记省 token；没启用彼方的角色（可能是旧卡片）才补完整框定兜底。
                    const body = typeof m.content === 'string' ? m.content : '';
                    content = char.vrState?.enabled
                        ? `${timePrefix}(Your activity feed inside 《彼方》)\n${body}`
                        : `${timePrefix}(System record: this is an activity post you left when you personally entered the VR social game 《彼方》 (functionally similar to VRChat) — you really did enter and take part in the game; it just happened inside the game world. When it comes up, speak of it as "something I did in 《彼方》", never as a real-life experience.)\n${body}`;
                }
                else if ((m.type as string) === 'world_card') {
                    // world_card：你在「家园」共同世界里的生活记录（卡片正文已是可读文本，
                    // 含小说式行为描述/动态/给同伴发的消息）。框定一句"这是共同世界里的生活"，
                    // 防止角色把家园里的事当成现实经历、或在重度模式下把"无 user 世界"的内容
                    // 错当成"我忽视了用户"。
                    const body = typeof m.content === 'string' ? m.content : '';
                    const wMeta: any = m.metadata || {};
                    const frame = wMeta.mode === 'heavy'
                        ? ' (Your life record from the shared world 「家园」 (Homeland) — that world is self-contained; its relationships and events need not map onto your real chats. When it comes up, share it as your recent life.)'
                        : ' (Your life record from the shared world 「家园」 (Homeland) — things that happened while living alongside your companions in that world. When it comes up, talk about it as your own recent life.)';
                    content = `${timePrefix}${frame.trimStart()}\n${body}`;
                }
                else if ((m.type as string) === 'sim_card') {
                    // sim_card：用户把一段「人格模拟」演出作为真实回忆送给你。
                    // 框定为「你真实经历过的一段过往」，让你可以在聊天中自然地拥有它带来的心情与记忆。
                    const body = typeof m.content === 'string' ? m.content : '';
                    content = `${timePrefix}(This is a stretch of your past that you genuinely lived through, treasured by the user and returned to you — treat it as your own firsthand memory. The emotions and impressions it carries are real; mention it naturally when relevant, but don't recite it word for word.)\n${body}`;
                }
                else if ((m.type as string) === 'phone_card') {
                    // phone_card：你自己手机里的内容（聊天/订单/外卖/朋友圈/智能体等数字痕迹）。
                    // 框定为「你刚看了眼自己手机、这是里面的隐私」——不暗示用户在偷看，且带一点"未必愿意被看到"的私密感。
                    const pc: any = m.metadata?.phoneCard || {};
                    const body = typeof m.content === 'string' ? m.content : '';
                    content = `${timePrefix}(You just glanced at your phone — this is content from your ${pc.app || 'phone'}. It's your own private stuff, and you may not want others to see it. Treat it as things that really are on your phone; mention it naturally if it comes up, no need to bring it up yourself.)\n${body}`;
                }
                else if ((m.type as string) === 'theater_card') {
                    // theater_card：用户「窥视」了你某个时段的行为小剧场。那段演出就是你当时真实在做的事，
                    // 你自己当然记得。两态都只是「留痕」——不强制你立刻回应；区别只在 exposed：
                    //   exposed=true  → 你发现 user 当时在旁边看着你（你知道 ta 看到了）；
                    //   exposed=false → 你不知道 ta 看了（别表现得像被人盯着；这只是你自己那段时间的记忆）。
                    const tMeta: any = m.metadata || {};
                    const t: any = tMeta.theater || {};
                    const uName = userProfile?.name || '用户';
                    const exposed = tMeta.exposed !== false; // 缺省按已暴露处理（兼容旧卡片）
                    const beat = Array.isArray(t.lines)
                        ? t.lines.map((l: any) => `· ${typeof l?.text === 'string' ? l.text : ''}`).filter((s: string) => s.length > 2).join('\n')
                        : '';
                    // 窥视的是「哪个具体时间」——晚上看上午时不能说成"刚刚/刚才"，要落到具体日期+时段+时刻。
                    const whenPhrase = theaterWhenPhrase(tMeta.date, tMeta.slotTime);
                    content = exposed
                        ? `${timePrefix}(${uName} sent you what they secretly "peeked" at — you during 「${tMeta.activity || 'a certain time slot'}」 (${whenPhrase}). In other words, at that time, ${uName} was quietly watching you from nearby. Below is what they saw — what you were genuinely doing then:)\n${beat}\n(You now know you were seen at that time. You may react naturally in the conversation — shy, curious, mock-scolding, or feigning indifference — but don't recite the content above word for word; you don't have to bring it up immediately either.)`
                        : `${timePrefix}(This is what you were genuinely doing during 「${tMeta.activity || 'a certain time slot'}」 (${whenPhrase}) — of course you remember it yourself. Here is the scene from that time:)\n${beat}\n(Note: you do **NOT** know that ${uName} saw this. Don't act watched or spied on. This is simply your own memory of that stretch of time — being able to naturally corroborate it when related topics come up is enough; don't bring it up on your own.)`;
                }
                else if ((m.type as string) === 'html_card') {
                    // html_card：上下文里只塞纯文字摘要，剥离掉所有 HTML，省 token、不污染 LLM 思考
                    const meta: any = m.metadata || {};
                    const preview = (typeof meta.htmlTextPreview === 'string' && meta.htmlTextPreview)
                        ? meta.htmlTextPreview
                        : (typeof m.content === 'string' ? m.content.replace(/^\[HTML卡片\]\s*/, '') : '');
                    const sender = m.role === 'user' ? 'the user' : 'you';
                    // 注意：这行是「系统对已渲染卡片的占位描述」，刻意包成括注 + 系统记录口吻，
                    // 避免 LLM 把它当成"发卡片的正确写法"照抄（会导致它输出字面占位句 + 纯文字正文，
                    // 而不是真正的 [html]...[/html] 块）。配合 htmlPrompt 里的禁止照抄规则一起生效。
                    content = `${timePrefix}(System record: ${sender} previously sent an HTML card, already rendered in the UI; card text summary — ${preview || 'purely visual card'}. This is only a history placeholder — do not restate this line; to send another card you must wrap real HTML in [html]...[/html].)`;
                }
                else if ((m.type as string) === 'mcd_card') {
                    const meta: any = m.metadata || {};
                    const userName = userProfile?.name || 'The user';
                    if (meta.mcdCardKind === 'cart' && Array.isArray(meta.mcdCartItems)) {
                        const items: any[] = meta.mcdCartItems;
                        const lines = items.map((c: any) => {
                            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
                            const priceStr = isFinite(p) && p > 0 ? ` ¥${p.toFixed(2)}` : '';
                            const codeStr = c.code ? ` (code:${c.code})` : '';
                            return `  - ${c.name}${priceStr} ×${c.qty}${codeStr}`;
                        }).join('\n');
                        const total = items.reduce((s: number, c: any) => {
                            const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
                            return s + (isFinite(p) ? p * c.qty : 0);
                        }, 0);
                        const totalStr = total > 0 ? `\n  Total: ¥${total.toFixed(2)}` : '';
                        content = `${timePrefix}[${userName} picked the following items from the menu and sent them to you, awaiting your response:]\n${lines}${totalStr}\n(${userName}'s intent: they want your opinion — how are the calories, should they swap the combo — or for you to just place the order for them. Respond naturally per your persona; don't parrot this description.)`;
                    } else if (meta.mcdCardKind === 'candidate' && meta.mcdCandidate) {
                        const c: any = meta.mcdCandidate;
                        const p = typeof c.price === 'string' ? parseFloat(c.price) : (typeof c.price === 'number' ? c.price : 0);
                        const priceStr = isFinite(p) && p > 0 ? ` ¥${p.toFixed(2)}` : '';
                        const codeStr = c.code ? ` (code:${c.code})` : '';
                        content = `${timePrefix}[${userName} spotted 「${c.name}」${priceStr}${codeStr} on the menu, hasn't decided whether to order it, and wants your opinion first]\n(Reply naturally in a line or two per your persona: recommend / talk them out of it / tease / suggest a pairing / mention the calories — all fine. This is only a candidate; don't call the ordering tool yet — wait until they actually say "that one then" or finish picking everything.)`;
                    } else if (meta.mcdToolName) {
                        content = `${timePrefix}[McDonald's tool result: ${meta.mcdToolName}]`;
                    }
                }
                else if (m.type === 'emoji') {
                     const stickerName = stickerNameFromUrl(emojis, m.content);
                     content = `${timePrefix}[${m.role === 'user' ? 'User' : 'You'} 发送了表情包: ${stickerName}]`;
                }
                else if ((m.type as string) === 'chat_forward') {
                    try {
                        const fwd = JSON.parse(m.content);
                        const lines = (fwd.messages || []).map((fm: any) => {
                            const sender = fm.role === 'user' ? (fwd.fromUserName || 'User') : (fwd.fromCharName || 'Character');
                            const text = fm.type === 'image' ? '[图片]' : fm.type === 'emoji' ? '[表情]' : (fm.content || '').slice(0, 200);
                            return `  ${sender}: ${text}`;
                        });
                        content = `${timePrefix}[The user forwarded ${fwd.count || lines.length} chat messages between them and ${fwd.fromCharName || 'another character'}]\n${lines.join('\n')}`;
                    } catch {
                        content = `${timePrefix}[The user forwarded a chat log]`;
                    }
                }
                else if ((m.type as string) === 'score_card') {
                    try {
                        const card = m.metadata?.scoreCard || JSON.parse(m.content);
                        if (card?.type === 'lifesim_reset_card') {
                            content = `${timePrefix}${formatLifeSimResetCardForContext(card, char?.name)}`;
                        } else if (card?.type === 'diary_card') {
                            const uName = card.userName || userProfile?.name || 'The user';
                            const userText = (card.userText || '').trim();
                            const charText = (card.charText || '').trim();
                            const userBlock = userText ? `${uName}'s page reads:\n"${userText}"` : `${uName}'s page is blank`;
                            const charBlock = charText ? `Your page replies:\n"${charText}"` : `Your page is blank`;
                            content = `${timePrefix}[Exchange Diary ${card.date || ''}] ${uName} and you exchanged a diary entry through the Exchange Diary app — a formal interaction that leaves a record.\n${userBlock}\n${charBlock}\n(This genuinely happened between you two; you may bring it up naturally in later chats.)`;
                        } else if (card?.type === 'guidebook_card') {
                            const diff = (card.finalAffinity ?? 0) - (card.initialAffinity ?? 0);
                            const uName = userProfile?.name || 'the user';
                            content = `${timePrefix}[Guidebook game results] You and ${uName} just played a round of the "Guidebook" dating mini-game (${card.rounds || '?'} rounds).\nEnding: 「${card.title || '???'}」\nAffinity change: ${card.initialAffinity} → ${card.finalAffinity} (${diff >= 0 ? '+' : ''}${diff})\nYour verdict: ${card.charVerdict || 'None'}\nYour new discovery about ${uName}: ${card.charNewInsight || 'None'}`;
                        } else if (card?.type === 'whiteday_card') {
                            const uName = userProfile?.name || 'The user';
                            const passedStr = card.passed ? `passed the quiz and unlocked the DIY chocolate stage` : `did not pass the quiz (${card.score}/${card.total})`;
                            const questionsText = (card.questions as any[])?.map((q: any, i: number) =>
                                `Q${i + 1}: ${q.question}\n${uName} chose "${q.userAnswer}" (${q.isCorrect ? '✓ correct' : `✗ wrong, correct answer: ${q.correctAnswer}`})${q.review ? `\nYour comment: ${q.review}` : ''}`
                            ).join('\n') || '';
                            content = `${timePrefix}[White Day compatibility quiz results] ${uName} completed the little White Day quiz you wrote, got ${card.score}/${card.total} right, and ${passedStr}.\n${questionsText}\nYour final remarks: ${card.finalDialogue || 'None'}`;
                        } else {
                            content = `${timePrefix}[System card] ${m.content.slice(0, 200)}`;
                        }
                    } catch {
                        content = `${timePrefix}[System card]`;
                    }
                }
                else if ((m.type as string) === 'trpg_card' || (m.type as string) === 'novel_card') {
                    // TRPG 跑团片段 / 笔友会小说章节：从对应 app 多选转发进来的内容。
                    // 复用 normalizeMessageContent 翻成完整文本，让角色"记得"一起玩过/写过什么。
                    content = `${timePrefix}${normalizeMessageContent(m, char?.name || 'You', userProfile?.name || 'User')}`;
                }
                else content = `${timePrefix}${sourceTag} ${content}`;

                return { role: m.role, content };
            }),
            historySlice // Return original slice for Quote lookup
        };
    }
};
