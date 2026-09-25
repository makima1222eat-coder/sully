import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { APIConfig, CharacterProfile, Message, UserProfile } from '../../types';
import { generateReplySuggestions, REPLY_LABELS, type ReplySuggestion } from '../../utils/replySuggestions';

interface Props {
    config: APIConfig;
    user: UserProfile;
    characters: CharacterProfile[];
    groupName?: string;
    loadHistory: () => Promise<Message[]>;
    onSend: (text: string, bubbleIndex: number) => Promise<void>;
    disabled?: boolean;
    /** 选项进入聊天滚动区，触发按钮仍在输入区。 */
    optionsTarget?: HTMLElement | null;
    historyRevision?: number;
}

export default function ReplySuggestions({ config, user, characters, groupName, loadHistory, onSend, disabled, optionsTarget, historyRevision }: Props) {
    const [replies, setReplies] = useState<ReplySuggestion[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState<number | null>(null);
    const [sentCount, setSentCount] = useState(0);
    const progress = useRef(0);
    const sending = useRef(false);
    const mounted = useRef(true);
    const optionsRef = useRef<HTMLDivElement>(null);
    const controller = useRef<AbortController | null>(null);
    const locked = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; controller.current?.abort(); };
    }, []);
    useEffect(() => {
        // 自己逐条发送时不清空进度；外部消息变化时撤回过期选项。
        if (sending.current) return;
        controller.current?.abort();
        locked.current = false;
        setBusy(false); setReplies([]); setSelected(null); setSentCount(0); setError('');
        progress.current = 0;
    }, [historyRevision]);
    useEffect(() => {
        if (replies.length) optionsRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }, [replies]);
    const generate = async () => {
        if (locked.current) return;
        locked.current = true;
        setBusy(true); setError(''); setReplies([]); setSelected(null); setSentCount(0); progress.current = 0;
        const request = new AbortController();
        controller.current = request;
        try {
            const history = await loadHistory();
            if (request.signal.aborted) return;
            const result = await generateReplySuggestions(config, user, characters, history, groupName, request.signal);
            if (!request.signal.aborted) setReplies(result);
        } catch (e) {
            if (!request.signal.aborted) setError(e instanceof Error ? e.message : '生成失败，请重试');
        } finally {
            if (controller.current === request && !request.signal.aborted && mounted.current) { locked.current = false; setBusy(false); }
        }
    };
    const send = async (index: number) => {
        if (locked.current || disabled || (selected !== null && selected !== index)) return;
        locked.current = true; sending.current = true;
        setSelected(index); setBusy(true); setError('');
        try {
            const bubbles = replies[index];
            while (progress.current < bubbles.length && mounted.current) {
                await onSend(bubbles[progress.current], progress.current);
                progress.current += 1;
                if (mounted.current) setSentCount(progress.current);
            }
            if (mounted.current) { setReplies([]); setSelected(null); }
        } catch {
            if (mounted.current) setError('发送未完成，点击所选选项重试剩余消息');
        } finally {
            sending.current = false; locked.current = false;
            if (mounted.current) setBusy(false);
        }
    };
    const options = replies.length > 0 && <div ref={optionsRef} className="px-4 py-3 space-y-3" aria-label="备选回复选项">
        <p className="text-xs text-slate-500 text-right">{selected === null ? '选择一组发送，不会立即触发对方回复' : busy ? '已选择 · 正在发送这一组' : '已选择 · 点击重试剩余消息'}</p>
        {replies.map((bubbles, i) => (selected === null || selected === i) && <button type="button" key={i} disabled={busy || disabled} onClick={() => send(i)} style={{ opacity: 1 }} className="block w-full rounded-2xl border border-transparent bg-transparent p-3 text-right disabled:cursor-wait">
            <span className="block text-xs font-bold text-primary mb-2">{i + 1}. {REPLY_LABELS[i]}{selected === i ? ' · 已选择' : ''}</span>
            <span className="flex flex-col items-end gap-2">
                {bubbles.slice(selected === i ? sentCount : 0).map((text, bubbleIndex) => <span key={bubbleIndex} style={{ opacity: 1, color: '#334155' }} className="max-w-[90%] rounded-2xl rounded-tr-sm bg-slate-100 px-3 py-2 text-left text-sm whitespace-pre-wrap break-words">{text}</span>)}
            </span>
        </button>)}
    </div>;
    return <div className="px-3 py-2 border-t border-slate-200 bg-white/95 shrink-0">
        <div className="flex items-center justify-between gap-2 text-xs">
            <button type="button" onClick={generate} disabled={busy || disabled || selected !== null} className="text-primary font-bold disabled:opacity-50">{busy ? selected === null ? '生成中…' : '发送中…' : replies.length ? '重新生成备选回复' : '生成备选回复'}</button>
            {replies.length > 0 && selected === null && <button type="button" disabled={busy} onClick={() => setReplies([])} className="text-slate-500">收起</button>}
        </div>
        {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
        {optionsTarget ? createPortal(options, optionsTarget) : options}
    </div>;
}
