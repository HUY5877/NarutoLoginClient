import type { LoginEvent, LoginEventStore } from './database.js';
import { ApiError } from './errors.js';
import { RUN_RETENTION_MS } from './task-state.js';

export type RecentEventReader = Pick<LoginEventStore, 'getLatestForUser' | 'getRecentForUser'>;
export async function recentTaskEvents(store: RecentEventReader, userId: string, now: number): Promise<LoginEvent[]> {
  if (!store.getRecentForUser) {
    const latest = await store.getLatestForUser(userId);
    return latest ? [latest] : [];
  }
  const recent = await store.getRecentForUser(userId, new Date(now - RUN_RETENTION_MS));
  // Never silently drop an older running task when an account has excessive history.
  if (recent.length > 100) throw new ApiError(503, '任务记录较多，暂时无法确认是否已有任务，请联系管理员。', 'TASK_STATE_UNAVAILABLE');
  if (recent.length) return recent;
  const latest = await store.getLatestForUser(userId);
  return latest ? [latest] : [];
}
