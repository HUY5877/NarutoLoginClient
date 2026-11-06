import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient } from 'redis';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { logBackend } from './logging.js';
import { loginFailure, type TaskFailureCode } from '../shared/task-errors.js';
import { parseUserOptions, type UserOptions } from '../shared/user-options.js';
import { DEFAULT_LOGIN_TYPE, parseLoginType, type LoginType } from '../shared/login-types.js';
import { effectiveRunStatus, RUN_RETENTION_MS, runStatuses, terminalRun, type RunStatus } from './task-state.js';

export type Status = 'queued' | 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'qr_ready' | 'failed' | 'expired';
export interface Task {
  id: string;
  status: Status;
  createdAt: string;
  expiresAt: string;
  simulation: true;
  userOptions?: UserOptions;
  loginType?: LoginType;
  error?: string;
  errorCode?: TaskFailureCode;
  loginStartedAt?: string;
  loginAuthorized?: boolean;
  scanCaptured?: boolean;
  refreshSupported?: boolean;
  refreshRequestId?: string;
  qrRevision?: string;
  runStatus?: RunStatus;
}
export interface Submission {
  id: string; userId: string; accessToken: string; createdAt: string; expiresAt: string;
  userOptions: UserOptions;
  loginType?: LoginType;
}
export function taskOccupiesAccount(task: Task, now: number): boolean {
  if (task.runStatus) return !terminalRun(task.runStatus);
  return task.status !== 'failed' && task.status !== 'expired'
    && (task.loginAuthorized === true || Date.parse(task.expiresAt) > now);
}
interface StoredTask extends Omit<Task, 'status'> {
  status: Status | RunStatus; userId?: string; tokenHash: string; loginExpiresAt?: string;
  taskId?: string; authorizedAt?: string; startedAt?: string | null; scanCapturedAt?: string;
}
type QueueConfig = Pick<Config, 'redisUrl' | 'redisQueueKey' | 'timeoutMs' | 'ossPrefix'>;
interface EvalOptions { keys: string[]; arguments: string[] }
export interface RedisDriver {
  readonly isReady: boolean;
  connect(): Promise<void>;
  eval(script: string, options: EvalOptions, signal: AbortSignal): Promise<unknown>;
  get(key: string, signal: AbortSignal): Promise<string | null>;
  destroy(): void;
}

// Redis scripts are atomic, but command errors do not roll back earlier writes.
// Check the account lock and all key types before writing. A failed LPUSH must
// restore the previous lock as well as remove the newly created session.
const enqueueScript = `
local submitted = cjson.decode(ARGV[1])
local existing = redis.call('GET', KEYS[2])
if existing then
  local decoded, persisted = pcall(cjson.decode, existing)
  if decoded and type(persisted) == 'table' and persisted.id == submitted.id
      and persisted.userId == submitted.userId and persisted.tokenHash == submitted.tokenHash
      and persisted.createdAt == submitted.createdAt and persisted.expiresAt == submitted.expiresAt
      and (persisted.loginType or 'android_qq') == submitted.loginType then
    -- Outbox delivery may retry after a worker has already advanced this session.
    -- Acknowledge the same submission without renewing TTLs or touching its lock.
    return 0
  end
  return redis.error_reply('Login session already exists')
end
local queueType = redis.call('TYPE', KEYS[1]).ok
if queueType ~= 'none' and queueType ~= 'list' then
  return redis.error_reply('Login queue must be a list')
end
local activeId = redis.call('GET', KEYS[3])
local previousLockTtl = redis.call('PTTL', KEYS[3])
local function occupied(key, trustedHistory)
  local activeRaw = redis.call('GET', key)
  if not activeRaw then return false end
  local decoded, active = pcall(cjson.decode, activeRaw)
  if not decoded or type(active) ~= 'table' or type(active.status) ~= 'string' then
    error('Invalid active task run')
  end
  if active.userId ~= submitted.userId and not (trustedHistory and active.userId == nil) then
    error('Invalid active task owner')
  end
  if active.status == 'completed' or active.status == 'failed' or active.status == 'interrupted' or active.status == 'expired' then return false end
  if active.status == 'finishing_login' or active.status == 'running_daily'
    or active.loginAuthorized == true or type(active.authorizedAt) == 'string' or type(active.startedAt) == 'string' then return true end
  local deadline = active.loginExpiresAt or active.expiresAt
  if type(deadline) ~= 'string' then error('Missing active task deadline') end
  return deadline > ARGV[4]
end
if activeId then
  local activeKey = KEYS[1] .. ':runs:' .. activeId
  local trusted = false
  for i = 4, #KEYS do if KEYS[i] == activeKey then trusted = true end end
  if occupied(activeKey, trusted) then return -1 end
end
-- History comes from this authenticated user's durable rows. Check it in the
-- same transaction, including legacy runs whose short account index expired.
for i = 4, #KEYS do if occupied(KEYS[i], true) then return -1 end end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
local locked = redis.pcall('SET', KEYS[3], submitted.id, 'PX', ARGV[2])
if type(locked) == 'table' and locked.err then
  redis.call('DEL', KEYS[2])
  return locked
end
local queued = redis.pcall('LPUSH', KEYS[1], ARGV[3])
if type(queued) == 'table' and queued.err then
  redis.call('DEL', KEYS[2])
  if redis.call('GET', KEYS[3]) == submitted.id then
    if activeId and previousLockTtl > 0 then
      redis.call('SET', KEYS[3], activeId, 'PX', previousLockTtl)
    elseif activeId and previousLockTtl == -1 then
      redis.call('SET', KEYS[3], activeId)
    else
      redis.call('DEL', KEYS[3])
    end
  end
  return queued
end
return 1
`;

const statuses = new Set<string>([...runStatuses, 'qr_ready']);
// Coalesce clicks across tabs. Only the owning worker acknowledges this command
// after the replacement image has been uploaded; reads never consume it.
const refreshScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end
local s = cjson.decode(raw)
if s.id ~= ARGV[1] or s.userId ~= ARGV[2] then return -1 end
if s.status == 'failed' or s.status == 'expired' or s.status == 'completed' or s.status == 'interrupted' then return -2 end
if s.status == 'finishing_login' or s.status == 'running_daily'
  or s.loginAuthorized == true or type(s.authorizedAt) == 'string' or type(s.startedAt) == 'string' then
  s.loginAuthorized = true
  return cjson.encode(s)
end
local deadline = s.loginExpiresAt or s.expiresAt
if deadline <= ARGV[3] or redis.call('PTTL', KEYS[1]) <= 0 then return -2 end
if type(s.scanCapturedAt) == 'string' then s.scanCaptured = true end
if s.loginAuthorized == true then return cjson.encode(s) end
if s.scanCaptured == true then
  s.refreshRequestId = nil
  s.status = 'waiting_scan'
  redis.call('SET', KEYS[1], cjson.encode(s), 'KEEPTTL')
  redis.call('DEL', KEYS[2])
  return cjson.encode(s)
end
if s.refreshSupported ~= true then return -3 end
if s.status ~= 'waiting_scan' and s.status ~= 'qr_ready' and not s.refreshRequestId then return -4 end
if not redis.call('GET', KEYS[2]) then
  local command = cjson.decode(ARGV[4])
  command.loginType = s.loginType or 'android_qq'
  redis.call('SET', KEYS[2], cjson.encode(command), 'EX', 600)
  s.refreshRequestId = ARGV[5]
end
s.status = 'preparing_qr'
redis.call('SET', KEYS[1], cjson.encode(s), 'KEEPTTL')
return cjson.encode(s)
`;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const missingSession = () => new ApiError(404, '登录申请不存在或已失效，请重新生成二维码。');
const invalidSession = () => new ApiError(502, '登录申请数据无效，请重新生成二维码。');

function parseSession(raw: string, id: string, userId?: string, trusted?: Submission): StoredTask {
  let record: StoredTask;
  try { record = JSON.parse(raw) as StoredTask; }
  catch { throw invalidSession(); }
  // Old workers only stored a summary. The database proves ownership; do not
  // write it back while that worker could still publish its legacy snapshots.
  if (record && record.taskId === id && record.id === undefined && record.userId === undefined
    && trusted?.id === id && trusted.userId === userId && statuses.has(record.status)) {
    record = { ...record, id, userId, createdAt: trusted.createdAt, expiresAt: trusted.expiresAt,
      simulation: true, tokenHash: hash(trusted.accessToken), userOptions: trusted.userOptions,
      loginType: trusted.loginType ?? DEFAULT_LOGIN_TYPE };
  }
  if (userId !== undefined && (!record || record.userId !== userId)) throw missingSession();
  if (!record || record.id !== id || record.taskId !== undefined && record.taskId !== id
    || record.simulation !== true || !statuses.has(record.status)
    || typeof record.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.tokenHash)
    || typeof record.createdAt !== 'string' || typeof record.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.expiresAt))
    || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
    throw invalidSession();
  }
  const loginType = parseLoginType(record.loginType);
  if (!loginType) throw invalidSession();
  record.loginType = loginType;
  if (record.userOptions !== undefined) {
    const userOptions = parseUserOptions(record.userOptions);
    if (!userOptions) throw invalidSession();
    record.userOptions = userOptions;
  }
  if (record.loginExpiresAt !== undefined && (typeof record.loginExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(record.loginExpiresAt))
    || typeof record.loginStartedAt !== 'string' || !Number.isFinite(Date.parse(record.loginStartedAt))
    || Date.parse(record.loginExpiresAt) - Date.parse(record.loginStartedAt) !== 600_000)) throw invalidSession();
  for (const value of [record.refreshRequestId, record.qrRevision]) {
    if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value))) throw invalidSession();
  }
  return record;
}

function createRedisDriver(config: QueueConfig): RedisDriver {
  const client = createClient({
    url: config.redisUrl,
    socket: { connectTimeout: config.timeoutMs, reconnectStrategy: false },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000,
  });
  // The request receives a sanitized error; never log a URL containing credentials.
  client.on('error', () => {});
  return {
    get isReady() { return client.isReady; },
    async connect() { await client.connect(); },
    eval: (script, options, signal) => client.withAbortSignal(signal).eval(script, options),
    get: (key, signal) => client.withAbortSignal(signal).get(key),
    destroy() { if (client.isOpen) client.destroy(); },
  };
}

export class TaskService {
  private connection?: { driver: RedisDriver; opening?: Promise<void> };

  constructor(
    private config: QueueConfig,
    private createDriver: () => RedisDriver = () => createRedisDriver(config),
    private now = Date.now,
  ) {}

  private async request<T>(command: (driver: RedisDriver, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.config.redisUrl) throw new ApiError(503, 'Redis 未配置，请先配置 REDIS_URL。', 'REDIS_NOT_CONFIGURED');
    let connection: NonNullable<TaskService['connection']> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let phase = 'redis.connect';
    try {
      connection = this.connection ??= { driver: this.createDriver() };
      const current = connection;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Redis request timed out'));
        }, this.config.timeoutMs);
      });
      const operation = async () => {
        if (!current.driver.isReady) {
          current.opening ??= current.driver.connect();
          await current.opening;
        }
        phase = 'redis.command';
        controller.signal.throwIfAborted();
        return await command(current.driver, controller.signal);
      };
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logBackend('error', 'dependency.failed', { component: 'queue', phase, timeoutMs: this.config.timeoutMs, error });
      if (connection) {
        if (this.connection === connection) this.connection = undefined;
        connection.driver.destroy();
      }
      throw new ApiError(503, 'Redis 暂时不可用，请检查连接配置后重试。', 'REDIS_UNAVAILABLE');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async enqueue(task: Submission, previousTaskIds: readonly string[] = []): Promise<void> {
    const loginType = parseLoginType(task.loginType);
    if (!loginType) throw invalidSession();
    const now = this.now();
    const ttl = Date.parse(task.expiresAt) - now;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new ApiError(410, '登录申请已过期，请重新生成二维码。');
    const record = JSON.stringify({ id: task.id, taskId: task.id, userId: task.userId, status: 'queued', createdAt: task.createdAt,
      expiresAt: task.expiresAt, updatedAt: task.createdAt, startedAt: null, finishedAt: null,
      simulation: true, tokenHash: hash(task.accessToken), userOptions: task.userOptions, loginType });
    const payload = JSON.stringify({ version: 1, id: task.id, createdAt: task.createdAt,
      expiresAt: task.expiresAt, objectKey: `${this.config.ossPrefix}/${task.id}/qr.png`, userOptions: task.userOptions,
      loginTimeoutSeconds: 600, loginType });
    const result = await this.request((driver, signal) => driver.eval(enqueueScript, {
      keys: [this.config.redisQueueKey, this.runKey(task.id), this.activeKey(task.userId),
        ...previousTaskIds.filter(id => id !== task.id).map(id => this.runKey(id))],
      arguments: [record, String(Math.max(ttl, RUN_RETENTION_MS)), payload, new Date(now).toISOString()],
    }, signal));
    if (result === -1) throw new ApiError(409, '当前账号已有任务，请等待任务结束后重试。', 'ACTIVE_LOGIN_SESSION');
    if (result !== 0 && result !== 1) throw new ApiError(502, 'Redis 返回了无效结果，请重新申请。');
  }

  async get(id: string, token: string): Promise<Task> {
    const raw = await this.request((driver, signal) => driver.get(this.runKey(id), signal));
    if (raw === null) throw missingSession();
    const record = parseSession(raw, id);
    if (!timingSafeEqual(Buffer.from(record.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'))) throw missingSession();
    return this.publicTask(record);
  }

  async getForUser(id: string, userId: string, trusted?: Submission): Promise<Task> {
    const raw = await this.request((driver, signal) => driver.get(this.runKey(id), signal));
    if (raw === null) throw missingSession();
    const record = parseSession(raw, id, userId, trusted);
    return this.publicTask(record);
  }

  async getActive(userId: string): Promise<Task | null> {
    const active = await this.request(async (driver, signal) => {
      const id = await driver.get(this.activeKey(userId), signal);
      if (id === null) return null;
      return { id, raw: await driver.get(this.runKey(id), signal) };
    });
    if (active === null || active.raw === null) return null;
    // Legacy summaries have no account identity; only a trusted database row
    // can bind them. LoginEventService's history recovery does that separately.
    try { const value = JSON.parse(active.raw); if (value?.taskId === active.id && value.id === undefined && value.userId === undefined) return null; }
    catch { throw invalidSession(); }
    const record = parseSession(active.raw, active.id);
    if (record.userId !== userId) return null;
    const task = this.publicTask(record);
    // Only enqueue replaces stale locks atomically. Deleting a stale snapshot
    // here could remove a newer request's lock while these two GETs are in flight.
    return task.status === 'failed' || task.status === 'expired' ? null : task;
  }

  async requestRefresh(id: string, userId: string): Promise<Task> {
    const requestId = randomUUID(), requestedAt = new Date(this.now()).toISOString();
    const result = await this.request((driver, signal) => driver.eval(refreshScript, {
      keys: [this.runKey(id), `${this.config.redisQueueKey}:refresh:${id}`],
      arguments: [id, userId, requestedAt, JSON.stringify({ taskId: id, requestId, requestedAt }), requestId],
    }, signal));
    if (result === -1) throw missingSession();
    if (result === -2) throw new ApiError(410, '本次模拟器占用已结束，请重新启动模拟器。');
    if (result === -3) throw new ApiError(409, '执行服务器尚不支持刷新二维码，请更新并重启执行服务。', 'REFRESH_UNSUPPORTED');
    if (result === -4) throw new ApiError(409, '模拟器正在准备二维码，请稍候。', 'QR_NOT_READY');
    if (typeof result !== 'string') throw invalidSession();
    return this.publicTask(parseSession(result, id, userId));
  }

  private runKey(id: string) { return `${this.config.redisQueueKey}:runs:${id}`; }
  private activeKey(userId: string) { return `${this.config.redisQueueKey}:users:${userId}:active`; }

  private publicTask(record: StoredTask): Task {
    const expiresAt = record.loginExpiresAt ?? record.expiresAt;
    const runStatus = effectiveRunStatus(record, this.now());
    const status: Status = runStatus === 'waiting_scan' || runStatus === 'finishing_login' || runStatus === 'running_daily'
      ? 'qr_ready' : runStatus === 'completed' ? 'expired' : runStatus === 'interrupted' ? 'failed' : runStatus;
    return { id: record.id, status, ...(record.taskId ? { runStatus } : {}),
      createdAt: record.createdAt, expiresAt, simulation: true, loginType: record.loginType ?? DEFAULT_LOGIN_TYPE,
      ...(record.loginStartedAt ? { loginStartedAt: record.loginStartedAt } : {}),
      ...(record.loginAuthorized === true || runStatus === 'finishing_login' || runStatus === 'running_daily'
        || record.authorizedAt ? { loginAuthorized: true } : {}),
      ...(record.scanCaptured === true || record.scanCapturedAt ? { scanCaptured: true } : {}),
      ...(record.refreshSupported === true ? { refreshSupported: true } : {}),
      ...(record.refreshRequestId ? { refreshRequestId: record.refreshRequestId } : {}),
      ...(record.qrRevision ? { qrRevision: record.qrRevision } : {}),
      ...(record.userOptions ? { userOptions: record.userOptions } : {}),
      ...(status === 'failed' ? loginFailure(record.errorCode) : {}) };
  }

  close() {
    this.connection?.driver.destroy();
    this.connection = undefined;
  }
}
