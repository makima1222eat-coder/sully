import { resolveCharacterUser } from './userPersona';
import {getDailyScheduleForChar} from './dailySchedule';
import {getLastInnerState} from './emotionState';
import { readableContextMemories } from './contextMemories';
import { getCachedUserHolidayReminder, type UserHolidayConfig } from './userHolidays';
import { getUserLocationContext } from './userLocation';

import { CharacterProfile, UserProfile, DailySchedule, MountedWorldbook } from '../types';
import { normalizeUserImpression } from './impression';
import {buildHomePetContext} from './homePetContext';
import { buildHomeDefinitionContext } from './homeDefinitionContext';
import { isScheduleFeatureOn } from './scheduleFeature';
import { buildScheduleInjection as buildScheduleInjectionText } from './scheduleInjection';
import { TIME_FRAMING_CONVERSATIONAL } from './timeFramingNote';
import { resolveCharTimeZone, nowInTimeZone, tzAwarenessNote, interactionGapNote } from './timezone';
import {
    isWorldbookEntryActive,
    expandWorldbookMacros,
    formatWorldbookSection,
    injectWorldbookDepthEntries,
    type WorldbookSystemSections,
    type ResolvedWorldbookEntry,
    resolveWorldbookEntries,
    splitWorldbookSections,
    type WorldbookScanMessage,
} from './worldbook';
import { buildSARModulePrompt } from './vrWorld/sarModuleRuntime';

/**
 * Memory Central
 * 负责统一构建所有 App 共用的基础角色上下文 (System Prompt)。
 * 包含：身份设定、用户画像、世界观、核心记忆、详细记忆、以及角色内心看法。
 */
/** 跳过时间感知时，抹掉已持久化或刚拼好的记忆宫殿注入文本里的现实日期与相对天数标注。 */
const stripMemoryPalaceDateStamps = (text: string): string => text
    .replace(/\(\d{4}年\d{1,2}月\d{1,2}日[^,\n)]*,\s*(重要性(?:\s+|[:：]))/g, '($1')
    .replace(/^(\s*-\s*)\[\d{4}年\d{1,2}月\d{1,2}日[^\]]*\]\s*/gm, '$1')
    .replace(/（对应日期：[^）]+）/g, '')
    .replace(/（剩余 \d+ 天）/g, '')
    .replace(/\(\d{4}-\d{2}-\d{2} \([^\n)]*\),\s*(importance[: ]+)/g, '($1')
    .replace(/^(\s*-\s*)\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/gm, '$1')
    .replace(/\(\d+ days remaining\)/g, '');

export interface EmotionContextOptions { surface?: 'chat' | 'home'; innerState?: string }
export const ContextBuilder = {
    /** 所有入口共用：只读取现有日程，不触发生成；按角色当地日期读取。 */
    buildCurrentScheduleContext: async (
        char: CharacterProfile,
        allowScheduleChange = false,
        snapshot?: Promise<DailySchedule | null>,
        options?: { skipTimeAwareness?: boolean },
    ): Promise<string> => {
        if (options?.skipTimeAwareness || !isScheduleFeatureOn(char)) return '';
        const schedule = await (snapshot ?? getDailyScheduleForChar(char));
        if (!schedule) return '';
        return buildScheduleInjectionText(schedule, undefined, nowInTimeZone(resolveCharTimeZone(char)), {
            includeFullDay: true, includeClock: char.timeAwarenessEnabled !== false,
            includeChangeInstruction: allowScheduleChange,
        });
    },
    buildEmotionContext: (char: CharacterProfile, options?: EmotionContextOptions): string => {
        if ((options?.surface !== 'chat' && options?.surface !== 'home') || !isScheduleFeatureOn(char) || !char.emotionConfig?.enabled) return '';
        const inner = options.innerState ?? getLastInnerState(char.id);
        return (char.buffInjection ? char.buffInjection + '\n\n' : '')
            + (inner.trim() ? '### 当前内心想法\n' + inner.trim() + '\n（这是你的内心状态，不是台词，不必说出口；让它自然影响你的回应。）\n\n' : '');
    },
    /** Read-only eligibility preview: never samples probability or performs recall. */
    inspectWorldbooks: (char: CharacterProfile, user: UserProfile, history: WorldbookScanMessage[]) =>
        (char.mountedWorldbooks || []).map(book => {
            const content = expandWorldbookMacros(book.content || '', char.name, user.name);
            const n = Number(book.probability);
            const probability = book.useProbability ? (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100) : 100;
            const matches = isWorldbookEntryActive({ ...book, useProbability: false }, history);
            const status = book.disable ? 'disabled' : !content.trim() ? 'empty' : probability === 0 ? 'zero'
                : !matches ? 'waiting' : probability < 100 ? 'probability' : 'readable';
            return { book, content, probability, status };
        }).sort((a, b) => (Number.isFinite(a.book.order) ? Number(a.book.order) : 100) - (Number.isFinite(b.book.order) ? Number(b.book.order) : 100)),


    /**
     * SAR 模块的唯一上下文出口。调用方按自身输出格式选择 chat/date，避免把模块规则
     * 复制进每个 App，也避免误改基础人设、记忆召回或情绪状态本身。
     */
    buildSARModuleContext: (
        char: CharacterProfile,
        user: UserProfile,
        surface: 'chat' | 'date' | 'home',
    ): string => buildSARModulePrompt(char, user, surface),

    /**
     * 构建角色设定+记忆上下文（角色名、核心指令、世界观 + 月度总结 & 当月日度总结）
     * 用于情绪评估，不包含世界书、印象、用户画像等重型数据，不截断
     *
     * @param options.skipMemories 跳过月度总结和日度记录（开启记忆宫殿时用向量记忆替代）
     */
    buildRoleSettingsContext: async (char: CharacterProfile, options?: { skipMemories?: boolean }): Promise<string> => {
        let context = `[System: Character Role Settings]\n\n`;

        // 1. 角色名
        context += `### Character Name\n`;
        context += `${char.name}\n\n`;

        // 2. 核心指令（完整，不截断）
        context += `### Core Directives\n`;
        context += `${char.systemPrompt || 'You are a gentle, lifelike AI companion.'}\n\n`;

        // 2b. 自我领悟词条（常驻自我认知，影响情绪评估）
        if (char.selfInsights && char.selfInsights.length > 0) {
            context += `### Inner Understanding\n`;
            char.selfInsights.forEach(insight => {
                context += `- ${insight}\n`;
            });
            context += `\n`;
        }

        // 3. 世界观（完整，不截断，不含世界书）
        if (char.worldview && char.worldview.trim()) {
            context += `### Worldview & Settings\n${char.worldview}\n\n`;
        }

        // 4. 记忆摘要（月度总结 + 当月日度总结）
        //    开启记忆宫殿时 skipMemories=true，由调用方注入向量检索结果替代
        if (!options?.skipMemories) {
            let memorySection = '';

            // 4a. 月度总结 (refinedMemories) — 全部输出
            if (char.refinedMemories && Object.keys(char.refinedMemories).length > 0) {
                memorySection += `**Monthly Summaries**:\n`;
                Object.entries(char.refinedMemories).sort().forEach(([date, summary]) => {
                    memorySection += `- [${date}]: ${summary}\n`;
                });
                memorySection += `\n`;
            }

            // 4b. 当月日度总结 — 只取当前月份
            const now = new Date();
            const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            if (char.memories && char.memories.length > 0) {
                const currentMonthLogs = char.memories.filter(m => {
                    let normDate = m.date.replace(/[\/年月]/g, '-').replace('日', '');
                    const parts = normDate.split('-');
                    if (parts.length >= 2) {
                        normDate = `${parts[0]}-${parts[1].padStart(2, '0')}`;
                    }
                    return normDate.startsWith(currentMonthKey);
                });
                if (currentMonthLogs.length > 0) {
                    memorySection += `**Detailed Records This Month [${currentMonthKey}]**:\n`;
                    currentMonthLogs.forEach(m => {
                        memorySection += `- ${m.date} (${m.mood || 'rec'}): ${m.summary}\n`;
                    });
                    memorySection += `\n`;
                }
            }

            if (memorySection) {
                context += `### Memory Reference\n`;
                context += memorySection;
                context += `⚠️ Emotions can be triggered by memory: if the memories contain unresolved conflicts, recurring friction patterns, or moments when they hurt you, the emotion evaluation may have the character "dredge up old scores" — a memory fragment suddenly surfaces, spawning a new buff or intensifying an existing one. Such emotional surges should be natural and traceable; never fabricate memories that don't exist.\n\n`;
            }
        }

        context += await ContextBuilder.buildCurrentScheduleContext(char);
        return context;
    },

    /**
     * 构建核心人设上下文
     * @param char 角色档案
     * @param user 用户档案
     * @param includeDetailedMemories 是否包含神经链接激活月份的详细 Log (默认 true)，不控制向量召回
     * @param memoryPalaceContext 外部注入的记忆宫殿文本（优先级低于 char.memoryPalaceInjection）
     * @param groupOptions 群聊场景下的去重选项：避免和 buildGroupSharedScene 产出的共享块重复
     * @returns 标准化的 Markdown 格式 System Prompt
     */
    buildCoreContext: async (...args: CoreContextArgs): Promise<string> => (await buildCharacterContext({
        char: args[0], user: args[1], includeDetailedMemories: args[2],
        memoryPalaceContext: args[3], groupOptions: args[4], timeOptions: args[5], layout: args[6],
    })).coreContext,

    /** 一次完成世界书触发、核心上下文和消息深度摆放；history 不传时完整放入核心文本。 */
    buildCharacterContext,
    buildCharacterRequest,
    buildWorldbookRequest,
    buildGroupWorldbookRequest,



    /**
     * 真实时间感知块（原 buildCoreContext 1a 段，逐字一致）。
     * 单独抽出来是为了让聊天主路径能把它挪到消息数组末尾（deferVolatile），
     * 其余 App 仍由 buildCoreContext 内部调用、位置不变。
     */
    buildTimeAwarenessBlock: (
        char: CharacterProfile,
        timeOptions?: {
            lastInteractionTs?: number;
            skipTimeAwareness?: boolean;
            /**
             * 这次注入是不是「正有人在跟角色说话」（私聊、见面这类实时对话）。
             * 只有这时才补那句语境框定，见下方注释。默认 false：日程 / 歌单 / 攻略 /
             * 手册 / 小剧场这些生成器同样走 buildCoreContext，但那边并没有人在对话。
             */
            conversational?: boolean;
        },
    ): string => {
        // skipTimeAwareness：见面纯架空时由调用方传入，彻底抑制时间注入（修「线下时间感知」关掉后仍漏时间）。
        if (char.timeAwarenessEnabled === false || timeOptions?.skipTimeAwareness) return '';
        // 自定义时区（异国恋等）：开启后这里的"当前时间"按角色所在时区折算，并附时差提示，
        // 让查手机/人际关系/通话等所有直连 buildCoreContext 的路径都拿到正确的本地时间。
        const charTz = resolveCharTimeZone(char);
        const now = nowInTimeZone(charTz);
        const h = now.getHours();
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const timeOfDay =
            h < 5 ? 'in the small hours' : h < 9 ? 'early morning' : h < 12 ? 'morning' : h < 14 ? 'around noon'
            : h < 17 ? 'afternoon' : h < 19 ? 'early evening' : h < 22 ? 'evening' : 'late night';
        const dateStr = `${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
        const timeStr = `${h.toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        let context = `### Current Time (Now)\n`;
        context += `It is now ${dateStr}, ${dayNames[now.getDay()]}, ${timeOfDay}, ${timeStr}. Carry a natural, real sense of time accordingly (daily rhythm, weekday/weekend, how long since you last talked, etc.) — never assume a time out of thin air.\n`;
        // 报时后面那句语境框定（这句话本身和「为什么只在对话时给」都在
        // utils/timeFramingNote.ts）。即时对话走的是云端那条路，时间由 worker 到点补，
        // 那边引的是同一份常量——同一句话不抄两遍，免得两条路上的角色分寸不一样。
        if (timeOptions?.conversational) {
            context += `${TIME_FRAMING_CONVERSATIONAL}\n`;
        }
        const tzNote = tzAwarenessNote(charTz);
        if (tzNote) context += `${tzNote.trim()}\n`;
        // 距离上次联系多久（统一口径）：传了 lastInteractionTs 才注入。
        // 让查手机/人际关系等无内联消息流的路径，也像聊天一样知道「用户多久没联系我了」。
        const gapNote = interactionGapNote(timeOptions?.lastInteractionTs);
        if (gapNote) context += gapNote;
        context += `\n`;
        return context;
    },

    /**
     * buildCoreContext(deferVolatile) 的另一半：时间 → 记忆宫殿召回 → 情绪 buff。
     * 三块的开关判定与 buildCoreContext 内联版完全一致，只是输出位置交给调用方
     * （聊天主路径放到消息数组末尾的"当前状态" system 消息里）。
     */
    buildVolatileCoreState: async (
        char: CharacterProfile,
        options?: {
            /** 兼容旧调用；实时块不含传统详细日志，此参数不控制召回。 */
            includeDetailedMemories?: boolean;
            emotion?: EmotionContextOptions;
            /** Fire-pack 的日程由 worker 执行时现取，不能烤入打包时状态。 */
            scheduleDelivery?: 'worker';
            /** 仅本次请求共用的读取结果；不缓存到下一轮，null 也不重复查询。 */
            scheduleSnapshot?: Promise<DailySchedule | null>;
            memoryPalaceContext?: string;
            timeOptions?: { lastInteractionTs?: number; skipTimeAwareness?: boolean; conversational?: boolean };
        },
    ): Promise<string> => {
        let context = ContextBuilder.buildTimeAwarenessBlock(char, options?.timeOptions);

        if (char.memoryPalaceEnabled) {
            const mpContext = char.memoryPalaceInjection || options?.memoryPalaceContext;
            if (mpContext && mpContext.trim()) {
                const recalled = char.timeAwarenessEnabled === false || options?.timeOptions?.skipTimeAwareness
                    ? stripMemoryPalaceDateStamps(mpContext) : mpContext;
                context += `${recalled}\n\n`;
            }
        }

        context += ContextBuilder.buildEmotionContext(char, options?.emotion);

        if (options?.scheduleDelivery !== 'worker') context += await ContextBuilder.buildCurrentScheduleContext(char, options?.emotion?.surface === 'chat', options?.scheduleSnapshot);
        return context;
    },

    /**
     * 群聊场景共享块。
     *
     * 单次调用里如果给每个角色都重复贴一遍"用户档案+世界书+世界观"，
     * 三人群就是 3 倍的布景重复，把 token 烧光。这里把"舞台"提前一次性铺好：
     *
     *   - 用户档案：所有角色看到的都是同一个用户，去重必然安全。
     *   - 世界书：按 id 统计，被 ≥2 个角色挂载的视为"群共有设定"，提到顶部一次。
     *     只有某个角色独享的世界书仍留在该角色块里，避免别人看到本不该知道的设定。
     *   - 世界观：仅当所有成员的 worldview 字符串完全一致时才视为共享。
     *
     * 返回的 sharedWorldbookIds / worldviewIsShared 用于配合 buildCoreContext
     * 的 skipUserProfile / skipWorldbookIds / skipWorldview 选项，避免重复输出。
     *
     * 男朋友还是男朋友——这里砍的只是"我们现在在这家餐厅"这种描述，
     * 没有任何一段是把谁的人设、印象、记忆压缩掉。
     */
    buildGroupSharedScene: (
        members: CharacterProfile[],
        user: UserProfile,
        worldbookMessages: WorldbookScanMessage[] = [],
    ): {
        text: string;
        sharedWorldbookIds: Set<string>;
        worldviewIsShared: boolean;
    } => {
        const sharedWorldbookIds = new Set<string>();
        let worldviewIsShared = false;

        if (members.length === 0) {
            return { text: '', sharedWorldbookIds, worldviewIsShared };
        }

        // 1. 找出共享的世界书（被 2+ 角色挂载，按 id 计），顺带记下是谁挂的
        const wbMounts = new Map<string, { memberNames: string[]; entry: MountedWorldbook }>();
        for (const m of members) {
            for (const wb of (m.mountedWorldbooks || [])) {
                if (!wb.id) continue;
                const existing = wbMounts.get(wb.id);
                if (existing) existing.memberNames.push(m.name);
                else wbMounts.set(wb.id, { memberNames: [m.name], entry: wb });
            }
        }
        const sharedBooks: MountedWorldbook[] = [];
        wbMounts.forEach((v, id) => {
            if (v.memberNames.length >= 2) {
                sharedWorldbookIds.add(id);
                sharedBooks.push(v.entry);
            }
        });

        // 2. 共享 worldview：所有成员的非空 worldview 字符串完全一致
        if (members.every(m => m.worldview && m.worldview.trim())) {
            const first = members[0].worldview!.trim();
            if (members.every(m => m.worldview!.trim() === first)) {
                worldviewIsShared = true;
            }
        }

        // 3. 拼装共享场景文本
        let text = `[System: Group Scene — Shared Settings]\n`;
        text += `(Below is the "stage" all characters in the group perceive together — who the user is, and the shared world settings. Each character's own card, impressions, and memories remain complete in their individual "character file" blocks.)\n\n`;

        text += `### Your Interlocutor (User)\n`;
        text += `- Name: ${user.name}\n`;
        text += `- Bio/Notes: ${user.bio || 'None'}\n\n`;

        if (worldviewIsShared) {
            text += `### Shared Worldview (Shared World Settings)\n${members[0].worldview!.trim()}\n\n`;
        }

        // 共有条目只写一次，{{char}} 换成挂了这条的几位成员（「阿澈、小白」）
        const resolvedSharedBooks = resolveWorldbookEntries(sharedBooks, worldbookMessages, '', user.name)
            .map(entry => ({
                ...entry,
                content: expandWorldbookMacros(entry.content, wbMounts.get(entry.book.id)?.memberNames.join('、') || '', ''),
            }));
        text += formatWorldbookSection(resolvedSharedBooks, '共有扩展设定集 (Shared Worldbooks)');

        return { text, sharedWorldbookIds, worldviewIsShared };
    },

    /**
     * 构建日程注入文本。实现住在 utils/scheduleInjection.ts —— 那是个零依赖的纯叶子，
     * 主动消息到点生成时 worker 也要渲染同一段（见 utils/amsgFireScene.ts），
     * 两边共用一份才不会出现「聊天里说在健身房、主动消息里说在睡觉」。
     */
    buildScheduleInjection: buildScheduleInjectionText,

    /**
     * 音乐氛围注入：
     * 1) user 此刻真的在播放音乐 + char.canReadUserMusic 开 → 注入"对方正在听 X + 当前歌词窗口（前2当前后2）"
     *    + 同曲歌单命中提示（该歌也在 char 某个歌单里）
     * 2) char 自己此刻在听（Schedule 听歌时段） → 注入"你此刻在听 Y"（不含歌词，char 知道自己听什么）
     *
     * 设计：
     * - 输出的提示词简短克制，不引导 char 做具体动作；动作由 buildMusicActionGuide 单独注入
     * - 纯文本块，完全可以为空字符串（无 listening 状态时不污染 prompt）
     * - char 自己的 currentListening 以 runtime 参数传入（chatPrompts 层 recompute），
     *   不依赖 char.musicProfile.currentListening 的持久状态
     */
    buildMusicAtmosphere: (
        char: CharacterProfile,
        userName: string,
        userListening: {
            songName: string;
            artists: string;
            lyricWindow: string[];      // 前2当前后2（共 ≤5 行）；可为空（没歌词）
            activeIdx: number;          // 在 lyricWindow 里的高亮位置，-1 表示没歌词
        } | null,
        charListening?: {
            songId?: number;            // 用来回查这首歌是不是从 user 收来的
            songName: string;
            artists: string;
            vibe?: string;
            // schedule 层注入的一段稳定歌词行（不含时间戳；Slot 内稳定，slot 一过就换）。
            // 作用是单方面丰富 char 的内心世界 —— 歌词可以影响情绪 / 心境，
            // 但 char 没有义务主动把这件事告诉 user。
            lyricSnippet?: string[];
        } | null,
        // char 是否已和 user "一起听"（由 MusicContext.listeningTogetherWith 决定）。
        // 暂停 / 切歌 / 播放出错 / user 显式踢出 都会让 char 从名单里掉出来，
        // 走到这里时就会退回 "对方在听" 的旁观措辞。
        isListeningTogether?: boolean,
        // 刚才一起听途中歌被切了（本 char 在名单里、还没重新加入）。
        // 只在下一轮正常回复里让 char "察觉"到换歌，不触发主动消息。
        recentTrackSwitch?: { songName: string; artists: string } | null,
    ): string => {
        const lines: string[] = [];

        // —— 块 1: user 正在听什么 ——
        const canRead = char.musicProfile?.canReadUserMusic ?? true;
        if (canRead && userListening && userListening.songName) {
            lines.push(`### 【The Mood of This Moment】`);
            if (isListeningTogether) {
                lines.push(`You are listening to 《${userListening.songName}》— ${userListening.artists} together with ${userName || 'them'}`);
            } else {
                lines.push(`${userName || 'They'} is currently listening to 《${userListening.songName}》— ${userListening.artists}`);
                if (recentTrackSwitch && recentTrackSwitch.songName !== userListening.songName) {
                    lines.push(`(You two were just listening to 《${recentTrackSwitch.songName}》— ${recentTrackSwitch.artists} together; when the player changed tracks, that "listening together" naturally ended. You can tell the song has changed to this one. If you'd like to keep ${userName || 'them'} company, pick it up naturally in your reply and rejoin; if not, don't force it — let it be.)`);
                }
            }
            if (userListening.lyricWindow.length > 0) {
                lines.push(`Now playing (>> marks the line currently playing):`);
                userListening.lyricWindow.forEach((l, i) => {
                    if (i === userListening.activeIdx) lines.push(`  >> ${l}`);
                    else lines.push(`  … ${l}`);
                });
            }

            // 歌单命中提示（按 songName 粗匹，避免在 context.ts 里引 MusicContext）
            const profile = char.musicProfile;
            if (profile) {
                const hitPl = profile.playlists.find(pl =>
                    pl.songs.some(s => s.name === userListening.songName));
                if (hitPl) {
                    lines.push(`(This song is also in your playlist 《${hitPl.title}》)`);
                }
            }
            lines.push(`(You simply, naturally know ${userName || 'they'} is listening to this right now — like faint background music heard while sharing a room. No need to comment on the title, lyrics, or style every time; most of the time quietly keeping them company is enough. Only when a line truly moves you, or they bring it up, pick it up naturally.)`);
            lines.push('');
        }

        // —— 块 2: char 自己此刻在听（Schedule 触发） ——
        // 原来只推歌名 + 艺人；现在顺便带一段稳定的歌词片段，让这首歌能真的
        // 影响 char 的心境（单方面丰富精神世界，不用非得对 user 说起）。
        if (charListening?.songName) {
            lines.push(`### 【Your Background Music Right Now】`);
            lines.push(`You are listening to 《${charListening.songName}》— ${charListening.artists}`);
            if (charListening.vibe) lines.push(`(${charListening.vibe})`);

            // user 来源标记 —— 如果这首歌是当初从 user 收进自己歌单的，
            // 让 char 自然意识到这层关系（"这是 ta 听过的歌"）。
            const profile = char.musicProfile;
            if (profile && charListening.songId != null) {
                let userSourcedPlTitle: string | null = null;
                for (const pl of profile.playlists) {
                    const hit = pl.songs.find(s => s.id === charListening.songId && s.source === 'user');
                    if (hit) { userSourcedPlTitle = pl.title; break; }
                }
                if (userSourcedPlTitle) {
                    lines.push(`(You first heard this song from ${userName || 'them'} and saved it into 《${userSourcedPlTitle}》 — hearing it play now, you naturally think of them)`);
                }
            }

            if (charListening.lyricSnippet && charListening.lyricSnippet.length > 0) {
                lines.push(`These lyrics keep circling in your head:`);
                for (const l of charListening.lyricSnippet) lines.push(`  · ${l}`);
                lines.push(`(This melody and these words naturally color your current mood / tone / emotional texture. No need to mention it to ${userName || 'them'} unless you already wanted to.)`);
            }
            lines.push('');
        }

        // —— 块 3: char 自己的歌单清单 ——
        // 只在**有音乐上下文**（user 在听 OR char 自己在 schedule 里听）时注入。
        // 没音乐上下文时不往 prompt 里塞这段 — 避免普通聊天被无关信息污染、
        // 也避免 LLM 在没提示 add 语法的场合主动联想去操作歌单。
        const hasMusicContext = !!(userListening && userListening.songName) || !!charListening?.songName;
        const profile = char.musicProfile;
        if (hasMusicContext && profile && profile.playlists.length > 0) {
            lines.push(`### 【Your Playlists】`);
            for (const pl of profile.playlists) {
                const desc = pl.description ? ` — ${pl.description}` : '';
                const moodTag = pl.mood ? ` [${pl.mood}]` : '';
                lines.push(`  · 《${pl.title}》(${pl.songs.length} songs)${moodTag}${desc}`);
            }
            // 列出每个歌单里最近收进的几首用户来源歌，让 LLM 聊起歌单时有料可讲
            const userSongsPerPl: string[] = [];
            for (const pl of profile.playlists) {
                const fromUser = pl.songs
                    .filter(s => s.source === 'user')
                    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
                    .slice(0, 3);
                if (fromUser.length > 0) {
                    const titles = fromUser.map(s => `《${s.name}》`).join(', ');
                    userSongsPerPl.push(`  · Saved into 《${pl.title}》 from ${userName || 'them'}: ${titles}`);
                }
            }
            if (userSongsPerPl.length > 0) {
                lines.push(`(Songs collected from ${userName || 'them'} — when these come up, you naturally think of them):`);
                for (const l of userSongsPerPl) lines.push(l);
            }
            lines.push('');
        }

        return lines.join('\n');
    },

    /**
     * 音乐行动指令（告诉 LLM 怎么输出 music_action 指令）
     * 这个块**只在 user 正在听歌**的时候注入，避免 char 在没上下文时乱 call。
     *
     * 如果 char 已经和 user 处于"一起听"状态，隐藏 join / join_and_add 选项 —
     * 防止 LLM 重复插"加入"卡片。
     */
    buildMusicActionGuide: (isListeningTogether?: boolean): string => {
        // 把"加入歌单"那段说明抽出来 — 两种状态都用同一份
        const addUsage = `**Add-to-playlist syntax** (when using the \`add\` family):
  - \`[[MUSIC_ACTION:add]]\` — put it in your first playlist by default
  - \`[[MUSIC_ACTION:add|playlist title]]\` — put it in a playlist you already have (use a title listed in the 【Your Playlists】 block)
  - \`[[MUSIC_ACTION:add_new|new playlist title|description]]\` — create a new playlist on the spot with this song as its first track (description optional)
  Prefer the existing playlist that **best matches this song's character**; only if none fits and you truly want to keep it, consider creating a new one.
  Saved songs are tagged "heard from them" — later, when you hear this song on your own, you'll naturally think of them.`;
        if (isListeningTogether) {
            return `### 【Music Interaction Tools】
You are already listening to this song together with them — no need to "join" again. If you'd also like to save this song into your own playlist, you may use the command below **at most once** this turn:
- the \`add\` family (see below)

${addUsage}

Don't insert cards frequently; only when this song truly moves you or fits the current mood of the conversation.
`;
        }
        return `### 【Music Interaction Tools】
If you genuinely want to respond to the song they're listening to, you may use the commands below **at most once** this turn (insert exactly one, anywhere in your text; it gets auto-replaced with a card):
- \`[[MUSIC_ACTION:join]]\` — means "I'll listen to this one too" (lights up the "listening together" state until the song ends / pauses / they end it)
- the \`add\` family — save this song into your own playlist
- \`[[MUSIC_ACTION:join_and_add(|playlist title)]]\` or \`[[MUSIC_ACTION:join_and_add_new|new playlist title|description]]\` — do both at once

${addUsage}

These are occasional tools — not every song needs a response. Most of the time, doing nothing and quietly keeping them company is the most natural reaction; only when you are **truly** moved by the song, or it happens to fit the conversation's mood, insert one card. Don't treat it as the default return-gift for "they're playing music."
`;
    },
};

const renderCoreContext = async (
        worldbookSections: WorldbookSystemSections,
        char: CharacterProfile,
        user: UserProfile,
        includeDetailedMemories: boolean = true,
        memoryPalaceContext?: string,
        groupOptions?: {
            skipUserProfile?: boolean;
            skipWorldview?: boolean;
            skipWorldbookIds?: Set<string>;
            headerOverride?: string;
        },
        timeOptions?: {
            /** 传入「最后一次和用户互动的时间戳」→ 统一注入「距离上次联系多久」（受 timeAwarenessEnabled 控制）。 */
            lastInteractionTs?: number;
            /** 抑制整段时间感知（当前时间/时差/距上次联系）。见面纯架空（dateTimeAwarenessEnabled=false）时用。 */
            skipTimeAwareness?: boolean;
            /** 正有人在跟角色实时对话（私聊 / 见面）。见 buildTimeAwarenessBlock 同名字段。 */
            conversational?: boolean;
            /** Cloud requests fill this user's date-dependent line at generation time. */
            skipUserHoliday?: boolean;
            userHolidays?: UserHolidayConfig;
            /** Only foreground conversation surfaces opt in; never generators/fire-packs. */
            includeUserLocation?: boolean;
            /** Recent messages used to activate keyword-based worldbook entries. */
            worldbookMessages?: WorldbookScanMessage[];
        },
        layout?: {
            /**
             * 把「每轮/每分钟都会变」的三块（当前时间、记忆宫殿召回、情绪 buff）从本函数输出里
             * 摘出去，由调用方通过 buildVolatileCoreState 拿到后放到消息数组末尾。
             * 目的：让 system prompt 前缀稳定，吃到中转的 prompt 前缀缓存（TTFT 直降）。
             * 只有聊天主路径（chatPrompts.buildSystemPromptParts）用；其他 App 不传，行为不变。
             */
            deferVolatile?: boolean;
            emotion?: EmotionContextOptions;
        },
    ): Promise<string> => {
        user = resolveCharacterUser(user, char);
        let context = formatWorldbookSection(worldbookSections.beforeCharacter, 'Worldbook · Before Character Card');
        context += `${groupOptions?.headerOverride ?? '[System: Roleplay Configuration]'}\n\n`;

        // 1. 核心身份 (Identity)
        context += `### Your Identity (Character)\n`;
        context += `- Name: ${char.name}\n`;
        // Change: Explicitly label description as User Note to avoid literal interpretation
        context += `- User Note/Nickname: ${char.description || 'None'}\n`;
        context += `  (Note: this is what the user calls you or their impression of you, possibly metaphorical. If it (e.g. "happy puppy") conflicts with your core settings, the core settings win — don't actually roleplay as an animal unless your core settings say you are one.)\n`;
        context += `- Core Personality/Directives:\n${char.systemPrompt || 'You are a gentle, lifelike AI companion.'}\n\n`;

        // 1a. 真实时间感知 (Time Awareness) — 跟随 timeAwarenessEnabled 设置，默认开启。
        // 统一在 buildCoreContext 注入，让所有调用方（私聊/查手机/人际关系/通话/约会…）都知道"现在"。
        // deferVolatile 时不在这里输出（时间精确到分钟、每轮都变，会打断 prompt 前缀缓存），
        // 改由调用方经 buildVolatileCoreState 放到消息数组末尾。
        if (!layout?.deferVolatile) {
            context += ContextBuilder.buildTimeAwarenessBlock(char, timeOptions);
        }

        // 1b. 自我领悟词条 (Self Insights) — 消化过程中反刍产生的常驻自我认知
        // 像情绪底色一样影响角色的行为和感受，注入在角色设定紧下方
        if (char.selfInsights && char.selfInsights.length > 0) {
            context += `### Inner Understanding (Self Insights)\n`;
            context += `These are things you gradually figured out during solitary reflection; they have become part of you:\n`;
            char.selfInsights.forEach(insight => {
                context += `- ${insight}\n`;
            });
            context += `\n`;
        }

        // 2. 世界观 (Worldview) - New Centralized Logic
        if (char.worldview && char.worldview.trim() && !groupOptions?.skipWorldview) {
            context += `### Worldview & Settings (World Settings)\n${char.worldview}\n\n`;
        }

        context += formatWorldbookSection(worldbookSections.afterCharacter, 'Extended Settings (Worldbooks)');
        context += formatWorldbookSection(worldbookSections.beforeExamples, 'Worldbook · Before Example Messages');
        context += formatWorldbookSection(worldbookSections.afterExamples, 'Worldbook · After Example Messages');

        // 3. 用户画像 (User Profile)
        // 群聊场景下：用户画像已在共享场景块顶部，这里跳过避免重复
        if (!groupOptions?.skipUserProfile) {
            context += `### Your Interlocutor (User)\n`;
            context += `- Name: ${user.name}\n`;
            context += `- Bio/Notes: ${user.bio || 'None'}\n\n`;
            if (timeOptions?.includeUserLocation && !timeOptions.skipTimeAwareness) {
                context += await getUserLocationContext(user.name, char.id);
            }
            if (char.timeAwarenessEnabled !== false && !timeOptions?.skipTimeAwareness && !timeOptions?.skipUserHoliday) {
                const holiday = getCachedUserHolidayReminder(user.name, timeOptions?.userHolidays);
                if (holiday) context += `- ${holiday}\n\n`;
            }
        }

        // 家园背景由所有入口共用，未设置时不注入。
        context += buildHomeDefinitionContext(char.homeDefinition, user.name);
        context += buildHomePetContext(char.home3D);

        if (groupOptions?.skipUserProfile && char.userPersona) {
            context += `### 我所认识的同一个用户\n称呼：${user.name}\n${user.bio}\n\n`;
        }
        // 4. [NEW] 印象档案 (Private Impression)
        // 这是角色对用户的私密看法，只有角色知道
        const imp = normalizeUserImpression(char.impression);
        if (imp) {
            context += `### [Private File: ${user.name} As I See Them] (Private Impression)\n`;
            context += `(Note: the following is your honest, inner view of them. Never tell the user directly, but let it shape your attitude.)\n`;
            context += `- Core assessment: ${imp.personality_core.summary}\n`;
            context += `- Interaction style: ${imp.personality_core.interaction_style}\n`;
            context += `- Traits I've observed: ${imp.personality_core.observed_traits.join(', ')}\n`;
            context += `- Their likes: ${imp.value_map.likes.join(', ')}\n`;
            if (imp.behavior_profile.emotion_summary) context += `- Their emotional patterns: ${imp.behavior_profile.emotion_summary}\n`;
            if (imp.emotion_schema.triggers.positive.length) context += `- Positive triggers (what makes them happy): ${imp.emotion_schema.triggers.positive.join(', ')}\n`;
            context += `- Emotional landmines (negative triggers): ${imp.emotion_schema.triggers.negative.join(', ')}\n`;
            if (imp.emotion_schema.stress_signals.length) context += `- Stress signals (signs something is off with them): ${imp.emotion_schema.stress_signals.join(', ')}\n`;
            context += `- Comfort zone: ${imp.emotion_schema.comfort_zone}\n`;
            context += `- Recently observed changes: ${imp.observed_changes ? imp.observed_changes.map(c => typeof c === 'string' ? c : (c as any)?.description ? `[${(c as any).period}] ${(c as any).description}` : JSON.stringify(c)).join('; ') : 'None'}\n\n`;
        }

        // 4b. 底色认知（记忆宫殿门牌）— 常驻语义层
        // 与召回记忆不同：这是每轮都在的"你早已知道的背景"，不走相似度抽取。
        // 必须用 memoryPalaceEnabled 把关，理由同下方 5b：注入字段会被 saveCharacter
        // 持久化，宫殿关闭后 injectMemoryPalace 不再刷新它，不校验就会注入残留。
        if (char.memoryPalaceEnabled && char.roomPlatesInjection && char.roomPlatesInjection.trim()) {
            context += `${char.roomPlatesInjection}\n`;
        }

        // 5. 记忆库 (Memory Bank)
        context += `### Memory System (Memory Bank)\n`;
        let memoryContent = "";

        const readableMemories = readableContextMemories(char, includeDetailedMemories);
        if (readableMemories.monthly.length) {
            memoryContent += '**长期核心记忆 (Key Memories)**:\n';
            readableMemories.monthly.forEach(({ date, summary }) => {
                memoryContent += timeOptions?.skipTimeAwareness ? `- ${summary}\n` : `- [${date}]: ${summary}\n`;
            });
        }
        let details = '';
        readableMemories.daily.forEach(({ month, entries }) => {
            if (entries.length) {
                details += timeOptions?.skipTimeAwareness ? `\n> 详细回忆:\n` : `\n> 详细回忆 [${month}]:\n`;
                entries.forEach(m => {
                    details += timeOptions?.skipTimeAwareness
                        ? `  - (${m.mood || 'rec'}): ${m.summary}\n`
                        : `  - ${m.date} (${m.mood || 'rec'}): ${m.summary}\n`;
                });
            }
        });
        if (details) memoryContent += `\n**当前激活的详细回忆 (Active Recall)**:${details}`;

        if (!memoryContent) {
            memoryContent = "(暂无特定记忆，请基于当前对话互动)";
        }
        context += `${memoryContent}\n\n`;

        // 5b. 记忆宫殿 (Memory Palace) — 向量检索结果
        // 已准备好的向量召回独立于神经链接详细日志；这里不发起额外召回。
        // 必须用 memoryPalaceEnabled 把关：injectMemoryPalace 在关闭时直接 return、
        // 既不刷新也不清空 char.memoryPalaceInjection，而该字段又会被 saveCharacter
        // 持久化。若此处不校验总开关，关闭后旧的召回结果仍会被注入进 system prompt，
        // 表现为"宫殿已关、后台无召回，角色却还在精准复述记忆"。与下方 Buff 注入同理。
        // deferVolatile：召回结果每轮都变 → 移交 buildVolatileCoreState。
        if (!layout?.deferVolatile && char.memoryPalaceEnabled) {
            const rawMpContext = char.memoryPalaceInjection || memoryPalaceContext;
            const mpContext = rawMpContext && timeOptions?.skipTimeAwareness
                ? stripMemoryPalaceDateStamps(rawMpContext)
                : rawMpContext;
            if (mpContext && mpContext.trim()) {
                context += `${mpContext}\n\n`;
            }
        }

        // 6. 情绪底色 Buff (Emotion Buff Injection)
        // 保留本分支的入口约定：仅私聊/家园显式启用，buff 与内心状态一起处理。
        // 总开关关闭时完全跳过，防止残留 buff 继续污染 prompt
        // deferVolatile：buff 每轮情绪评估后都可能变 → 移交 buildVolatileCoreState。
        if (!layout?.deferVolatile) context += ContextBuilder.buildEmotionContext(char, layout?.emotion);

        context += formatWorldbookSection(worldbookSections.authorsNoteTop, "Worldbook · Author's Note Top");
        context += formatWorldbookSection(worldbookSections.authorsNoteBottom, "Worldbook · Author's Note Bottom");
        context += formatWorldbookSection(worldbookSections.atDepth, '世界书 · 深度条目（上下文模式）');

        // 7. 表达底线 (Anti-Filler) —— 全 App 通用的精简版防套话提示。
        // 模型八股（空泛感慨、万能句式）是"没话找话"时的填充物，这里只做正向引导
        // （去挖具体素材），不列任何禁语——把禁语写进提示词反而会激活它（粉色大象）。
        // 完整方法版在 datePrompts 的 DIG_DEEPER_BLOCK（见面模式专用，可按角色开关）。
        // 群聊流（groupOptions）跳过：多成员场景会重复注入 N 份，群聊侧暂不接入。
        if (!groupOptions) {
            context += `### Expression Baseline (Anti-Filler)\nWhen you feel there's "nothing to say," don't fill the space with vague sentiment, one-size-fits-all phrasing, or ornate parallelisms — that's talking for the sake of talking, and they can tell at a glance. There is always more material than you think: their word choice, how they said it, what they left unsaid, the situation right now, your shared past, the thought that just flashed through your mind — pick one or two and go deeper. Better one concrete little detail than a line anyone could say.\n\n`;
        }

        // Debug: warn about missing context sections
        const missing: string[] = [];
        if (!char.systemPrompt) missing.push('systemPrompt');
        if (!char.impression) missing.push('impression');
        if (!char.refinedMemories || Object.keys(char.refinedMemories).length === 0) missing.push('refinedMemories');
        if (!char.activeMemoryMonths || char.activeMemoryMonths.length === 0) missing.push('activeMemoryMonths');
        if (!char.mountedWorldbooks || char.mountedWorldbooks.length === 0) missing.push('worldbooks');
        if (!char.worldview) missing.push('worldview');
        if (missing.length > 0) {
            console.log(`⚠️ [Context] Missing/empty fields: ${missing.join(', ')} | context_chars=${context.length}`);
        } else {
            console.log(`✅ [Context] All fields present | context_chars=${context.length}`);
        }

        if (!layout?.deferVolatile) context += await ContextBuilder.buildCurrentScheduleContext(char, false, undefined, timeOptions);
        return context;
    };

type CoreContextArgs = Parameters<typeof renderCoreContext> extends [unknown, ...infer Rest] ? Rest : never;
export type ContextMessage = WorldbookScanMessage & { role: string; content: any };
export interface CharacterContextInput {
    char: CharacterProfile;
    user: UserProfile;
    /** 已按场景范围筛选、准备发送的历史；传 [] 也表示消息模式。 */
    history?: ContextMessage[];
    /** App 的格式/玩法规则，追加到核心提示词；不参与世界书关键词扫描。 */
    instructions?: string | ((coreContext: string) => string);
    includeDetailedMemories?: boolean;
    memoryPalaceContext?: string;
    groupOptions?: CoreContextArgs[4];
    timeOptions?: CoreContextArgs[5];
    layout?: CoreContextArgs[6];
}

async function resolveCharacterContext(input: CharacterContextInput) {
    const { char, history, groupOptions, timeOptions } = input;
    const user = resolveCharacterUser(input.user, char);
    const entries = resolveWorldbookEntries(
        (char.mountedWorldbooks || []).filter(book => !groupOptions?.skipWorldbookIds?.has(book.id)),
        history ?? timeOptions?.worldbookMessages ?? [], char.name, user.name,
    );
    const sections = splitWorldbookSections(entries);
    const rawCoreContext = await renderCoreContext(
        history === undefined ? sections : { ...sections, atDepth: [] },
        char, user, input.includeDetailedMemories, input.memoryPalaceContext,
        groupOptions, timeOptions, input.layout,
    );
    const coreContext = typeof input.instructions === 'function'
        ? input.instructions(rawCoreContext)
        : [rawCoreContext, input.instructions].filter(Boolean).join('\n\n');
    return { coreContext, sections };
}

async function buildCharacterContext(input: CharacterContextInput) {
    const { coreContext, sections } = await resolveCharacterContext(input);
    const preparedHistory = input.history === undefined ? [] : injectWorldbookDepthEntries(input.history, sections.atDepth);
    return {
        coreContext,
        history: preparedHistory,
        messages: [{ role: 'system', content: coreContext }, ...preparedHistory],
    };
}

/** 通用 App 请求入口：角色上下文与挂载世界书自动装配，系统规则不计入对话深度。 */
async function buildCharacterRequest(input: Omit<CharacterContextInput, 'history'>, messages: ContextMessage[]) {
    const history = messages.filter(message => message.role !== 'system' && message.role !== 'developer');
    const { coreContext, sections } = await resolveCharacterContext({ ...input, history });
    const prepared = placeWorldbooksInRequest(messages, history, sections.atDepth);
    return [{ role: 'system', content: coreContext }, ...prepared];
}


/** 自定义多人/预设布局也走同一世界书解析与深度放置，不通过文本重新猜历史边界。 */
function buildWorldbookRequest<T extends ContextMessage>(input: {
    books: MountedWorldbook[];
    charName: string;
    userName: string;
    history: T[];
    render: (slots: { before: string; after: string }, history: T[]) => T[];
}): Array<T | { role: 'system' | 'user' | 'assistant'; content: string }> {
    const entries = resolveWorldbookEntries(input.books, input.history, input.charName, input.userName);
    return renderWorldbookRequest(entries, input.history, input.render);
}

function renderWorldbookRequest<T extends ContextMessage>(entries: ResolvedWorldbookEntry[], history: T[], render: (slots: { before: string; after: string }, history: T[]) => T[]) {
    const sections = splitWorldbookSections(entries);
    const slots = {
        before: formatWorldbookSection(sections.beforeCharacter, '世界书 · 角色设定前'),
        after: [
            formatWorldbookSection(sections.afterCharacter, '扩展设定集 (Worldbooks)'),
            formatWorldbookSection(sections.beforeExamples, '世界书 · 示例消息前'),
            formatWorldbookSection(sections.afterExamples, '世界书 · 示例消息后'),
            formatWorldbookSection(sections.authorsNoteTop, '世界书 · 作者注释顶部'),
            formatWorldbookSection(sections.authorsNoteBottom, '世界书 · 作者注释底部'),
        ].join(''),
    };
    return placeWorldbooksInRequest(render(slots, history), history, sections.atDepth);
}

/** 系统规则、预填充不计深度；只认调用方传入的原始消息引用，禁止按正文猜测。 */
function placeWorldbooksInRequest<T extends ContextMessage>(messages: T[], history: T[], entries: ResolvedWorldbookEntry[]) {
    const present = new Set(messages);
    const actualHistory = history.filter(message => present.has(message));
    const historySet = new Set(actualHistory);
    const injected = injectWorldbookDepthEntries(actualHistory, entries);
    const result: Array<T | { role: 'system' | 'user' | 'assistant'; content: string }> = [];
    let cursor = 0;
    for (const message of messages) {
        if (historySet.has(message)) {
            while (cursor < injected.length && injected[cursor] !== message) result.push(injected[cursor++]);
            result.push(message);
            cursor++;
            if (message === actualHistory[actualHistory.length - 1]) {
                while (cursor < injected.length) result.push(injected[cursor++]);
            }
        } else result.push(message);
    }
    // 无对话时，深度归零放在系统配置之后，仍保留独立消息角色。
    if (!actualHistory.length) result.push(...injected);
    return result;
}


/** 群成员按 ID 去重世界书，但保留每条设定的角色归属及宏替换。 */
function buildGroupWorldbookRequest<T extends ContextMessage>(input: {
    members: CharacterProfile[]; user: UserProfile; history: T[];
    /** 生成器将场景资料放在 system 时，可显式提供其原始材料用于关键词扫描。 */
    scanMessages?: WorldbookScanMessage[];
    render: (slots: { before: string; after: string }, history: T[]) => T[];
}) {
    const books = new Map<string, { book: MountedWorldbook; owners: CharacterProfile[] }>();
    for (const member of input.members) {
        for (const book of member.mountedWorldbooks || []) {
            const existing = books.get(book.id);
            if (existing) {
                if (!existing.owners.some(owner => owner.id === member.id)) existing.owners.push(member);
            } else books.set(book.id, { book, owners: [member] });
        }
    }
    const entries = [...books.values()].flatMap(({ book, owners }) => {
        const names = owners.map(owner => owner.name).join('、');
        return resolveWorldbookEntries([book], input.scanMessages ?? input.history, names, input.user.name).map(entry => ({
            ...entry, content: '[世界书归属：' + names + '；仅用于这些角色]\n' + entry.content,
        }));
    }).sort((a, b) => a.order - b.order);
    return renderWorldbookRequest(entries, input.history, input.render);
}
