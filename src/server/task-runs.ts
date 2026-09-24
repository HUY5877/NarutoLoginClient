import { createClient } from 'redis';
import type { Config } from './config.js';
import type { LoginEvent, LoginEventStore } from './database.js';
import { ApiError } from './errors.js';
import type { Status } from './queue.js';

export type RunStatus = 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'waiting_scan' | 'finishing_login'
  | 'running_daily' | 'completed' | 'failed' | 'interrupted' | 'expired';
export interface TaskRun {
  taskId: string;
  status: RunStatus;
  updatedAt: string;
  startedAt: string | null;
  authorizedAt?: string;
  finishedAt: string | null;
  actionIndex?: number;
  actionTotal?: number;
  errorCode?: string;
}
export interface TaskLog {
  id: string;
  time: string;
  level: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  actionIndex?: number;
  actionTotal?: number;
}
export interface RunTask { id: string; createdAt: string; expiresAt: string; status: Status }
export interface TaskRunEvents {
  task: RunTask;
  run: TaskRun | null;
  logs: TaskLog[];
  nextCursor: string;
  hasMore: boolean;
  truncated: boolean;
}

type RunConfig = Pick<Config, 'redisUrl' | 'redisQueueKey' | 'timeoutMs'>;
type EventReader = Pick<LoginEventStore, 'initialize' | 'getEvent' | 'getLatestForUser'>;
export interface RunRedisDriver {
  readonly isReady: boolean;
  connect(): Promise<void>;
  eval(script: string, options: { keys: string[]; arguments: string[] }, signal: AbortSignal): Promise<unknown>;
  destroy(): void;
}
interface Options { store?: EventReader; createDriver?: () => RunRedisDriver; now?: () => number }
const runStatuses = new Set<RunStatus>(['starting_emulator', 'opening_game', 'preparing_qr', 'waiting_scan', 'finishing_login',
  'running_daily', 'completed', 'failed', 'interrupted', 'expired']);
const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const streamIdPattern = /^(0|[1-9][0-9]{0,19})-(0|[1-9][0-9]{0,19})$/;
const maxStreamPart = 18446744073709551615n;
const pageSize = 100;

export function isStreamCursor(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && streamIdPattern.test(value)
    && value.split('-').every(part => BigInt(part) <= maxStreamPart);
}
function compareIds(left: string, right: string): number {
  const [lm, ls] = left.split('-').map(BigInt), [rm, rs] = right.split('-').map(BigInt);
  return lm < rm ? -1 : lm > rm ? 1 : ls < rs ? -1 : ls > rs ? 1 : 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40
    && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
function progress(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100000;
}
function validProgress(value: Record<string, unknown>): boolean {
  return value.actionIndex === undefined && value.actionTotal === undefined
    || progress(value.actionIndex) && progress(value.actionTotal) && value.actionIndex <= value.actionTotal;
}
function parseObject(raw: unknown): Record<string, unknown> | null {
  // JSON may escape each non-BMP character as a 12-character surrogate pair.
  if (typeof raw !== 'string' || raw.length > 20000) return null;
  try { const value: unknown = JSON.parse(raw); return record(value) ? value : null; } catch { return null; }
}
const invalidData = () => new ApiError(502, '任务日志格式异常，请稍后重试。', 'TASK_RUN_DATA_INVALID');
function parseRun(raw: unknown, taskId: string): TaskRun | null {
  if (raw === null) return null;
  const value = parseObject(raw);
  if (!value || value.taskId !== taskId || !runStatuses.has(value.status as RunStatus) || !timestamp(value.updatedAt)
    || value.startedAt !== null && !timestamp(value.startedAt) || value.finishedAt !== null && !timestamp(value.finishedAt)
    || value.authorizedAt !== undefined && !timestamp(value.authorizedAt)
    || !validProgress(value)
    || value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !/^[a-z0-9_]{1,64}$/.test(value.errorCode))) {
    throw invalidData();
  }
  return { taskId, status: value.status as RunStatus, updatedAt: value.updatedAt, startedAt: value.startedAt as string | null,
    finishedAt: value.finishedAt as string | null,
    ...(value.authorizedAt !== undefined ? { authorizedAt: value.authorizedAt as string } : {}),
    ...(value.actionIndex !== undefined ? { actionIndex: value.actionIndex as number } : {}),
    ...(value.actionTotal !== undefined ? { actionTotal: value.actionTotal as number } : {}),
    ...(value.errorCode !== undefined ? { errorCode: value.errorCode as string } : {}) };
}
function parseLog(id: string, fields: unknown): TaskLog | null {
  if (!Array.isArray(fields) || fields.length > 20 || fields.length % 2 !== 0) return null;
  const position = fields.findIndex((field, index) => index % 2 === 0 && field === 'json');
  const value = position < 0 ? null : parseObject(fields[position + 1]);
  if (!value || !timestamp(value.time) || !['INFO', 'WARNING', 'ERROR'].includes(String(value.level))
    || typeof value.message !== 'string' || value.message.length === 0 || [...value.message].length > 1000
    || !validProgress(value)) return null;
  return { id, time: value.time, level: value.level as TaskLog['level'], message: value.message,
    ...(value.actionIndex !== undefined ? { actionIndex: value.actionIndex as number } : {}),
    ...(value.actionTotal !== undefined ? { actionTotal: value.actionTotal as number } : {}) };
}

// Take one read-only snapshot so a terminal run cannot race its final log entry.
// XRANGE is non-consuming: every authorized browser can independently resume.
const snapshotScript = `
local run = redis.call('GET', KEYS[1])
local entries = redis.call('XRANGE', KEYS[2], '(' .. ARGV[1], '+', 'COUNT', ARGV[2])
local firstId, added, length = '', 0, 0
if redis.call('EXISTS', KEYS[2]) == 1 then
  local info = redis.call('XINFO', 'STREAM', KEYS[2])
  for i = 1, #info, 2 do
    if info[i] == 'first-entry' and type(info[i + 1]) == 'table' then firstId = info[i + 1][1] end
    if info[i] == 'entries-added' then added = info[i + 1] end
    if info[i] == 'length' then length = info[i + 1] end
  end
end
return {run, entries, firstId, added, length}
`;
function createRedisDriver(config: RunConfig): RunRedisDriver {
  const client = createClient({ url: config.redisUrl,
    socket: { connectTimeout: config.timeoutMs, reconnectStrategy: false },
    disableOfflineQueue: true, commandsQueueMaxLength: 1000 });
  client.on('error', () => {});
  return { get isReady() { return client.isReady; }, async connect() { await client.connect(); },
    eval: (script, options, signal) => client.withAbortSignal(signal).eval(script, options),
    destroy() { if (client.isOpen) client.destroy(); } };
}

export class TaskRunService {
  private connection?: { driver: RunRedisDriver; opening?: Promise<void> };
  private readonly now: () => number;
  constructor(private readonly config: RunConfig, private readonly options: Options = {}) { this.now = options.now ?? Date.now; }

  private async database<T>(read: (store: EventReader) => Promise<T>): Promise<T> {
    if (!this.options.store) throw new ApiError(503, '账号数据库未配置，请先配置 DATABASE_URL。', 'DATABASE_NOT_CONFIGURED');
    try { await this.options.store.initialize(); return await read(this.options.store); }
    catch { throw new ApiError(503, '任务记录暂时不可用，请稍后重试。', 'TASK_RUNS_UNAVAILABLE'); }
  }
  private publicTask(event: LoginEvent): RunTask {
    return { id: event.id, createdAt: event.createdAt, expiresAt: event.expiresAt,
      status: event.status === 'failed' ? 'failed' : Date.parse(event.expiresAt) <= this.now() ? 'expired' : event.status };
  }
  async getLatest(userId: string): Promise<{ task: RunTask | null }> {
    // Deliberately bypass LoginEventService.resume: reading logs must never dispatch a job.
    const event = await this.database(store => store.getLatestForUser(userId));
    return { task: event ? this.publicTask(event) : null };
  }
  private async snapshot(taskId: string, after: string): Promise<unknown> {
    if (!this.config.redisUrl) throw new ApiError(503, 'Redis 未配置，请先配置 REDIS_URL。', 'REDIS_NOT_CONFIGURED');
    let connection: NonNullable<TaskRunService['connection']> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      connection = this.connection ??= { driver: (this.options.createDriver ?? (() => createRedisDriver(this.config)))() };
      const current = connection;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Redis request timed out')); }, this.config.timeoutMs);
      });
      const operation = async () => {
        if (!current.driver.isReady) { current.opening ??= current.driver.connect(); await current.opening; }
        controller.signal.throwIfAborted();
        return await current.driver.eval(snapshotScript, {
          keys: [`${this.config.redisQueueKey}:runs:${taskId}`, `${this.config.redisQueueKey}:logs:${taskId}`],
          arguments: [after, String(pageSize + 1)],
        }, controller.signal);
      };
      return await Promise.race([operation(), deadline]);
    } catch {
      if (connection) { if (this.connection === connection) this.connection = undefined; connection.driver.destroy(); }
      throw new ApiError(503, '任务日志暂时不可用，请稍后重试。', 'TASK_LOGS_UNAVAILABLE');
    } finally { if (timer) clearTimeout(timer); }
  }
  async getEvents(taskId: string, userId: string, after = '0-0'): Promise<TaskRunEvents> {
    if (taskId !== taskId.trim() || !taskIdPattern.test(taskId)) throw new ApiError(400, '无效的任务编号。');
    if (!isStreamCursor(after)) throw new ApiError(400, '无效的日志读取位置。');
    // The durable database owns authorization even after QR/session Redis TTLs expire.
    const event = await this.database(store => store.getEvent(taskId, userId));
    if (!event) throw new ApiError(404, '任务不存在或不属于当前账号。');
    const raw = await this.snapshot(event.id, after);
    if (!Array.isArray(raw) || raw.length !== 5 || !Array.isArray(raw[1]) || raw[1].length > pageSize + 1
      || typeof raw[2] !== 'string' || raw[2] !== '' && !isStreamCursor(raw[2])
      || !Number.isSafeInteger(raw[3]) || !Number.isSafeInteger(raw[4])) throw invalidData();
    const run = parseRun(raw[0], event.id);
    const logs: TaskLog[] = [];
    let nextCursor = after;
    let truncated = after === '0-0' ? raw[3] > raw[4] : raw[2] !== '' && compareIds(after, raw[2]) < 0;
    for (const entry of raw[1].slice(0, pageSize) as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2 || !isStreamCursor(entry[0]) || compareIds(entry[0], nextCursor) <= 0) throw invalidData();
      // Skip corrupt entries and advance, so one broken message cannot stall polling forever.
      nextCursor = entry[0];
      const log = parseLog(entry[0], entry[1]);
      if (log) logs.push(log); else truncated = true;
    }
    return { task: this.publicTask(event), run, logs, nextCursor, hasMore: raw[1].length > pageSize, truncated };
  }
  close() { this.connection?.driver.destroy(); this.connection = undefined; }
}
