import React, { useEffect, useRef, useState } from 'react';
import type { APIConfig, CharacterProfile, Message, UserProfile } from '../../types';
import { generateReplySuggestions, REPLY_LABELS } from '../../utils/replySuggestions';

interface Props {
    config: APIConfig;
    user: UserProfile;
    characters: CharacterProfile[];
    groupName?: string;
    loadHistory: () => Promise<Message[]>;
    onSend: (text: string) => Promise<void>;
    disabled?: boolean;
}

export default function ReplySuggestions({ config, user, characters, groupName, loadHistory, onSend, disabled }: Props) {
    const [replies, setReplies] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const controller = useRef<AbortController | null>(null);
    const locked = useRef(false);
    useEffect(() => () => { controller.current?.abort(); }, []);
    const generate = async () => {
        if (locked.current) return;
        locked.current = true;
        setBusy(true); setError(''); setReplies([]);
        const request = new AbortController();
        controller.current = request;
        try {
            const history = await loadHistory();
            if (request.signal.aborted) return;
            const result = await generateReplySuggestions(config, user, characters, history, groupName, request.signal);
            if (!request.signal.aborted) setReplies(result);
        } catch (e) {
            if (!request.signal.aborted) setError(e instanceof Error ? e.message : '生成失败，请重试');
        } finally { locked.current = false; setBusy(false); }
    };
    const send = async (text: string) => {
        if (locked.current) return;
        locked.current = true; setBusy(true); setError('');
        try { await onSend(text); setReplies([]); }
        catch { setError('发送失败，请重试'); }
        finally { locked.current = false; setBusy(false); }
    };
    return <div className="px-3 py-2 border-t border-slate-200 bg-white/95 shrink-0">
        <div className="flex items-center justify-between gap-2 text-xs">
            <button type="button" onClick={generate} disabled={busy || disabled} className="text-primary font-bold disabled:opacity-50">{busy ? '处理中…' : replies.length ? '重新生成备选回复' : '生成备选回复'}</button>
            {replies.length > 0 && <button type="button" disabled={busy} onClick={() => setReplies([])} className="text-slate-500">收起</button>}
        </div>
        {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
        {replies.length > 0 && <div className="mt-2 max-h-60 overflow-y-auto space-y-2">
            <p className="text-xs text-slate-500">点击一个选项发送；不会立即触发对方回复。</p>
            {replies.map((text, i) => <button type="button" key={i} disabled={busy || disabled} onClick={() => send(text)} className="block w-full rounded-xl bg-slate-50 p-2 text-left disabled:opacity-50">
                <span className="block text-xs font-bold text-primary">{i + 1}. {REPLY_LABELS[i]}</span>
                <span className="block text-sm whitespace-pre-wrap break-words text-slate-700">{text}</span>
            </button>)}
        </div>}
    </div>;
}
