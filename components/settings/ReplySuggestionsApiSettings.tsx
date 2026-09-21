import React, { useEffect, useRef, useState } from 'react';
import type { APIConfig } from '../../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../../utils/apiConfigNormalize';
import { extractModelIds } from '../../utils/modelList';
import { safeFetchJson } from '../../utils/safeApi';
import Modal from '../os/Modal';

export default function ReplySuggestionsApiSettings({ config, onSave }: { config: APIConfig; onSave: (patch: Partial<APIConfig>) => void }) {
    const [draft, setDraft] = useState(config.replySuggestionsApi || { enabled: false, baseUrl: '', apiKey: '', model: '' });
    const [status, setStatus] = useState('');
    const [models, setModels] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [showModels, setShowModels] = useState(false);
    const [filter, setFilter] = useState('');
    const requestRef = useRef<AbortController | null>(null);
    useEffect(() => () => requestRef.current?.abort(), []);
    useEffect(() => { setDraft(config.replySuggestionsApi || { enabled: false, baseUrl: '', apiKey: '', model: '' }); }, [config.replySuggestionsApi]);
    useEffect(() => { requestRef.current?.abort(); setModels([]); setShowModels(false); setLoading(false); }, [draft.baseUrl, draft.apiKey]);
    const fetchModels = async () => {
        const baseUrl = normalizeApiBaseUrl(draft.baseUrl);
        const apiKey = normalizeApiCredential(draft.apiKey);
        if (!baseUrl || !apiKey) { setStatus('请先填写 URL 和 API Key'); return; }
        requestRef.current?.abort();
        const request = new AbortController();
        requestRef.current = request;
        setLoading(true); setStatus('正在拉取模型…');
        try {
            const data = await safeFetchJson(`${baseUrl}/models`, {
                method: 'GET', signal: request.signal,
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            }, 0, 15000);
            if (request.signal.aborted) return;
            const nextModels = extractModelIds(data);
            if (!nextModels.length) throw new Error('模型列表为空或格式不兼容');
            setModels(nextModels);
            setDraft(current => ({ ...current, model: nextModels.includes(current.model) ? current.model : nextModels[0] }));
            setFilter(''); setShowModels(true); setStatus(`获取到 ${nextModels.length} 个模型，请选择后保存`);
        } catch (e) {
            if (!request.signal.aborted) setStatus(`拉取失败：${e instanceof Error ? e.message : '请重试'}`);
        } finally { if (requestRef.current === request) setLoading(false); }
    };
    return <div className="bg-white rounded-2xl p-4 space-y-3">
        <h3 className="font-bold">备选回复 API</h3>
        <p className="text-xs text-slate-500">按用户档案中的性格和近期聊天生成三个回复选项，单聊、群聊通用。关闭独立 API 时使用主 API。</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e => { setDraft({ ...draft, enabled: e.target.checked }); setStatus(''); }} />使用独立 API</label>
        {(['baseUrl', 'apiKey'] as const).map((field, i) => <label key={field} className="block text-xs text-slate-500">
            {['API 地址（包含 /v1 等路径）', 'API Key'][i]}
            <input type={field === 'apiKey' ? 'password' : 'text'} autoComplete="off" value={draft[field]} onChange={e => { setDraft({ ...draft, [field]: e.target.value }); setStatus(''); }} className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm text-slate-800" />
        </label>)}
        <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">模型</span>
            <button type="button" disabled={loading} onClick={fetchModels} className="text-primary font-bold disabled:opacity-50">{loading ? '拉取中…' : '拉取模型列表'}</button>
        </div>
        <button type="button" onClick={() => setShowModels(true)} className="w-full text-left break-all rounded-lg border border-slate-200 p-2 text-sm">{draft.model || '选择或手动输入模型…'}</button>
        <button type="button" disabled={loading} className="text-primary text-sm font-bold disabled:opacity-50" onClick={() => {
            const next = { ...draft, baseUrl: normalizeApiBaseUrl(draft.baseUrl), apiKey: normalizeApiCredential(draft.apiKey), model: normalizeApiModel(draft.model) };
            if (next.enabled && (!next.baseUrl || !next.apiKey || !next.model)) { setStatus('请填写完整的 API 地址、密钥和模型'); return; }
            onSave({ replySuggestionsApi: next }); setStatus('已保存');
        }}>保存备选回复 API</button>
        {status && <p role="status" className="text-xs text-slate-500">{status}</p>}
        <Modal keyboardAware isOpen={showModels} title="选择备选回复模型" onClose={() => setShowModels(false)}>
            <div className="space-y-3">
                <label className="block text-xs text-slate-500">模型名称
                    <input aria-label="备选回复模型名称" value={draft.model} onChange={e => { setDraft({ ...draft, model: e.target.value }); setStatus(''); }} className="mt-1 w-full min-w-0 rounded-xl border p-3 text-base text-slate-800" />
                </label>
                <input aria-label="搜索备选回复模型" value={filter} onChange={e => setFilter(e.target.value)} placeholder={`搜索 ${models.length} 个模型…`} className="w-full min-w-0 rounded-xl border p-3 text-base" />
                <div className="max-h-[35vh] overflow-y-auto space-y-2">
                    {models.filter(model => model.toLowerCase().includes(filter.trim().toLowerCase())).map(model => <button type="button" key={model} onClick={() => { setDraft({ ...draft, model }); setShowModels(false); setStatus('已选择模型，请点击保存'); }} className={`block w-full p-3 rounded-xl text-left text-sm break-all ${model === draft.model ? 'bg-primary/10 text-primary' : 'bg-slate-50'}`}>{model}</button>)}
                    {!models.length && <p className="text-xs text-slate-500">可以手动填写，或关闭窗口后拉取模型列表。</p>}
                    {models.length > 0 && !models.some(model => model.toLowerCase().includes(filter.trim().toLowerCase())) && <p className="text-xs text-slate-500">没有匹配的模型</p>}
                </div>
                <button type="button" onClick={() => { setShowModels(false); setStatus('已选择模型，请点击保存'); }} className="w-full rounded-xl p-3 bg-primary text-white">确定</button>
            </div>
        </Modal>
    </div>;
}
