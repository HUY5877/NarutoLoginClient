import { getMainTask, parseUserOptions, type UserOptions } from './user-options.js';

export interface DailyMilestoneRun {
  startedAt?: string | null;
  secretRealmCompletedAt?: string;
}

/** A recorded first secret-realm clear proves the daily work was completed. */
export function getDailyMilestoneAt(run: DailyMilestoneRun | null, userOptions?: UserOptions): string | null {
  const options = parseUserOptions(userOptions);
  if (!options || getMainTask(options) !== 'daily' || options.secretRealmMode === 'skip') return null;
  if (typeof run?.startedAt !== 'string' || !Number.isFinite(Date.parse(run.startedAt))
    || typeof run.secretRealmCompletedAt !== 'string' || !Number.isFinite(Date.parse(run.secretRealmCompletedAt))) return null;
  return run.secretRealmCompletedAt;
}
