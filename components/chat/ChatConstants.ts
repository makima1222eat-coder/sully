
import { ChatTheme } from '../../types';

/** Prepended at runtime so custom archive templates must also produce English memory text. */
// 人称那句和记忆宫殿的 utils/memoryPalace/userPronoun.ts 是同一条规矩：
// 这份指令既走手动归档，也走宫殿的全自动归档（archiveTemplate.getActiveArchiveTemplate），
// 不写的话日度总结里还是 they，提取进宫殿时又被带回去。改人称两处一起改。
export const MEMORY_SUMMARY_ENGLISH_INSTRUCTION =
    'Output the complete memory summary in English. Preserve names and message tags exactly as provided; translate only the generated summary text. '
    + 'Refer to the user with she / her / hers / herself only; never they / them / their, even when the user\'s gender is not stated. '
    + 'Pronouns for everyone else are unaffected.';

// Built-in presets map to the new data structure for consistency
export const PRESET_THEMES: Record<string, ChatTheme> = {
    default: {
        id: 'default', name: 'Indigo', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#6366f1', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }, 
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
    dream: {
        id: 'dream', name: 'Dream', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#f472b6', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 },
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
    forest: {
        id: 'forest', name: 'Forest', type: 'preset',
        user: { textColor: '#ffffff', backgroundColor: '#10b981', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 },
        ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1, backgroundImageOpacity: 0.5 }
    },
};

// Character App: Monthly Refinement Prompts (daily memories → monthly core memory)
// These are separate from chat archive prompts because:
// 1. Input is already-summarized daily memories, not raw chat logs
// 2. Goal is token-efficient monthly overview, not detailed event log
// 3. Written as character's own monthly reflection
export const DEFAULT_REFINE_PROMPTS = [
    {
        id: 'refine_atmosphere',
        name: '氛围月记 (Atmosphere)',
        content: `### [Character Monthly Memory Refinement]
Current month: \${dateStr}
Identity: You are \${char.name}

Task: The following are your daily memory fragments from this month. In your own voice, write a core memory of the month. Write the entire output in English, including the keyword line.

### Writing Rules
1.  **First person**: You are \${char.name}. Refer to yourself as "I" and address the other person as "\${userProfile.name}". Preserve your usual voice and personality.

2.  **Prioritize atmosphere over minor detail**:
    - What did the month feel like overall: happy, quiet, turbulent, or something else?
    - Which 1-3 events stayed with you most strongly?
    - Did your relationship with \${userProfile.name} change?

3.  **Be concise**:
    - This summary exists to save tokens and does not need to cover everything.
    - Keep only the most important and representative parts of the month.
    - Adjust length to the amount of material: about 100-200 English words for a quiet month and 300-600 English words for an eventful month, while preserving every major event.

4.  **Keyword index**:
    - End with \`Keywords: ...\`, listing key topics, events, places, and people from the month, separated by commas.
    - These keywords are used to quickly locate the month in which something happened.

### Memory Fragments for This Month
\${rawLog}`
    },
    {
        id: 'refine_keypoints',
        name: '要点速记 (Key Points)',
        content: `### [Monthly Memory Compression]
Month: \${dateStr}
Character: \${char.name}

Task: Compress the following daily memories into a concise monthly core memory. Write the entire output in English, including every list item and keyword.

### Rules
1.  **Perspective**: Write in the first person as \${char.name} ("I") and address the other person as \${userProfile.name}.

2.  **Structure**:
    - Summarize the month's overall atmosphere in one sentence.
    - List the 2-5 most important events as an unordered list, one sentence per item.
    - End with a keyword index.

3.  **Principles**:
    - Minor details may be omitted, but major events must not be missed.
    - Everyday chatter may be ignored unless it shows a relationship change or emotional turning point.
    - Adjust length to the material: about 100-200 English words for a quiet month and up to 300-600 English words for an eventful month, ensuring all major events are recorded.

4.  **Keywords**: End with \`Keywords: Event A, Place B, Topic C, ...\`.

### Memory Input
\${rawLog}`
    }
];

// Chat App: Daily Archive Prompts (raw chat logs → daily memory)
export const DEFAULT_ARCHIVE_PROMPTS = [
    {
        id: 'preset_rational',
        name: '理性精炼 (Rational)',
        content: `### [System Instruction: Memory Archival]
Current date: \${dateStr}
Task: Review today's chat log and produce a high-precision event log. Write the entire output in English.

### Core Writing Rules (Strict Protocols)
1.  **Coverage**:
    - Include every distinct topic discussed today.
    - Never merge separate topics merely to be concise. Even a single remark such as "the weather is bad" must receive its own item if it is a distinct topic.
    - Do not discard casual conversation; it is part of everyday life.

2.  **Perspective**:
    - You are "\${char.name}". This is your private diary.
    - Refer to yourself as "I" and address the other person as "\${userProfile.name}".
    - Every item must use your first-person perspective.

3.  **Format**:
    - Do not write one continuous paragraph.
    - Use a Markdown unordered list (\`- ...\`).
    - Each line must describe one specific event or topic.

4.  **Conciseness**:
    - Do not write "Today I chatted with X about..."; state what happened directly.
    - Example: "- I discussed breakfast with \${userProfile.name} this morning and wanted soup dumplings."

### Chat Logs to Process
\${rawLog}`
    },
    {
        id: 'preset_diary',
        name: '日记风格 (Diary)',
        content: `Current date: \${dateStr}
Task: Review today's chat log and turn it into a core memory that belongs to you. Write the entire output in English.

### Core Writing Rules (Review Protocols)
1.  **Strict first person**:
    - You are "\${char.name}". This is your private diary.
    - Refer to yourself as "I" and address the other person as "\${userProfile.name}".
    - Never use third person for yourself, such as "\${char.name} did something."
    - Never use a stiff AI-summary voice or third-party narration.

2.  **Preserve the character's voice**:
    - Your tone, verbal habits, and attitude must match your usual chat style. For example, a tsundere character should still sound tsundere in the diary, while a reserved character should remain concise.
    - Include the emotional shifts you felt at the time.

3.  **Resolve attribution and remove noise**:
    - Carefully distinguish who did what. Do not turn "the user said they were going to eat" into "I went to eat."
    - Remove inconsequential greetings such as "hello" or "are you there." Keep only key events, emotional turning points, and important information, preserving the original logic and meaning.

4.  **Output requirements**:
    - Output one concise English text; YAML is acceptable and JSON is unnecessary.
    - Write the content directly, as if writing in your diary.

### Chat Logs to Process
\${rawLog}`
    }
];
