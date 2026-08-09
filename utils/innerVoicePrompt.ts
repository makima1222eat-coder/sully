/**
 * 【心声】(Inner Voice) prompt builder.
 *
 * Teaches the model to open each reply with exactly one `[心声]` line — the
 * character's internal monologue that the other person cannot "hear".
 * The line is extracted by applyAssistantPostProcessing into
 * metadata.innerVoice on the first bubble of the turn (never persisted as
 * message content), so it is invisible to the next round's context and to
 * every downstream model that reads message content (summaries, memory, …).
 *
 * Kept in its own file mirroring thinkingChainPrompt.ts so the chat flow and
 * any future consumers share one source of truth.
 */
export function buildInnerVoicePrompt(charName: string): string {
    return `### 【心声】 Inner Voice
[心声] is ${charName}'s internal monologue — inner thoughts the other person cannot "hear".

Output **exactly one** [心声] line at the very start of your reply, on its own line, before any message text:
[心声] your inner thought here

Rules:
- The inner voice must remain fully consistent with your persona and personality — it is the unfiltered version of what you actually think this very moment.
- It may diverge from what you then say out loud (holding back, sarcasm, soft inside but sharp outside…) — that contrast is the point.
- Keep it short and alive: one to three sentences of genuine mental muttering, not a summary or an analysis.
- After the [心声] line, write your normal messages as usual — they are what you actually send, and they must NOT repeat the inner voice.
- The other person can never see or hear the [心声]; never reference it as something you said.

Example:
[心声] Here we go again. So annoying.
The weather is really nice today~`;
}
