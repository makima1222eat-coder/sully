import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUserPronounRule } from './userPronoun';

/** 所有「会产出提到用户的自然语言」的提示词文件 */
const PROMPT_FILES = [
    'extraction.ts',
    'migration.ts',
    'groupExtraction.ts',
    'eventBoxCompression.ts',
    'digestion.ts',
    'roomPlates.ts',
    'externalMemory.ts',
    'memoryRepair.ts',
];

const readPrompt = (file: string) =>
    readFileSync(path.resolve(__dirname, `./${file}`), 'utf8');

describe('记忆宫殿里用户统一用 she', () => {
    it('人称规则同时钉死要用的和不许用的', () => {
        const rule = buildUserPronounRule('Yuki');

        expect(rule).toContain('she / her / hers / herself');
        expect(rule).toContain('Never use they / them / their / themself for Yuki');
        // 只约束用户人称，第三方保持原样——否则 LLM 会把所有人都改成 she
        expect(rule).toContain('Pronouns for everyone else are unaffected');
    });

    it.each(PROMPT_FILES)('%s 的提示词带上了人称规则', file => {
        expect(readPrompt(file)).toContain('buildUserPronounRule(');
    });

    it('示例句里不再拿 they/them 指代用户', () => {
        // 这几句是改之前的原文。示例只是倾向、规则才是约束，但示例和规则打架时
        // LLM 会跟着示例走，所以两边都得钉住。
        const staleExamples = [
            'not to neglect themself',
            'their eyes lit up',
            'asked me to remind them to drink water',
            'said they were convinced to try it',
            'their state, emotions, family or friends they mention',
            'Their friend Mei',
            'the first person they seek when they are hurting',
            'major enough to shape them',
            'never call them "the user."',
        ];

        const allPrompts = PROMPT_FILES.map(readPrompt).join('\n');
        for (const stale of staleExamples) {
            expect(allPrompts).not.toContain(stale);
        }
    });
});
