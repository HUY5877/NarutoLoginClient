import { taskFailureMessage } from '../../shared/task-errors';
import type { MainTask } from '../../shared/user-options';

/** Older workers use daily error codes for the shared execution lifecycle. */
export function mainTaskFailureMessage(mainTask: MainTask, code: unknown, fallback?: string): string {
  if (mainTask === 'arena_weekly') {
    if (code === 'daily_timeout') return '决斗场周胜任务执行超时，请查看执行日志。';
    if (code === 'daily_failed') return '决斗场周胜任务执行失败，请查看执行日志。';
  }
  return taskFailureMessage(code, fallback);
}
