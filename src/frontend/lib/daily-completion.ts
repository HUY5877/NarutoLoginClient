import { isRunTerminal, type TaskRun } from './task-run';
import { getDailyMilestoneAt } from '../../shared/daily-completion';
import { parseUserOptions, type UserOptions } from '../../shared/user-options';

export function deriveDailyCompletion(run: TaskRun | null, userOptions?: UserOptions) {
  const mode = parseUserOptions(userOptions)?.secretRealmMode ?? 'all';
  if (!run || !getDailyMilestoneAt(run, userOptions) || run.status === 'completed'
    || run.status !== 'running_daily' && !isRunTerminal(run.status)) return null;
  const timedOut = run.status === 'failed' && run.errorCode === 'daily_timeout';
  const stopped = isRunTerminal(run.status);
  return {
    summary: stopped ? '任务已完成' : '日常任务已初步完成',
    description: timedOut ? mode === 'once' ? '日常任务已完成；已达到执行时限，本次日常已停止。'
      : '日常任务已完成；已达到执行时限，剩余秘境扫荡已停止。'
      : stopped ? mode === 'once' ? '日常任务已完成；本次日常已停止，具体原因见执行记录。'
        : '日常任务已完成；后续秘境扫荡已停止，具体原因见执行记录。'
        : mode === 'once' ? '日常任务已初步完成，已完成一次秘境探险，正在完成结算并结束本次日常。'
        : '日常任务已初步完成，还在扫荡未用完的秘境扫荡券。',
    state: (stopped ? 'completed' : 'active') as 'completed' | 'active',
    tone: 'success' as const,
  };
}
