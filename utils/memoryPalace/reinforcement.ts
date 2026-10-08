import { MemoryNodeDB } from './db';
import { strengthenCoActivated } from './links';

/** 只强化直接命中且实际输出的节点，保持输出顺序并按 ID 去重。 */
export async function reinforceFormattedMemories(
    directHitIds: ReadonlySet<string>,
    formattedIds: readonly string[],
): Promise<void> {
    const ids = [...new Set(formattedIds)].filter(id => directHitIds.has(id));
    const writes = await Promise.allSettled([
        ...ids.map(id => MemoryNodeDB.touchAccess(id)),
        ...(ids.length >= 2 ? [strengthenCoActivated(ids.slice(0, 5))] : []),
    ]);
    for (const write of writes) {
        if (write.status === 'rejected') {
            console.warn('[MemoryPalace] 记忆强化写入失败（召回正文保留）:', write.reason);
        }
    }
}
