import React, { useRef, useState } from 'react';

export default function MessageReactionPicker({ onSubmit }: { onSubmit: (emojis: string) => Promise<void> }) {
    const [open, setOpen] = useState(false);
    const [emojis, setEmojis] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const submitting = useRef(false);
    if (!open) return (
        <button onClick={() => setOpen(true)} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100">
            添加反应
        </button>
    );
    return (
        <form className="space-y-3 rounded-2xl bg-slate-50 p-3" onSubmit={async e => {
            e.preventDefault();
            if (submitting.current || !emojis.trim()) return;
            submitting.current = true;
            setSaving(true);
            setError('');
            try { await onSubmit(emojis); }
            catch (err) { setError(err instanceof Error ? err.message : '添加反应失败，请重试'); }
            finally { submitting.current = false; setSaving(false); }
        }}>
            <p className="text-sm text-slate-600">为这条消息添加反应</p>
            <div className="flex flex-wrap gap-2">
                {['❤️', '😂', '🥰', '👍', '😭', '😮', '😡', '🎉'].map(emoji => (
                    <button key={emoji} type="button" aria-label={`添加 ${emoji}`} disabled={saving} onClick={() => setEmojis(value => (value + emoji).slice(0, 100))} className="rounded-xl bg-white p-2 text-xl active:scale-95 disabled:opacity-50">{emoji}</button>
                ))}
            </div>
            <input aria-label="反应表情" placeholder="选择或输入表情，可组合多个" value={emojis} maxLength={100} disabled={saving} onChange={e => setEmojis(e.target.value)} className="w-full rounded-xl border border-slate-200 bg-white p-3 text-slate-800" />
            {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2">
                <button type="button" disabled={saving} onClick={() => setOpen(false)} className="flex-1 py-2 text-slate-600">取消</button>
                <button type="submit" disabled={saving || !emojis.trim()} className="flex-1 rounded-xl bg-primary py-2 text-white disabled:opacity-50">{saving ? '添加中…' : '添加反应'}</button>
            </div>
        </form>
    );
}
