// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ReplySuggestionsApiSettings from '../components/settings/ReplySuggestionsApiSettings';
import Modal from '../components/os/Modal';
import { safeFetchJson } from './safeApi';
import type { APIConfig } from '../types';

vi.mock('./safeApi', () => ({ safeFetchJson: vi.fn() }));

it('使用备选 API URL 和 Key 拉取模型，选择后显式保存且不修改主 API', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(safeFetchJson).mockResolvedValue({ data: [{ id: 'model-one' }, { id: 'model-two' }] });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn();
    const config = { baseUrl: 'https://main.test', apiKey: 'main-key', model: 'main-model', replySuggestionsApi: {
        enabled: true, baseUrl: 'https://suggest.test/v1/', apiKey: 'suggest-key', model: '',
    } } as APIConfig;
    try {
        await act(async () => root.render(React.createElement(ReplySuggestionsApiSettings, { config, onSave })));
        await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === '拉取模型列表')!.click());
        expect(safeFetchJson).toHaveBeenCalledWith('https://suggest.test/v1/models', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer suggest-key' }) }), 0, 15000);
        expect(onSave).not.toHaveBeenCalled();
        const dialog = document.querySelector('[role="dialog"]')!;
        expect(dialog.textContent).toContain('model-one');
        await act(async () => Array.from(dialog.querySelectorAll('button')).find(b => b.textContent === 'model-two')!.click());
        expect(onSave).not.toHaveBeenCalled();
        await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === '保存备选回复 API')!.click());
        expect(onSave).toHaveBeenCalledWith({ replySuggestionsApi: { enabled: true, baseUrl: 'https://suggest.test/v1', apiKey: 'suggest-key', model: 'model-two' } });
    } finally { await act(async () => root.unmount()); container.remove(); }
});

it('空模型列表给出错误且不覆盖原配置', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(safeFetchJson).mockResolvedValue({ data: [] });
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSave = vi.fn();
    try {
        await act(async () => root.render(React.createElement(ReplySuggestionsApiSettings, { config: { replySuggestionsApi: { enabled: true, baseUrl: 'https://suggest.test', apiKey: 'key', model: 'saved-model' } } as APIConfig, onSave })));
        await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === '拉取模型列表')!.click());
        expect(container.textContent).toContain('模型列表为空');
        expect(container.textContent).toContain('saved-model');
        expect(onSave).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
});

it('模型弹窗跟随键盘后的可见高度和偏移，关闭时移除监听', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const viewport = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, height: 800, width: 390 });
    const remove = vi.spyOn(viewport, 'removeEventListener');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(React.createElement(Modal, { keyboardAware: true, isOpen: true, title: '选择模型', onClose: vi.fn(), children: React.createElement('input') })));
        const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
        const overlay = dialog.parentElement!;
        expect(overlay.parentElement).toBe(document.body);
        expect(overlay.style.height).toBe('800px');
        await act(async () => { viewport.height = 320; viewport.offsetTop = 45; viewport.dispatchEvent(new Event('resize')); });
        expect(overlay.style.height).toBe('320px');
        expect(overlay.style.top).toBe('45px');
        expect(dialog.classList.contains('max-h-full')).toBe(true);
        await act(async () => { viewport.offsetTop = 60; viewport.dispatchEvent(new Event('scroll')); });
        expect(overlay.style.top).toBe('60px');
    } finally {
        await act(async () => root.unmount());
        if (original) Object.defineProperty(window, 'visualViewport', original);
        else delete (window as any).visualViewport;
    }
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
});
