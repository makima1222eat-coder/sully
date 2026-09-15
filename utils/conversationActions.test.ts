import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DB } from './db';
import { conversationBlocked, latestTurnMessage, executeConversationActions, reactToSelectedMessage } from './conversationActions';
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

describe('selected message reactions', () => {
 it('targets an older message by ID even after newer turns arrive', async () => {
  vi.mocked(DB.getMessagesByCharId).mockResolvedValue([msg(1,'assistant'),msg(2,'user'),msg(3,'assistant')]);
  await reactToSelectedMessage('c',1,'❤️😂');
  expect(DB.saveMessage).toHaveBeenCalledWith(expect.objectContaining({role:'user', replyTo:expect.objectContaining({id:1}), metadata:expect.objectContaining({targetMessageId:1})}));
 });
 it('allows reacting to the user own message', async () => {
  await reactToSelectedMessage('c',1,'👍');
  expect(DB.saveMessage).toHaveBeenCalledWith(expect.objectContaining({replyTo:expect.objectContaining({id:1,name:'user'})}));
 });
 it('rejects deleted targets without redirecting to a newer message', async () => {
  await expect(reactToSelectedMessage('c',99,'❤️')).rejects.toThrow('不存在');
  expect(DB.saveMessage).not.toHaveBeenCalled();
 });
 it('preserves block restrictions', async () => {
  vi.mocked(DB.getMessagesByCharId).mockResolvedValue([msg(1,'assistant'),msg(2,'user','block')]);
  await expect(reactToSelectedMessage('c',1,'❤️')).rejects.toThrow('拉黑');
  expect(DB.saveMessage).not.toHaveBeenCalled();
 });
 it('rejects non-emoji input', async () => {
  await expect(reactToSelectedMessage('c',1,'hello')).rejects.toThrow('表情');
  expect(DB.saveMessage).not.toHaveBeenCalled();
 });
});
