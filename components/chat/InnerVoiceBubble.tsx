import React, { useRef, useState } from 'react';
import Modal from '../os/Modal';

/** 独立交互区域；心声仍保存在 metadata，不变成会被角色读到的正文。 */
export default function InnerVoiceBubble({ voice, onSave }: { voice: string; onSave?: (voice: string) => Promise<void> }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const locked = useRef(false);
    const open = () => { if (onSave) { setDraft(voice); setError(''); setEditing(true); } };
    const save = async () => {
        if (!onSave || locked.current) return;
        if (!draft.trim()) { setError('心声不能为空'); return; }
        locked.current = true; setSaving(true); setError('');
        try { await onSave(draft.trim()); setEditing(false); }
        catch { setError('保存失败，请重试'); }
        finally { locked.current = false; setSaving(false); }
    };
    if (!voice.trim()) return null;
    return <div className="sully-inner-voice-row px-3 mb-3 flex justify-start" onClick={e => e.stopPropagation()}>
        <button type="button" aria-label="编辑心声" disabled={!onSave} onClick={open}
            onContextMenu={e => { e.preventDefault(); open(); }}
            className="ml-12 max-w-[72%] text-left rounded-2xl border border-slate-200 bg-transparent px-3 py-2 shadow-sm focus-visible:ring-2 focus-visible:ring-primary">
            <span className="block text-xs font-bold text-slate-500 mb-1">💭 心声</span>
            <span className="block text-sm text-slate-700 whitespace-pre-wrap break-words">{voice}</span>
        </button>
        <Modal keyboardAware isOpen={editing} title="编辑心声" onClose={() => { if (!saving) setEditing(false); }} footer={
            <>
                <button type="button" disabled={saving} onClick={() => setEditing(false)} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-600">取消</button>
                <button type="button" disabled={saving} onClick={save} className="flex-1 py-3 rounded-2xl bg-primary text-white">{saving ? '保存中…' : '保存'}</button>
            </>
        }>
            <textarea aria-label="心声内容" value={draft} onChange={e => setDraft(e.target.value)} disabled={saving} rows={5} className="w-full border border-slate-200 rounded-xl p-3 text-base text-slate-800 resize-y" />
            {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        </Modal>
    </div>;
}
