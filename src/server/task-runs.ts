import { createClient } from 'redis';
import type { Config } from './config.js';
import type { LoginEvent, LoginEventStore } from './database.js';
import { ApiError } from './errors.js';
import { logBackend } from './logging.js';
import type { Status } from './queue.js';
import type { UserOptions } from '../shared/user-options.js';
import { DEFAULT_LOGIN_TYPE, type LoginType } from '../shared/login-types.js';
import type { DailyTaskFailureDetails, DailyTaskLogPage } from '../shared/admin.js';
import { taskFailureMessage } from '../shared/task-errors.js';
import { SlsTaskLogArchive, type TaskLogArchive } from './sls-logs.js';

export type RunStatus = 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'waiting_scan' | 'finishing_login'
  | 'running_daily' | 'completed' | 'failed' | 'interrupted' | 'expired';
export interface TaskRun {
  taskId: string;
  status: RunStatus;
  updatedAt: string;
  startedAt: string | null;
  authorizedAt?: string;
  secretRealmCompletedAt?: string;
  finishedAt: string | null;
  actionIndex?: number;
  actionTotal?: number;
  errorCode?: string;
  logSource?: 'sls' | 'disabled';
  logCursor?: string;
}
export interface TaskLog {
  id: string;
  time: string;
  level: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  actionIndex?: number;
  actionTotal?: number;
}
export interface RunTask { id: string; createdAt: string; expiresAt: string; status: Status; userOptions: UserOptions; loginType?: LoginType }
export interface TaskRunEvents {
  task: RunTask;
  run: TaskRun | null;
  logs: TaskLog[];
  nextCursor: string;
  hasMore: boolean;
  truncated: boolean;
  logsPending?: boolean;
}

type RunConfig = Pick<Config, 'redisUrl' | 'redisQueueKey' | 'timeoutMs' | 'appEnv' | 'sls'>;
type EventReader = Pick<LoginEventStore, 'initialize' | 'getEvent' | 'getLatestForUser'>;
export interface RunRedisDriver {
  readonly isReady: boolean;
  connect(): Promise<void>;
  eval(script: string, options: { keys: string[]; arguments: string[] }, signal: AbortSignal): Promise<unknown>;
  destroy(): void;
}
interface Options { store?: EventReader; createDriver?: () => RunRedisDriver; now?: () => number; archive?: TaskLogArchive }
const runStatuses = new Set<RunStatus>(['starting_emulator', 'opening_game', 'preparing_qr', 'waiting_scan', 'finishing_login',
  'running_daily', 'completed', 'failed', 'interrupted', 'expired']);
const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const streamIdPattern = /^(0|[1-9][0-9]{0,19})-(0|[1-9][0-9]{0,19})$/;
const maxStreamPart = 18446744073709551615n;
const pageSize = 100;
const failureLogLimit = 10;

export function isStreamCursor(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && streamIdPattern.test(value)
    && value.split('-').every(part => BigInt(part) <= maxStreamPart);
}
function compareIds(left: string, right: string): number {
  const [lm, ls] = left.split('-').map(BigInt), [rm, rs] = right.split('-').map(BigInt);
  return lm < rm ? -1 : lm > rm ? 1 : ls < rs ? -1 : ls > rs ? 1 : 0;
}
export function isLogCursorRange(after: string, snapshot: string): boolean {
  return isStreamCursor(after) && isStreamCursor(snapshot) && compareIds(after, snapshot) <= 0;
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
    || value.secretRealmCompletedAt !== undefined && !timestamp(value.secretRealmCompletedAt)
    || !validProgress(value)
    || value.logSource !== undefined && !['sls', 'disabled'].includes(String(value.logSource))
    || value.logCursor !== undefined && !isStreamCursor(value.logCursor)
    || value.errorCode !== undefined && (typeof value.errorCode !== 'string' || !/^[a-z0-9_]{1,64}$/.test(value.errorCode))) {
    throw invalidData();
  }
  return { taskId, status: value.status as RunStatus, updatedAt: value.updatedAt, startedAt: value.startedAt as string | null,
    finishedAt: value.finishedAt as string | null,
    ...(value.authorizedAt !== undefined ? { authorizedAt: value.authorizedAt as string } : {}),
    ...(value.secretRealmCompletedAt !== undefined ? { secretRealmCompletedAt: value.secretRealmCompletedAt as string } : {}),
    ...(value.actionIndex !== undefined ? { actionIndex: value.actionIndex as number } : {}),
    ...(value.actionTotal !== undefined ? { actionTotal: value.actionTotal as number } : {}),
    ...(value.logSource !== undefined ? { logSource: value.logSource as TaskRun['logSource'] } : {}),
    ...(value.logCursor !== undefined ? { logCursor: value.logCursor as string } : {}),
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
// A bounded, non-consuming tail is fetched only when an administrator opens details.
const failureSnapshotScript = `
local run = redis.call('GET', KEYS[1])
local entries = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', ARGV[1])
return {run, entries}
`;
// Fix the upper cursor on the first page, so continuing work cannot extend this read.
const adminLogSnapshotScript = `
local run = redis.call('GET', KEYS[1])
local exists = redis.call('EXISTS', KEYS[2])
local upper, firstId, added, length = ARGV[2], '', nil, 0
if exists == 1 then
  local info = redis.call('XINFO', 'STREAM', KEYS[2])
  for i = 1, #info, 2 do
    if info[i] == 'first-entry' and type(info[i + 1]) == 'table' then firstId = info[i + 1][1] end
    if info[i] == 'entries-added' then added = info[i + 1] end
    if info[i] == 'length' then length = info[i + 1] end
  end
  if upper == '' then
    local tail = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
    upper = #tail > 0 and tail[1][1] or '0-0'
  end
end
if added == nil then added = length end
if upper == '' then upper = '0-0' end
local entries = redis.call('XRANGE', KEYS[2], '(' .. ARGV[1], upper, 'COUNT', ARGV[3])
return {run, entries, upper, firstId, added, length, exists}
`;
// New tasks only keep a lightweight state/watermark in Redis, never a log stream.
const archiveStateScript = `return redis.call('GET', KEYS[1])`;
// Modify the original snapshot atomically, keeping private worker/attempt fields
// and its expiry. Public TaskRun projections must never be written back here.
const interruptRunScript = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return 0 end
if kind ~= 'string' then return -1 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if #raw > 20000 then return -1 end
local ok, run = pcall(cjson.decode, raw)
if not ok or type(run) ~= 'table' or run.taskId ~= ARGV[1] then return -1 end
if run.status == 'interrupted' then return 2 end
if run.status == 'completed' or run.status == 'failed' or run.status == 'expired' then return 3 end
if run.status ~= 'starting_emulator' and run.status ~= 'opening_game'
  and run.status ~= 'preparing_qr' and run.status ~= 'waiting_scan'
  and run.status ~= 'finishing_login' and run.status ~= 'running_daily' then return -1 end
run.status = 'interrupted'
run.errorCode = 'admin_interrupted'
run.updatedAt = ARGV[2]
run.finishedAt = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(run), 'KEEPTTL')
return 1
`;
function isGenericFailure(message: string, errorCode?: string): boolean {
  return message === taskFailureMessage(errorCode)
    || message === '日常任务执行失败，本次任务已停止。'
    || message === '任务执行失败'
    || /^执行阶段\s+\S+\s+失败[。.!]?$/.test(message)
    || /^[a-z_]+:\s*failed\s*\([a-z0-9_]+\)$/.test(message);
}
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
  private readonly archive?: TaskLogArchive;
  constructor(private readonly config: RunConfig, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.archive = options.archive ?? (config.sls ? new SlsTaskLogArchive(config.sls, config.appEnv ?? 'prod', Math.min(config.timeoutMs, 3000), { now: this.now }) : undefined);
  }

  private async database<T>(read: (store: EventReader) => Promise<T>): Promise<T> {
    if (!this.options.store) throw new ApiError(503, '账号数据库未配置，请先配置 DATABASE_URL。', 'DATABASE_NOT_CONFIGURED');
    let phase = 'database.initialize';
    try {
      await this.options.store.initialize();
      phase = 'database.query';
      return await read(this.options.store);
    } catch (error) {
      logBackend('error', 'dependency.failed', { component: 'task-runs', phase, error });
      throw new ApiError(503, '任务记录暂时不可用，请稍后重试。', 'TASK_RUNS_UNAVAILABLE');
    }
  }
  private publicTask(event: LoginEvent): RunTask {
    return { id: event.id, createdAt: event.createdAt, expiresAt: event.expiresAt,
      userOptions: { ...event.userOptions }, loginType: event.loginType ?? DEFAULT_LOGIN_TYPE,
      status: event.status === 'failed' ? 'failed' : Date.parse(event.expiresAt) <= this.now() ? 'expired' : event.status };
  }
  async getLatest(userId: string): Promise<{ task: RunTask | null }> {
    // Deliberately bypass LoginEventService.resume: reading logs must never dispatch a job.
    const event = await this.database(store => store.getLatestForUser(userId));
    return { task: event ? this.publicTask(event) : null };
  }
  private async callRedis(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (!this.config.redisUrl) throw new ApiError(503, 'Redis 未配置，请先配置 REDIS_URL。', 'REDIS_NOT_CONFIGURED');
    let connection: NonNullable<TaskRunService['connection']> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let phase = 'redis.connect';
    try {
      connection = this.connection ??= { driver: (this.options.createDriver ?? (() => createRedisDriver(this.config)))() };
      const current = connection;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Redis request timed out')); }, this.config.timeoutMs);
      });
      const operation = async () => {
        if (!current.driver.isReady) { current.opening ??= current.driver.connect(); await current.opening; }
        phase = 'redis.command';
        controller.signal.throwIfAborted();
        return await current.driver.eval(script, { keys, arguments: args }, controller.signal);
      };
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      logBackend('error', 'dependency.failed', { component: 'task-runs', phase, timeoutMs: this.config.timeoutMs, error });
      if (connection) { if (this.connection === connection) this.connection = undefined; connection.driver.destroy(); }
      throw new ApiError(503, '任务日志暂时不可用，请稍后重试。', 'TASK_LOGS_UNAVAILABLE');
    } finally { if (timer) clearTimeout(timer); }
  }
  async interrupt(taskId: string): Promise<{ taskId: string; status: 'interrupted' }> {
    if (taskId !== taskId.trim() || !taskIdPattern.test(taskId)) throw new ApiError(400, '无效的任务编号。');
    const result = await this.callRedis(interruptRunScript, [`${this.config.redisQueueKey}:runs:${taskId}`],
      [taskId, new Date(this.now()).toISOString()]);
    if (result === 0) throw new ApiError(404, '执行记录不存在或已过期，请刷新列表。', 'TASK_RUN_NOT_FOUND');
    if (result === 3) throw new ApiError(409, '任务已经结束，无法中断，请刷新列表。', 'TASK_NOT_RUNNING');
    if (result !== 1 && result !== 2) throw invalidData();
    return { taskId, status: 'interrupted' };
  }
  async getSummaries(taskIds: string[]): Promise<Array<TaskRun | null>> {
    if (!taskIds.length) return [];
    if (taskIds.length > 100 || taskIds.some(id => !taskIdPattern.test(id))) throw new ApiError(400, '无效的任务编号。');
    // GET only: the administrator list never dispatches work or reads worker logs.
    const raw = await this.callRedis(`local results = {}
      for i, key in ipairs(KEYS) do results[i] = redis.call('GET', key) or false end
      return results`, taskIds.map(id => `${this.config.redisQueueKey}:runs:${id}`), []);
    if (!Array.isArray(raw) || raw.length !== taskIds.length) throw invalidData();
    return raw.map((value, index) => parseRun(value, taskIds[index]));
  }
  async getFailureDetails(taskId: string): Promise<DailyTaskFailureDetails> {
    if (taskId !== taskId.trim() || !taskIdPattern.test(taskId)) throw new ApiError(400, '无效的任务编号。');
    const archived = await this.readArchive(taskId, '0-0', undefined, true);
    if (archived?.page) return this.failureDetails(taskId, archived.run, archived.page.logs.slice(0, failureLogLimit),
      archived.page.truncated || archived.page.hasMore);
    if (archived?.run?.logSource) return this.waitingFailure(taskId, archived.run);
    const raw = await this.callRedis(failureSnapshotScript,
      [`${this.config.redisQueueKey}:runs:${taskId}`, `${this.config.redisQueueKey}:logs:${taskId}`], [String(failureLogLimit + 1)]);
    if (!Array.isArray(raw) || raw.length !== 2 || !Array.isArray(raw[1]) || raw[1].length > failureLogLimit + 1) throw invalidData();
    const run = parseRun(raw[0], taskId);
    if (run?.logSource) return this.waitingFailure(taskId, run);
    const newestLogs: TaskLog[] = [];
    let previous: string | undefined;
    let truncated = raw[1].length > failureLogLimit;
    for (const entry of raw[1] as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2 || !isStreamCursor(entry[0])
        || previous !== undefined && compareIds(entry[0], previous) >= 0) throw invalidData();
      previous = entry[0];
      const log = parseLog(entry[0], entry[1]);
      if (log) newestLogs.push(log); else truncated = true;
    }
    const logs = newestLogs.slice(0, failureLogLimit);
    return this.failureDetails(taskId, run, logs, truncated);
  }
  private failureDetails(taskId: string, run: TaskRun | null, logs: TaskLog[], truncated: boolean): DailyTaskFailureDetails {
    const failure = logs.find(log => log.level === 'ERROR' && /^具体错误：\s*\S/.test(log.message))
      ?? logs.find(log => log.level === 'ERROR' && !isGenericFailure(log.message, run?.errorCode));
    const action = logs.find(log => log.level === 'INFO' && (log.actionIndex ?? 0) > 0 && /^动作\s*\d+\s*\/\s*\d+\s*[：:]/.test(log.message));
    return { taskId,
      ...(run?.errorCode ? { errorCode: run.errorCode } : {}),
      errorMessage: failure?.message ?? taskFailureMessage(run?.errorCode, '未记录具体错误原因，执行日志可能尚未上报或已过期。'),
      ...(run?.actionIndex !== undefined ? { actionIndex: run.actionIndex, actionTotal: run.actionTotal } : {}),
      ...(action ? { actionName: action.message.replace(/^动作\s*\d+\s*\/\s*\d+\s*[：:]\s*/, '') } : {}),
      logs: logs.reverse(), truncated };
  }
  private waitingFailure(taskId: string, run: TaskRun): DailyTaskFailureDetails {
    return { ...this.failureDetails(taskId, run, [], false), logsPending: run.logSource === 'sls',
      errorMessage: run.logSource === 'sls' ? '执行日志正在上传或暂时不可用，请稍后重试。' : '本次任务未启用执行日志记录。' };
  }
  private waitingPage(taskId: string, run: TaskRun, after: string, snapshot?: string): DailyTaskLogPage {
    const candidate = snapshot ?? run.logCursor ?? after;
    const upper = compareIds(candidate, after) < 0 ? after : candidate;
    const pending = run.logSource === 'sls';
    return { taskId, status: run.status, logs: [], nextCursor: pending ? after : upper,
      snapshotCursor: upper, hasMore: false, truncated: false, logsPending: pending };
  }
  async getAdminLogPage(taskId: string, after = '0-0', snapshot?: string): Promise<DailyTaskLogPage> {
    if (taskId !== taskId.trim() || !taskIdPattern.test(taskId)) throw new ApiError(400, '无效的任务编号。');
    if (!isStreamCursor(after) || snapshot !== undefined && (!isStreamCursor(snapshot) || compareIds(after, snapshot) > 0)) {
      throw new ApiError(400, '无效的日志读取位置。');
    }
    const archived = await this.readArchive(taskId, after, snapshot);
    if (archived?.page) return { taskId, status: archived.run?.status ?? null, ...archived.page, logsPending: false };
    if (archived?.run?.logSource) return this.waitingPage(taskId, archived.run, after, snapshot);
    const raw = await this.callRedis(adminLogSnapshotScript,
      [`${this.config.redisQueueKey}:runs:${taskId}`, `${this.config.redisQueueKey}:logs:${taskId}`],
      [after, snapshot ?? '', String(pageSize + 1)]);
    if (!Array.isArray(raw) || raw.length !== 7 || !Array.isArray(raw[1]) || raw[1].length > pageSize + 1
      || !isStreamCursor(raw[2]) || snapshot !== undefined && raw[2] !== snapshot
      || typeof raw[3] !== 'string' || raw[3] !== '' && !isStreamCursor(raw[3])
      || !Number.isSafeInteger(raw[4]) || raw[4] < 0 || !Number.isSafeInteger(raw[5]) || raw[5] < 0 || raw[4] < raw[5]
      || raw[6] !== 0 && raw[6] !== 1) throw invalidData();
    const run = parseRun(raw[0], taskId);
    if (run?.logSource) return this.waitingPage(taskId, run, after, snapshot);
    const snapshotCursor = raw[2];
    if (compareIds(after, snapshotCursor) > 0) throw new ApiError(400, '无效的日志读取位置。');
    const logs: TaskLog[] = [];
    let nextCursor = after;
    let previous = after;
    let truncated = raw[6] === 0 && (after !== '0-0' || snapshotCursor !== '0-0') || raw[4] > raw[5]
      || after !== '0-0' && raw[3] !== '' && compareIds(after, raw[3]) < 0;
    for (const [index, entry] of (raw[1] as unknown[]).entries()) {
      if (!Array.isArray(entry) || entry.length !== 2 || !isStreamCursor(entry[0])
        || compareIds(entry[0], previous) <= 0 || compareIds(entry[0], snapshotCursor) > 0) throw invalidData();
      previous = entry[0];
      const log = parseLog(entry[0], entry[1]);
      if (!log) truncated = true;
      if (index < pageSize) {
        nextCursor = entry[0];
        if (log) logs.push(log);
      }
    }
    const hasMore = raw[1].length > pageSize;
    if (!hasMore && compareIds(nextCursor, snapshotCursor) < 0) {
      // Entries still inside the fixed snapshot have disappeared between pages.
      truncated = true;
      nextCursor = snapshotCursor;
    }
    return { taskId, status: run?.status ?? null, logs, nextCursor, snapshotCursor, hasMore, truncated };
  }
  private async readArchive(taskId: string, after: string, snapshot?: string, tail = false, live = false) {
    if (!this.archive) return null;
    let run: TaskRun | null = null;
    let redisFailure: unknown;
    try {
      const raw = await this.callRedis(archiveStateScript, [`${this.config.redisQueueKey}:runs:${taskId}`], []);
      run = parseRun(raw, taskId);
    } catch (error) { redisFailure = error; }
    // A rejection can publish its source before its first emit has a cursor. That gap is not completion.
    if (run?.logSource === 'disabled' || run?.logSource === 'sls' && (!run.logCursor || run.logCursor === '0-0')) return { run, page: null };
    try {
      // Active tasks keep polling: show the indexed prefix now, but require the final watermark before stopping.
      const activeLive = live && run && !['completed', 'failed', 'interrupted', 'expired'].includes(run.status);
      const page = await this.archive.read(taskId, after, snapshot, activeLive ? undefined : run?.logCursor, tail);
      if (page) return { run, page };
    } catch (error) {
      logBackend('warn', 'sls.read_failed', { component: 'task-runs', phase: 'sls.query', error });
    }
    // Do not repeat an already failed Redis call after spending the archive query budget.
    if (redisFailure) throw redisFailure;
    return { run, page: null };
  }
  async getEvents(taskId: string, userId: string, after = '0-0'): Promise<TaskRunEvents> {
    if (taskId !== taskId.trim() || !taskIdPattern.test(taskId)) throw new ApiError(400, '无效的任务编号。');
    if (!isStreamCursor(after)) throw new ApiError(400, '无效的日志读取位置。');
    // The durable database owns authorization even after QR/session Redis TTLs expire.
    const event = await this.database(store => store.getEvent(taskId, userId));
    if (!event) throw new ApiError(404, '任务不存在或不属于当前账号。');
    const archived = await this.readArchive(taskId, after, undefined, false, true);
    if (archived?.page) {
      const { logs, nextCursor, hasMore, truncated } = archived.page;
      return { task: this.publicTask(event), run: archived.run, logs, nextCursor, hasMore, truncated, logsPending: false };
    }
    if (archived?.run?.logSource) return { task: this.publicTask(event), run: archived.run, logs: [], nextCursor: after,
      hasMore: false, truncated: false, logsPending: archived.run.logSource === 'sls' };
    const raw = await this.callRedis(snapshotScript,
      [`${this.config.redisQueueKey}:runs:${event.id}`, `${this.config.redisQueueKey}:logs:${event.id}`], [after, String(pageSize + 1)]);
    if (!Array.isArray(raw) || raw.length !== 5 || !Array.isArray(raw[1]) || raw[1].length > pageSize + 1
      || typeof raw[2] !== 'string' || raw[2] !== '' && !isStreamCursor(raw[2])
      || !Number.isSafeInteger(raw[3]) || !Number.isSafeInteger(raw[4])) throw invalidData();
    const run = parseRun(raw[0], event.id);
    if (run?.logSource) return { task: this.publicTask(event), run, logs: [], nextCursor: after,
      hasMore: false, truncated: false, logsPending: run.logSource === 'sls' };
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
