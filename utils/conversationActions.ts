import { Message } from '../types';
import { DB } from './db';

export const isSilent = (text: string) => /\[\[ACTION:(?:SILENT|LEAVE_ON_READ)\]\]/i.test(text);

export function conversationBlocked(messages: Message[]) {
    const state = { user: false, assistant: false };
    for (const m of messages) {
        const action = m.metadata?.conversationAction;
        if ((m.role === 'user' || m.role === 'assistant') && (action === 'block' || action === 'unblock')) {
            state[m.role] = action === 'block';
        }
    }
    return state.user || state.assistant;
}

/** N is one-based within the latest contiguous turn by the requested speaker. */
export function latestTurnMessage(messages: Message[], role: 'user' | 'assistant', n: number) {
    const visible = messages.filter(m => m.role !== 'system' && !m.metadata?.conversationAction);
    const end = visible.map(m => m.role).lastIndexOf(role);
    if (end < 0 || !Number.isInteger(n) || n < 1) return undefined;
    let start = end;
    while (start > 0 && visible[start - 1].role === role) start--;
    return n <= end - start + 1 ? visible[start + n - 1] : undefined;
}

export async function executeConversationActions(text: string, charId: string, role: 'user' | 'assistant', timestamp?: number, metadata?: Record<string, any>) {
    if (!/\[\[ACTION:(?:SILENT|LEAVE_ON_READ|BLOCK|UNBLOCK|REACT)/i.test(text)) return text;
    const history = (await DB.getMessagesByCharId(charId, true)).filter(m => timestamp == null || m.timestamp <= timestamp);
    const save = (action: string, content: string, target?: Message) => DB.saveMessage({
        charId, role, type: 'system', content, timestamp,
        metadata: { ...metadata, conversationAction: action, targetMessageId: target?.id },
        ...(target ? { replyTo: { id: target.id, content: target.content, name: target.role === 'user' ? 'user' : 'char' } } : {}),
    });
    const actor = role === 'user' ? 'user' : 'char';
    if (isSilent(text)) {
        await save('silent', `[${actor} 已读不回]`);
        return '';
    }
    for (const match of text.matchAll(/\[\[ACTION:(BLOCK|UNBLOCK)\]\]/gi)) {
        await save(match[1].toLowerCase(), `[${actor} ${match[1].toUpperCase() === 'BLOCK' ? '已拉黑对方' : '已解除拉黑'}]`);
    }
    for (const match of text.matchAll(/\[\[ACTION:REACT\|(user|char)\|(\d+)\|([^\]\r\n]+)\]\]/gi)) {
        const target = latestTurnMessage(history, match[1].toLowerCase() === 'user' ? 'user' : 'assistant', Number(match[2]));
        const emoji = match[3].trim();
        if (target && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(emoji)) {
            await save('react', `[${actor} 对 ${match[1]} 的消息「${target.content.slice(0, 100)}」回应了 ${emoji}]`, target);
        }
    }
    return text.replace(/\[\[ACTION:(?:BLOCK|UNBLOCK|REACT\|[^\]\r\n]*)\]\]/gi, '').trim();
}
