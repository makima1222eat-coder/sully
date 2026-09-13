import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DB } from './db';
import { conversationBlocked, latestTurnMessage, executeConversationActions } from './conversationActions';
import { Message } from '../types';
vi.mock('./db', () => ({ DB: { getMessagesByCharId: vi.fn(), saveMessage: vi.fn() } }));
const msg = (id: number, role: Message['role'], action?: string): Message => ({ id, role, charId: 'c', type: 'text', content: 'message ' + id, timestamp: id, metadata: action ? { conversationAction: action } : undefined });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(DB.getMessagesByCharId).mockResolvedValue([msg(1, 'user'), msg(2, 'assistant'), msg(3, 'assistant')]); });
describe('conversation actions', () => {
 it('indexes the latest speaker turn from one and rejects out of range', () => {
 const history = [msg(1,'user'),msg(2,'assistant'),msg(3,'assistant'),msg(4,'user')];
 expect(latestTurnMessage(history,'assistant',2)?.id).toBe(3);
 expect(latestTurnMessage(history,'assistant',3)).toBeUndefined();
 expect(latestTurnMessage(history,'user',1)?.id).toBe(4);
 expect(latestTurnMessage(history,'user',0)).toBeUndefined();
 });
 it('requires both participants to remove their own blocks', () => {
 expect(conversationBlocked([msg(1,'user','block'),msg(2,'assistant','unblock')])).toBe(true);
 expect(conversationBlocked([msg(1,'user','block'),msg(2,'user','unblock')])).toBe(false);
 });
 it('silent suppresses text and all other actions', async () => {
 expect(await executeConversationActions('hello [[ACTION:BLOCK]][[ACTION:SILENT]]','c','assistant')).toBe('');
 expect(DB.saveMessage).toHaveBeenCalledTimes(1);
 expect(DB.saveMessage).toHaveBeenCalledWith(expect.objectContaining({metadata: expect.objectContaining({conversationAction:'silent'})}));
 });
 it('reacts to a concrete message and preserves combined text', async () => {
 expect(await executeConversationActions('hi [[ACTION:REACT|char|2|❤️😂]]','c','user')).toBe('hi');
 expect(DB.saveMessage).toHaveBeenCalledWith(expect.objectContaining({replyTo: expect.objectContaining({id:3})}));
 });
 it('ignores invalid targets', async () => {
 await executeConversationActions('[[ACTION:REACT|char|9|❤️]]','c','user');
 expect(DB.saveMessage).not.toHaveBeenCalled();
 });
});
