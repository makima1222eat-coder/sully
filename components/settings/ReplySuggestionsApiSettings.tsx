import React, { useEffect, useState } from 'react';
import type { APIConfig } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';

export default function ReplySuggestionsApiSettings({ config, onSave }: { config: APIConfig; onSave: (patch: Partial<APIConfig>) => void }) {
    const [draft, setDraft] = useState(config.replySuggestionsApi || { enabled: false, baseUrl: '', apiKey: '', model: '' });
    const [status, setStatus] = useState('');
    useEffect(() => { setDraft(config.replySuggestionsApi || { enabled: false, baseUrl: '', apiKey: '', model: '' }); }, [config.replySuggestionsApi]);
    return <div className="bg-white rounded-2xl p-4 space-y-3">
        <h3 className="font-bold">备选回复 API</h3>
        <p className="text-xs text-slate-500">按用户档案中的性格和近期聊天生成三个回复选项，单聊、群聊通用。关闭独立 API 时使用主 API。</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e => { setDraft({ ...draft, enabled: e.target.checked }); setStatus(''); }} />使用独立 API</label>
        {(['baseUrl', 'apiKey', 'model'] as const).map((field, i) => <label key={field} className="block text-xs text-slate-500">
            {['API 地址（包含 /v1 等路径）', 'API Key', '模型名称'][i]}
            <input type={field === 'apiKey' ? 'password' : 'text'} autoComplete="off" value={draft[field]} onChange={e => { setDraft({ ...draft, [field]: e.target.value }); setStatus(''); }} className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm text-slate-800" />
        </label>)}
        <button type="button" className="text-primary text-sm font-bold" onClick={() => {
            const next = { ...draft, baseUrl: normalizeApiBaseUrl(draft.baseUrl), apiKey: normalizeApiCredential(draft.apiKey), model: normalizeApiModel(draft.model) };
            if (next.enabled && (!next.baseUrl || !next.apiKey || !next.model)) { setStatus('请填写完整的 API 地址、密钥和模型'); return; }
            onSave({ replySuggestionsApi: next }); setStatus('已保存');
        }}>保存备选回复 API</button>
        {status && <p role="status" className="text-xs text-slate-500">{status}</p>}
    </div>;
}
