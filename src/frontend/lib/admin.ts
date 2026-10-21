import { dailyStatusLabels, type DailyStatus, type DailyTaskPage, type DailyTaskFailureDetails, type ManagedUser, type PageResult, type MonthlyStatsPage } from '../../shared/admin';
import { parseLoginType } from '../../shared/login-types';
import { mainTasks, type MainTask } from '../../shared/user-options';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const calendarDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function isManagedUser(value: unknown): value is ManagedUser {
  return object(value) && typeof value.id === 'string' && typeof value.username === 'string'
    && typeof value.isAdmin === 'boolean' && typeof value.isInvalid === 'boolean' && date(value.createdAt)
    && (value.applicationStatus === null || ['pending', 'approved', 'rejected'].includes(String(value.applicationStatus)));
}
export function isUserResponse(value: unknown): value is { user: ManagedUser } {
  return object(value) && isManagedUser(value.user);
}
function isPage(value: unknown): value is PageResult<unknown> {
  return object(value) && Array.isArray(value.items) && Number.isSafeInteger(value.total) && (value.total as number) >= 0
    && Number.isSafeInteger(value.page) && (value.page as number) > 0 && Number.isSafeInteger(value.pageSize) && (value.pageSize as number) > 0;
}
export function isUsersPage(value: unknown): value is PageResult<ManagedUser> {
  return isPage(value) && value.items.every(isManagedUser);
}
export function isDailyPage(value: unknown): value is DailyTaskPage {
  return isPage(value) && object(value) && calendarDate(value.date)
    && (value.mainTask === undefined || mainTasks.includes(value.mainTask as MainTask))
    && (value.startDate === undefined || calendarDate(value.startDate))
    && (value.selectedDate === undefined || calendarDate(value.selectedDate) && value.selectedDate <= value.date
      && (value.startDate === undefined || value.selectedDate >= value.startDate))
    && value.timeZone === 'Asia/Shanghai' && value.items.every(item => object(item)
      && typeof item.id === 'string' && typeof item.username === 'string' && date(item.requestedAt)
      && (item.mainTask === undefined || mainTasks.includes(item.mainTask as MainTask))
      && (item.mainTask ?? 'daily') === (value.mainTask ?? 'daily')
      && parseLoginType(item.loginType) !== null
      && nullableDate(item.scannedAt) && nullableDate(item.completedAt)
      && (item.errorCode === undefined || typeof item.errorCode === 'string' && /^[a-z0-9_]{1,64}$/.test(item.errorCode))
      && (item.errorMessage === undefined || typeof item.errorMessage === 'string')
      && typeof item.status === 'string' && Object.hasOwn(dailyStatusLabels, item.status));
}
export function adminTaskStatusLabel(status: DailyStatus, mainTask: MainTask = 'daily') {
  return status === 'running_daily' && mainTask === 'arena_weekly' ? '刷周胜中' : dailyStatusLabels[status];
}
export function isMonthlyStatsPage(value: unknown): value is MonthlyStatsPage {
  const positive = (number: unknown) => Number.isSafeInteger(number) && (number as number) > 0;
  return isPage(value) && object(value) && typeof value.month === 'string' && /^[2-9]\d{3}-(0[1-9]|1[0-2])$/.test(value.month)
    && value.timeZone === 'Asia/Shanghai' && ['requests', 'days'].includes(String(value.sort))
    && Number.isSafeInteger(value.totalRequests) && (value.totalRequests as number) >= 0
    && value.items.every(item => object(item) && typeof item.userId === 'string' && typeof item.username === 'string'
      && positive(item.rank) && positive(item.requestCount) && positive(item.requestDays)
      && (item.requestDays as number) <= 31 && (item.requestDays as number) <= (item.requestCount as number));
}
export function isDailyTaskFailureDetails(value: unknown): value is DailyTaskFailureDetails {
  const code = (value: unknown) => value === undefined || typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value);
  const message = (value: unknown) => typeof value === 'string' && value.length > 0 && [...value].length <= 1000;
  const progress = (value: Record<string, unknown>) => value.actionIndex === undefined && value.actionTotal === undefined
    || Number.isSafeInteger(value.actionIndex) && Number.isSafeInteger(value.actionTotal)
      && (value.actionIndex as number) >= 0 && (value.actionTotal as number) <= 100000 && (value.actionIndex as number) <= (value.actionTotal as number);
  return object(value) && typeof value.taskId === 'string' && code(value.errorCode) && message(value.errorMessage)
    && progress(value) && (value.actionName === undefined || message(value.actionName))
    && typeof value.truncated === 'boolean' && Array.isArray(value.logs) && value.logs.length <= 10
    && value.logs.every(log => object(log) && typeof log.id === 'string' && date(log.time)
      && ['INFO', 'WARNING', 'ERROR'].includes(String(log.level)) && message(log.message) && progress(log));
}
export class AdminRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function adminRequest(path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) });
  if (response.status === 204) return null;
  const result: unknown = await response.json();
  if (!response.ok) throw new AdminRequestError(response.status,
    object(result) && typeof result.error === 'string' ? result.error : '操作未完成，请重试。');
  return result;
}
export function formatAdminDate(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}
