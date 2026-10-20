import { dailyStatusLabels, type DailyTaskLogPage, type DailyStatus } from '../../shared/admin';
import { adminRequest, AdminRequestError } from './admin';

type Log = DailyTaskLogPage['logs'][number];
export interface TaskLogView {
  status: DailyStatus | null;
  logs: Log[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  truncated: boolean;
  logsPending?: boolean;
}
export const emptyTaskLogs = (): TaskLogView => ({ status: null, logs: [], loading: false, error: '', hasMore: true, truncated: false });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const cursor = (value: unknown): value is string => typeof value === 'string'
  && value === value.trim() && /^(0|[1-9]\d{0,19})-(0|[1-9]\d{0,19})$/.test(value)
  && value.split('-').every(part => BigInt(part) <= 18446744073709551615n);
function compare(left: string, right: string) {
  const [lm, ls] = left.split('-').map(BigInt), [rm, rs] = right.split('-').map(BigInt);
  return lm < rm ? -1 : lm > rm ? 1 : ls < rs ? -1 : ls > rs ? 1 : 0;
}
const invalid = () => new Error('日志返回信息异常，请重试。');
export function parseTaskLogPage(value: unknown, taskId: string, after: string, snapshot: string | null): DailyTaskLogPage {
  if (!object(value) || value.taskId !== taskId || !Array.isArray(value.logs) || value.logs.length > 100
    || value.status !== null && (typeof value.status !== 'string' || !Object.hasOwn(dailyStatusLabels, value.status))
    || !cursor(value.nextCursor) || !cursor(value.snapshotCursor) || !cursor(after)
    || snapshot !== null && value.snapshotCursor !== snapshot
    || typeof value.hasMore !== 'boolean' || typeof value.truncated !== 'boolean'
    || value.logsPending !== undefined && typeof value.logsPending !== 'boolean'
    || compare(value.nextCursor, after) < 0 || compare(value.nextCursor, value.snapshotCursor) > 0
    || value.hasMore && (compare(value.nextCursor, after) <= 0 || compare(value.nextCursor, value.snapshotCursor) >= 0)
    || !value.hasMore && value.logsPending !== true && value.nextCursor !== value.snapshotCursor
    || value.logsPending === true && (value.hasMore || value.logs.length > 0 || value.nextCursor !== after)) throw invalid();
  let previous = after;
  for (const log of value.logs) {
    if (!object(log) || !cursor(log.id) || compare(log.id, previous) <= 0 || compare(log.id, value.nextCursor) > 0
      || !date(log.time) || !['INFO', 'WARNING', 'ERROR'].includes(String(log.level))
      || typeof log.message !== 'string' || !log.message.length || [...log.message].length > 1000
      || !(log.actionIndex === undefined && log.actionTotal === undefined
        || Number.isSafeInteger(log.actionIndex) && Number.isSafeInteger(log.actionTotal)
          && (log.actionIndex as number) >= 0 && (log.actionIndex as number) <= (log.actionTotal as number)
          && (log.actionTotal as number) <= 100000)) throw invalid();
    previous = log.id;
  }
  return value as unknown as DailyTaskLogPage;
}

type Read = (path: string, signal: AbortSignal) => Promise<unknown>;
/** One finite snapshot, read only on explicit open/load-more; never polls or trims retained pages. */
export class TaskLogPager {
  private view = emptyTaskLogs();
  private after = '0-0';
  private snapshot: string | null = null;
  private controller: AbortController | null = null;
  private disposed = false;
  constructor(private readonly taskId: string, private readonly update: (view: TaskLogView) => void,
    private readonly accessLost: () => void, private readonly read: Read = adminRequest) {}
  private emit(patch: Partial<TaskLogView>) {
    this.view = { ...this.view, ...patch };
    if (!this.disposed) this.update(this.view);
  }
  async load() {
    if (this.disposed || this.controller || !this.view.hasMore && !this.view.logsPending) return;
    const controller = new AbortController();
    this.controller = controller;
    const active = () => !this.disposed && this.controller === controller && !controller.signal.aborted;
    this.emit({ loading: true, error: '' });
    try {
      const value = await this.read(`/api/admin/daily-tasks/${encodeURIComponent(this.taskId)}/logs?after=${this.after}`
        + (this.snapshot !== null ? `&snapshot=${this.snapshot}` : ''), controller.signal);
      if (!active()) return;
      const page = parseTaskLogPage(value, this.taskId, this.after, this.snapshot);
      this.after = page.nextCursor;
      // If a source is announced before its first event, retry must still discover its initial watermark.
      if (!page.logsPending || page.snapshotCursor !== '0-0') this.snapshot = page.snapshotCursor;
      this.emit({ status: page.status, logs: [...this.view.logs, ...page.logs], hasMore: page.hasMore,
        truncated: this.view.truncated || page.truncated, logsPending: page.logsPending ?? false, error: '' });
    } catch (caught) {
      if (!active()) return;
      if (caught instanceof AdminRequestError && [401, 403].includes(caught.status)) {
        this.emit({ ...emptyTaskLogs(), hasMore: false });
        this.dispose();
        this.accessLost();
        return;
      }
      this.emit({ error: caught instanceof AdminRequestError ? caught.message : '日志暂时无法读取，请重试。' });
    } finally {
      if (active()) { this.controller = null; this.emit({ loading: false }); }
    }
  }
  dispose() { this.disposed = true; this.controller?.abort(); this.controller = null; }
}
