import { parseUserOptions, type UserOptions } from '../../shared/user-options';
import { parseLoginType, type LoginType } from '../../shared/login-types';

export type RunStatus = 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'waiting_scan' | 'finishing_login'
  | 'running_daily' | 'completed' | 'failed' | 'interrupted' | 'expired';
export interface RunTask { id: string; createdAt: string; expiresAt: string; status: string; userOptions?: UserOptions; loginType?: LoginType }
export interface TaskRun {
  taskId: string; status: RunStatus; updatedAt: string;
  startedAt: string | null; finishedAt: string | null;
  authorizedAt?: string;
  scanCapturedAt?: string;
  secretRealmCompletedAt?: string;
  actionIndex?: number; actionTotal?: number; errorCode?: string;
  logSource?: 'sls' | 'disabled'; logCursor?: string;
}
export interface RunLog {
  id: string; time: string; level: 'INFO' | 'WARNING' | 'ERROR'; message: string;
  actionIndex?: number; actionTotal?: number;
}
export interface RunEvents {
  task: RunTask; run: TaskRun | null; logs: RunLog[];
  nextCursor: string; hasMore: boolean; truncated: boolean;
  logsPending?: boolean;
}
export interface TaskRunView {
  task: RunTask | null; run: TaskRun | null; logs: RunLog[];
  loading: boolean; polling: boolean; unavailable: boolean; truncated: boolean; error: string;
  logsPending?: boolean;
}
export const emptyTaskRun = (): TaskRunView => ({
  task: null, run: null, logs: [], loading: false, polling: false,
  unavailable: false, truncated: false, error: '',
});
const statuses: RunStatus[] = ['starting_emulator', 'opening_game', 'preparing_qr', 'waiting_scan', 'finishing_login',
  'running_daily', 'completed', 'failed', 'interrupted', 'expired'];
export const isRunTerminal = (status: RunStatus) => ['completed', 'failed', 'interrupted', 'expired'].includes(status);
const cursorPattern = /^\d+-\d+$/;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const action = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
export function isRunTask(value: unknown): value is RunTask {
  return object(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128
    && date(value.createdAt) && date(value.expiresAt) && typeof value.status === 'string'
    && parseUserOptions(value.userOptions) !== null && parseLoginType(value.loginType) !== null;
}
function compareCursor(left: string, right: string): number {
  const [lm, ls] = left.split('-').map(BigInt);
  const [rm, rs] = right.split('-').map(BigInt);
  return lm === rm ? ls < rs ? -1 : ls > rs ? 1 : 0 : lm < rm ? -1 : 1;
}
export function parseRunEvents(value: unknown, taskId: string, after: string): RunEvents {
  if (!object(value) || !isRunTask(value.task) || value.task.id !== taskId || !Array.isArray(value.logs)
    || typeof value.nextCursor !== 'string' || !cursorPattern.test(value.nextCursor)
    || typeof value.hasMore !== 'boolean' || typeof value.truncated !== 'boolean'
    || value.logsPending !== undefined && typeof value.logsPending !== 'boolean') throw new Error('invalid run events');
  if (value.run !== null && (!object(value.run) || value.run.taskId !== taskId
    || !statuses.includes(value.run.status as RunStatus) || !date(value.run.updatedAt)
    || (value.run.startedAt !== null && !date(value.run.startedAt))
    || (value.run.finishedAt !== null && !date(value.run.finishedAt))
    || (value.run.authorizedAt !== undefined && !date(value.run.authorizedAt))
    || (value.run.scanCapturedAt !== undefined && !date(value.run.scanCapturedAt))
    || (value.run.secretRealmCompletedAt !== undefined && !date(value.run.secretRealmCompletedAt))
    || !action(value.run.actionIndex) || !action(value.run.actionTotal)
    || value.run.logSource !== undefined && !['sls', 'disabled'].includes(String(value.run.logSource))
    || value.run.logCursor !== undefined && (typeof value.run.logCursor !== 'string' || !cursorPattern.test(value.run.logCursor))
    || (value.run.errorCode !== undefined && typeof value.run.errorCode !== 'string'))) throw new Error('invalid task run');
  let previous = after;
  for (const log of value.logs) {
    if (!object(log) || typeof log.id !== 'string' || !cursorPattern.test(log.id) || !date(log.time)
      || !['INFO', 'WARNING', 'ERROR'].includes(log.level as string) || typeof log.message !== 'string'
      || !action(log.actionIndex) || !action(log.actionTotal) || compareCursor(log.id, previous) <= 0) {
      throw new Error('invalid run log');
    }
    previous = log.id;
  }
  if (compareCursor(value.nextCursor, previous) < 0
    || (value.hasMore && compareCursor(value.nextCursor, after) <= 0)
    || value.logsPending === true && (value.hasMore || value.logs.length > 0 || value.nextCursor !== after)) throw new Error('invalid run cursor');
  return value as unknown as RunEvents;
}
export function appendRunLogs(previous: RunLog[], incoming: RunLog[]): { logs: RunLog[]; trimmed: boolean } {
  const seen = new Set(previous.map(log => log.id));
  const combined = [...previous, ...incoming.filter(log => !seen.has(log.id) && Boolean(seen.add(log.id)))];
  return { logs: combined.slice(-2_000), trimmed: combined.length > 2_000 };
}
export class RunRequestError extends Error {
  constructor(readonly status: number) { super('Task run request failed'); }
}
type Read = (path: string, signal: AbortSignal) => Promise<unknown>;
type Wait = (ms: number, signal: AbortSignal) => Promise<void>;
async function read(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  if (!response.ok) throw new RunRequestError(response.status);
  return response.json();
}
const wait: Wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
  const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

/** One account's current task. Switching tasks invalidates every in-flight response. */
export class TaskRunTracker {
  private view = emptyTaskRun();
  private cursor = '0-0';
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(private readonly update: (view: TaskRunView) => void,
    private readonly unauthorized: () => void,
    private readonly request: Read = read, private readonly pause: Wait = wait, private readonly now = Date.now) {}

  private emit(patch: Partial<TaskRunView>) {
    this.view = { ...this.view, ...patch };
    if (!this.disposed) this.update(this.view);
  }
  private active(controller: AbortController) {
    return !this.disposed && this.controller === controller && !controller.signal.aborted;
  }
  private begin() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    return controller;
  }
  private fail(error: unknown, controller: AbortController) {
    if (!this.active(controller)) return;
    if (error instanceof RunRequestError && error.status === 401) {
      this.emit({ ...emptyTaskRun() });
      this.unauthorized();
    } else {
      this.emit({ loading: false, polling: false, error: '执行记录暂时无法更新，请重试。已有日志会保留。' });
    }
  }
  async restore() {
    if (this.disposed) return;
    const controller = this.begin();
    this.emit({ loading: true, error: '' });
    try {
      const body = await this.request('/api/task-runs/latest', controller.signal);
      if (!this.active(controller)) return;
      if (!object(body) || (body.task !== null && !isRunTask(body.task))) throw new Error('invalid latest task');
      if (body.task === null) { this.emit({ loading: false }); return; }
      this.follow(body.task as RunTask);
    } catch (error) { this.fail(error, controller); }
  }
  follow(task: RunTask) {
    if (this.disposed || this.view.task?.id === task.id) return;
    const controller = this.begin();
    this.cursor = '0-0';
    this.view = emptyTaskRun();
    this.emit({ task, loading: true, polling: true });
    void this.poll(task.id, controller);
  }
  retry() {
    if (this.disposed) return;
    if (!this.view.task) { void this.restore(); return; }
    const controller = this.begin();
    this.emit({ error: '', loading: this.view.run === null && this.view.logs.length === 0, polling: true, unavailable: false });
    void this.poll(this.view.task.id, controller);
  }
  dispose() {
    this.disposed = true;
    this.controller?.abort();
    this.controller = null;
    this.view = emptyTaskRun();
  }
  private async poll(taskId: string, controller: AbortController) {
    let pendingSince: number | undefined;
    try {
      while (this.active(controller)) {
        const body = await this.request(`/api/task-runs/${encodeURIComponent(taskId)}/events?after=${this.cursor}`, controller.signal);
        if (!this.active(controller)) return;
        const events = parseRunEvents(body, taskId, this.cursor);
        const merged = appendRunLogs(this.view.logs, events.logs);
        this.cursor = events.nextCursor;
        const unavailable = events.run === null && (Date.parse(events.task.expiresAt) <= Date.now()
          || ['failed', 'expired'].includes(events.task.status));
        const terminal = unavailable || Boolean(events.run && isRunTerminal(events.run.status));
        if (terminal && events.logsPending) pendingSince ??= this.now();
        else pendingSince = undefined;
        const timedOut = pendingSince !== undefined && this.now() - pendingSince >= 90_000;
        const done = !events.hasMore && !events.logsPending && terminal;
        this.emit({ task: events.task, run: events.run, logs: merged.logs, loading: false,
          polling: !done && !timedOut, unavailable, logsPending: events.logsPending ?? false,
          truncated: this.view.truncated || events.truncated || merged.trimmed,
          error: timedOut ? '任务已结束，执行日志仍在上传或暂时不可用。请稍后重试更新。' : '' });
        if (done || timedOut) return;
        await this.pause(events.hasMore ? 0 : 1_500, controller.signal);
      }
    } catch (error) { this.fail(error, controller); }
  }
}
