import { dailyStatusLabels, type DailyTaskLogPage, type DailyStatus } from '../../shared/admin';
import { adminRequest, AdminRequestError } from './admin';

type Log = DailyTaskLogPage['logs'][number];
export interface TaskLogView {
  status: DailyStatus | null;
  logs: Log[];
  loading: boolean;
  error: string;
}
export const emptyTaskLogs = (): TaskLogView => ({ status: null, logs: [], loading: false, error: '' });
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
export function parseTaskLogPage(value: unknown, taskId: string, after: string): DailyTaskLogPage {
  if (!object(value) || value.taskId !== taskId || !Array.isArray(value.logs) || value.logs.length > 100
    || value.status !== null && (typeof value.status !== 'string' || !Object.hasOwn(dailyStatusLabels, value.status))
    || !cursor(value.nextCursor) || !cursor(after) || compare(value.nextCursor, after) < 0) throw invalid();
  let previous = '0-0';
  for (const log of value.logs) {
    if (!object(log) || !cursor(log.id) || compare(log.id, previous) < 0 || compare(log.id, value.nextCursor) > 0
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
/** Read once per open or user gesture; empty reads remain refreshable. */
export class TaskLogPager {
  private view = emptyTaskLogs();
  private after = '0-0';
  private controller: AbortController | null = null;
  private disposed = false;
  constructor(private readonly taskId: string, private readonly update: (view: TaskLogView) => void,
    private readonly accessLost: () => void, private readonly read: Read = adminRequest) {}
  private emit(patch: Partial<TaskLogView>) {
    this.view = { ...this.view, ...patch };
    if (!this.disposed) this.update(this.view);
  }
  async load() {
    if (this.disposed || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    const active = () => !this.disposed && this.controller === controller && !controller.signal.aborted;
    this.emit({ loading: true, error: '' });
    try {
      const value = await this.read(`/api/admin/daily-tasks/${encodeURIComponent(this.taskId)}/logs?after=${this.after}`, controller.signal);
      if (!active()) return;
      const page = parseTaskLogPage(value, this.taskId, this.after);
      this.after = page.nextCursor;
      const seen = new Set(this.view.logs.map(log => log.id));
      const incoming = page.logs.filter(log => !seen.has(log.id) && Boolean(seen.add(log.id)));
      this.emit({ status: page.status, logs: [...this.view.logs, ...incoming].sort((left, right) => compare(left.id, right.id)), error: '' });
    } catch (caught) {
      if (!active()) return;
      if (caught instanceof AdminRequestError && [401, 403].includes(caught.status)) {
        this.emit(emptyTaskLogs());
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
