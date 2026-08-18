/// <reference types="vitest" />
/**
 * utils/iosStandalone.keyboard.test.ts — 键盘态布局的回归守卫。
 *
 * 背景：iOS 全屏 PWA 下 body 高度会比可视区多出一段底部安全区（给 home 条留位），
 * `.ios-keyboard-open` 一挂，外壳就铺到那段溢出区、聊天输入栏同时收掉自己的让位间隙。
 * 两个动作合起来净位移为 0，前提是「标记挂上」和「app 高度收到键盘上方」同时发生。
 * 只要有一边先动，输入条就整条沉出屏幕、home 条骑到输入框上。
 *
 * 这里钉住的不变式：键盘态只认 visualViewport 真的变矮，不认焦点事件。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SCREEN_H = 852; // 竖屏可视高度
const SAFE_BOTTOM = 34; // home 条安全区
const SAFE_TOP = 44;
const KEYBOARD_H = 336;

type Listener = () => void;
let vvListeners: Record<string, Listener[]>;
let visualViewport: { height: number; offsetTop: number; addEventListener: (t: string, fn: Listener) => void; removeEventListener: () => void };

const setupIOSStandalone = () => {
    vvListeners = { resize: [], scroll: [] };
    visualViewport = {
        height: SCREEN_H,
        offsetTop: 0,
        addEventListener: (type: string, fn: Listener) => { (vvListeners[type] ||= []).push(fn); },
        removeEventListener: () => {},
    };
    Object.defineProperty(window, 'visualViewport', { value: visualViewport, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: SCREEN_H, configurable: true, writable: true });
    Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
        configurable: true,
    });
    window.matchMedia = ((query: string) => ({
        matches: query.includes('standalone'),
        media: query,
        onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    window.scrollTo = vi.fn() as typeof window.scrollTo;

    // jsdom 不认 env()，安全区探针会读到 0，那段 34px 溢出区就不存在、用例也就测不到错位。
    // 认出探针（fixed + hidden 的临时 div）后返回真机数值，其余元素照常走 jsdom。
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element, pseudo?: string | null) => {
        const style = (el as HTMLElement).style;
        if (style?.position === 'fixed' && style?.visibility === 'hidden') {
            return { paddingTop: `${SAFE_TOP}px`, paddingBottom: `${SAFE_BOTTOM}px` } as CSSStyleDeclaration;
        }
        return realGetComputedStyle(el as Element, pseudo as string | undefined);
    }) as typeof window.getComputedStyle);
};

/** 重新加载模块再装载，绕开「只装一次」的单例标志，顺带清掉基线高度等模块级状态。 */
const install = async () => {
    vi.resetModules();
    const mod = await import('./iosStandalone');
    mod.installIOSStandaloneWorkaround();
    return mod;
};

const emitViewportResize = (height: number) => {
    visualViewport.height = height;
    vvListeners.resize.forEach(fn => fn());
};

const focusTextarea = () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    return textarea;
};

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');
const inKeyboardMode = () => document.body.classList.contains('ios-keyboard-open');

describe('iOS 全屏 PWA 键盘态', () => {
    beforeEach(() => {
        document.body.className = '';
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('style');
        setupIOSStandalone();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('无键盘时 app 高度 = 可视高度 + 底部安全区（那段溢出区留给 home 条）', async () => {
        await install();
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
        expect(inKeyboardMode()).toBe(false);
    });

    // 回归守卫：输入框拿到焦点不等于键盘弹出来了。设备上键盘弹不出来时（外接键盘、输入法异常），
    // 旧实现照样挂标记，外壳铺到那 34px 溢出区、输入栏又收掉让位间隙，输入条整条沉出屏幕。
    it('焦点进来但可视区没变矮 → 不进键盘态，高度不动', async () => {
        await install();
        focusTextarea();

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });

    it('可视区真的变矮 → 标记和高度一起进键盘态', async () => {
        await install();
        focusTextarea();
        emitViewportResize(SCREEN_H - KEYBOARD_H);

        expect(inKeyboardMode()).toBe(true);
        expect(appHeight()).toBe(`${SCREEN_H - KEYBOARD_H}px`);
    });

    // 回归守卫：聚焦中的输入框被 React 卸载时（退出聊天页），WebKit 不派发 focusout。
    // 旧实现只有 focusout 能摘标记，于是标记永久卡在 body 上，全局界面底部一直错位。
    it('输入框被直接移除、没有 focusout → 键盘收起后标记不残留', async () => {
        await install();
        const textarea = focusTextarea();
        emitViewportResize(SCREEN_H - KEYBOARD_H);
        expect(inKeyboardMode()).toBe(true);

        textarea.remove();
        emitViewportResize(SCREEN_H);

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });

    it('键盘动画期可视高度报脏值 → 退化成无键盘态，不把布局撑崩', async () => {
        await install();
        focusTextarea();
        emitViewportResize(80);

        expect(inKeyboardMode()).toBe(false);
        expect(appHeight()).toBe(`${SCREEN_H + SAFE_BOTTOM}px`);
    });
});

/**
 * 键盘态会把非可滚区的 touchmove 全部 preventDefault，防 iOS 把整页顶飞。
 * 但「在输入框里拖光标」走的也是落在输入框上的 touchmove——一起拦掉之后，
 * 双击选词、长按全选还在（不需要拖），光标却拖不动了。
 */
describe('键盘态 touchmove 锁：输入框内的拖动要放行', () => {
    beforeEach(() => {
        document.body.className = '';
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('style');
        setupIOSStandalone();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** 进键盘态后在 el 上发一个可取消的 touchmove，返回是否被拦下。 */
    const touchMoveBlocked = (el: Element): boolean => {
        const event = new Event('touchmove', { bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        return event.defaultPrevented;
    };

    const enterKeyboardMode = async () => {
        await install();
        focusTextarea().remove();          // 只为触发一次重算，元素本身不参与用例
        emitViewportResize(SCREEN_H - KEYBOARD_H);
        expect(inKeyboardMode()).toBe(true);
    };

    it('聊天输入栏这类不在可滚区里的 textarea：拖动放行', async () => {
        await enterKeyboardMode();
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        expect(touchMoveBlocked(textarea)).toBe(false);
    });

    it('记忆宫殿那种内联 overflowY 的编辑框（选择器命中不了）：拖动同样放行', async () => {
        await enterKeyboardMode();
        const panel = document.createElement('div');
        panel.style.overflowY = 'auto';    // 内联样式，不是 .overflow-y-auto 类
        const textarea = document.createElement('textarea');
        panel.appendChild(textarea);
        document.body.appendChild(panel);

        expect(touchMoveBlocked(textarea)).toBe(false);
    });

    it('单行 input 和 contenteditable 一样放行', async () => {
        await enterKeyboardMode();
        const input = document.createElement('input');
        const editable = document.createElement('div');
        editable.setAttribute('contenteditable', 'true');
        const span = document.createElement('span');   // 拖动可能落在子节点上
        editable.appendChild(span);
        document.body.append(input, editable);

        expect(touchMoveBlocked(input)).toBe(false);
        expect(touchMoveBlocked(span)).toBe(false);
    });

    it('输入框以外仍然锁死，可滚区仍然放行', async () => {
        await enterKeyboardMode();
        const plain = document.createElement('div');
        const scroller = document.createElement('div');
        scroller.className = 'overflow-y-auto';
        const row = document.createElement('div');
        scroller.appendChild(row);
        document.body.append(plain, scroller);

        expect(touchMoveBlocked(plain)).toBe(true);
        expect(touchMoveBlocked(row)).toBe(false);
    });

    it('没进键盘态时一律不拦', async () => {
        await install();
        const plain = document.createElement('div');
        document.body.appendChild(plain);

        expect(inKeyboardMode()).toBe(false);
        expect(touchMoveBlocked(plain)).toBe(false);
    });
});
