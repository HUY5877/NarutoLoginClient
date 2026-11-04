import type { LoginType } from './login-types';
import type { MainTask, UserOptions } from './user-options';
import { getDailyMilestoneAt } from './daily-completion.js';
import { taskFailureMessage } from './task-errors.js';

export const MAX_USER_NOTE_LENGTH = 100;

export interface ManagedUser {
  id: string;
  username: string;
  note?: string;
  isAdmin: boolean;
  isInvalid: boolean;
  createdAt: string;
  applicationStatus: 'pending' | 'approved' | 'rejected' | null;
}

export const userStatusLabels = { enabled: '已启用', pending: '待审核', rejected: '已拒绝', disabled: '已停用' } as const;
export type UserStatus = keyof typeof userStatusLabels;
export type UserStatusFilter = UserStatus | 'all';
export function getUserStatus(user: Pick<ManagedUser, 'isInvalid' | 'applicationStatus'>): UserStatus {
  if (!user.isInvalid) return 'enabled';
  if (user.applicationStatus === 'pending' || user.applicationStatus === 'rejected') return user.applicationStatus;
  return 'disabled';
}

export const dailyStatusLabels = {
  queued: '排队中', starting_emulator: '启动模拟器', opening_game: '打开游戏',
  preparing_qr: '生成二维码', waiting_scan: '等待扫码', finishing_login: '进入游戏',
  running_daily: '刷日常中', completed: '已完成', failed: '失败',
  interrupted: '已中断', expired: '已过期', unavailable: '执行记录不可用',
} as const;
export type DailyStatus = keyof typeof dailyStatusLabels;
export interface DailyTask {
  id: string;
  loginType?: LoginType;
  mainTask?: MainTask;
  userOptions?: UserOptions;
  username: string;
  note?: string;
  requestedAt: string;
  scannedAt: string | null;
  completedAt: string | null;
  status: DailyStatus;
  errorCode?: string;
  errorMessage?: string;
}
/** Public execution fields used to update the administrator's cached list. */
export interface DailyTaskRun {
  taskId: string;
  status: Exclude<DailyStatus, 'unavailable'>;
  startedAt: string | null;
  finishedAt: string | null;
  authorizedAt?: string;
  secretRealmCompletedAt?: string;
  errorCode?: string;
}
export interface DailyTaskRunPage {
  items: Array<{ id: string; run: DailyTaskRun | null }>;
}

export function withDailyTaskRun(task: DailyTask, run: DailyTaskRun | null): DailyTask {
  if (!run || run.taskId !== task.id) return { ...task };
  const milestoneAt = getDailyMilestoneAt(run, task.userOptions);
  const milestoneCompleted = Boolean(milestoneAt && ['failed', 'interrupted', 'expired'].includes(run.status));
  const status = milestoneCompleted ? 'completed' : run.status;
  const result: DailyTask = {
    ...task,
    scannedAt: run.authorizedAt ?? task.scannedAt,
    // A later sweep failure cannot erase an already recorded daily milestone.
    completedAt: run.status === 'completed' && run.startedAt ? run.finishedAt : milestoneCompleted ? milestoneAt : null,
    status,
  };
  delete result.errorCode;
  delete result.errorMessage;
  if (status === 'failed') {
    if (run.errorCode) result.errorCode = run.errorCode;
    result.errorMessage = taskFailureMessage(run.errorCode, '未记录具体错误原因。');
  }
  return result;
}

export interface PageResult<T> { items: T[]; total: number; page: number; pageSize: number }
export interface DailyTaskPage extends PageResult<DailyTask> {
  date: string; startDate?: string; selectedDate?: string; timeZone: 'Asia/Shanghai';
  mainTask?: MainTask;
}
export type MonthlySort = 'requests' | 'days';
export interface MonthlyUserStats {
  userId: string; username: string; rank: number; requestCount: number; requestDays: number;
  note?: string;
}
export interface MonthlyStatsPage extends PageResult<MonthlyUserStats> {
  month: string; timeZone: 'Asia/Shanghai'; sort: MonthlySort; totalRequests: number;
}
export interface DailyTaskFailureDetails {
  taskId: string;
  errorCode?: string;
  errorMessage: string;
  actionIndex?: number;
  actionTotal?: number;
  actionName?: string;
  logs: Array<{
    id: string;
    time: string;
    level: 'INFO' | 'WARNING' | 'ERROR';
    message: string;
    actionIndex?: number;
    actionTotal?: number;
  }>;
  truncated: boolean;
  logsPending?: boolean;
}

/** 管理员按最后读取位置继续读取日志。 */
export interface DailyTaskLogPage {
  taskId: string;
  status: DailyStatus | null;
  logs: DailyTaskFailureDetails['logs'];
  nextCursor: string;
}
