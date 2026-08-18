/**
 * Memory Palace — 用户人称
 *
 * 记忆正文里提到用户时统一用 she/her。
 *
 * 为什么要显式钉一次：用户档案里没有性别字段，提示词改英文之后 LLM 拿不到线索，
 * 默认会用中性的 they/them 兜底，同一个人在不同批次里 she / they 混着出现，
 * 向量检索和门牌蒸馏读到的就是两套称呼。所以每条「会产出提到用户的自然语言」的
 * 提示词都要带上这条规则，光改示例句不够——示例只是倾向，规则才是约束。
 *
 * 改成别的人称就动这一个文件（含 MEMORY_SUMMARY_ENGLISH_INSTRUCTION 里那句），
 * 别再散到各个 prompt 里。
 */

/**
 * 用户人称规则。放在提示词的规则区，`userLabel` 传已经兜过底的用户称呼。
 */
export function buildUserPronounRule(userLabel: string): string {
    return `**Pronouns for ${userLabel}**: Refer to ${userLabel} with she / her / hers / herself only. `
        + `Never use they / them / their / themself for ${userLabel}, and never use it as a gender-neutral fallback `
        + `when the source material does not state ${userLabel}'s gender. Pronouns for everyone else are unaffected: `
        + `keep third parties as the source describes them.`;
}
