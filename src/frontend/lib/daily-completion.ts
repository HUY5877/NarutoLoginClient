import { isRunTerminal, type TaskRun } from './task-run';
import { taskFailureMessage } from '../../shared/task-errors';
import type { UserOptions } from '../../shared/user-options';

export function deriveDailyCompletion(run: TaskRun | null, userOptions?: UserOptions) {
  if (!run?.startedAt || !run.secretRealmCompletedAt || run.status === 'completed'
    || run.status !== 'running_daily' && !isRunTerminal(run.status)) return null;
  const timedOut = run.status === 'failed' && run.errorCode === 'daily_timeout';
  const stopped = isRunTerminal(run.status);
  const abnormal = stopped && !timedOut;
  const failure = taskFailureMessage(run.errorCode,
    run.status === 'interrupted' ? '脚本执行已中断，请查看下方执行记录。' : '后续扫荡出现异常，请查看下方执行记录。');
  return {
    summary: '日常任务已初步完成',
    description: timedOut ? '日常任务已初步完成；已达到执行时限，剩余秘境扫荡已停止。'
      : abnormal ? `日常任务已初步完成；后续秘境扫荡已停止。${failure}`
        : userOptions?.secretRealmOnce ? '日常任务已初步完成，已完成一次秘境探险，正在完成结算并结束本次日常。'
        : '日常任务已初步完成，还在扫荡未用完的秘境扫荡券。',
    state: (abnormal ? 'failed' : stopped ? 'completed' : 'active') as 'failed' | 'completed' | 'active',
    tone: (abnormal ? 'danger' : 'success') as 'danger' | 'success',
    timedOut,
  };
}
