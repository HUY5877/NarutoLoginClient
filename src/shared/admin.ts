export interface ManagedUser {
  id: string;
  username: string;
  isAdmin: boolean;
  isInvalid: boolean;
  createdAt: string;
  applicationStatus: 'pending' | 'approved' | 'rejected' | null;
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
  username: string;
  requestedAt: string;
  scannedAt: string | null;
  completedAt: string | null;
  status: DailyStatus;
  errorCode?: string;
  errorMessage?: string;
}
export interface PageResult<T> { items: T[]; total: number; page: number; pageSize: number }
export interface DailyTaskPage extends PageResult<DailyTask> {
  date: string; startDate?: string; selectedDate?: string; timeZone: 'Asia/Shanghai';
}
export type MonthlySort = 'requests' | 'days';
export interface MonthlyUserStats {
  userId: string; username: string; rank: number; requestCount: number; requestDays: number;
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
}
