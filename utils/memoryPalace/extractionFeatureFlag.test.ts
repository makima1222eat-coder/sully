import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../types';
import { safeFetchJson } from '../safeApi';
import { extractMemoriesFromBuffer } from './extraction';

vi.mock('../safeApi', () => ({
    safeFetchJson: vi.fn(),
}));

const mockedSafeFetchJson = vi.mocked(safeFetchJson);
const messages: Message[] = [{
    id: 1,
    charId: 'char-extraction-flags',
    role: 'user',
    type: 'text',
    content: '今天我和雾岚去了上海。',
    timestamp: new Date('2026-08-17T12:00:00+08:00').getTime(),
}];
const llmConfig = {
    baseUrl: 'https://memory.example/v1',
    apiKey: 'test-key',
    model: 'memory-model',
};

function extractionReply() {
    return {
        choices: [{
            message: {
                content: JSON.stringify([{
                    content: '用户今天和雾岚去了上海。',
                    room: 'user_room',
                    importance: 5,
                    mood: 'neutral',
                    tags: ['雾岚', '上海'],
                    entities: [
                        { name: '雾岚', type: 'person' },
                        { name: '上海', type: 'place' },
                    ],
                    date: '2026-08-17',
                }]),
            },
        }],
    };
}

function capturedSystemPrompt(): string {
    const options = mockedSafeFetchJson.mock.calls.at(-1)?.[1] as RequestInit;
    const body = JSON.parse(String(options.body));
    return body.messages[0].content;
}

describe('memory extraction smart-context compatibility gate', () => {
    beforeEach(() => {
        localStorage.clear();
        mockedSafeFetchJson.mockReset();
        mockedSafeFetchJson.mockResolvedValue(extractionReply() as any);
    });

    it('keeps the master prompt and memory shape when smart context is off', async () => {
        const result = await extractMemoriesFromBuffer(
            messages, 'char-extraction-flags', '测试角色', llmConfig, undefined, '用户',
        );
        const prompt = capturedSystemPrompt();

        expect(prompt).toContain('7. **Tags**: Extract 2-5 English keyword tags.\n8. **Do not miss important memories');
        expect(prompt).toContain('"tags": ["tag 1", "tag 2"],\n    "date": "YYYY-MM-DD"');
        expect(prompt).not.toContain('Named entities');
        expect(prompt).not.toContain('"entities"');
        expect(Object.prototype.hasOwnProperty.call(result.memories[0], 'entities')).toBe(false);
    });

    it('adds and stores entities only after recallRouter is enabled', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { recallRouter: true },
        }));

        const result = await extractMemoriesFromBuffer(
            messages, 'char-extraction-flags', '测试角色', llmConfig, undefined, '用户',
        );
        const prompt = capturedSystemPrompt();

        expect(prompt).toContain('Named entities');
        expect(prompt).toContain('"entities"');
        expect(result.memories[0].entities).toEqual([
            { name: '雾岚', type: 'person' },
            { name: '上海', type: 'place' },
        ]);
    });
});
