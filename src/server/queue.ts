import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from 'redis';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { loginFailure, type TaskFailureCode } from '../shared/task-errors.js';

export type Status = 'queued' | 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'qr_ready' | 'failed' | 'expired';
export interface Task {
  id: string;
  status: Status;
  createdAt: string;
  expiresAt: string;
  simulation: true;
  error?: string;
  errorCode?: TaskFailureCode;
}
export interface Submission { id: string; userId: string; accessToken: string; createdAt: string; expiresAt: string }
interface StoredTask extends Task { userId?: string; tokenHash: string }
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
      and persisted.createdAt == submitted.createdAt and persisted.expiresAt == submitted.expiresAt then
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
if activeId then
  local activeRaw = redis.call('GET', KEYS[1] .. ':sessions:' .. activeId)
  if activeRaw then
    local decoded, active = pcall(cjson.decode, activeRaw)
    if not decoded or type(active) ~= 'table' or active.id ~= activeId
        or active.userId ~= submitted.userId or type(active.status) ~= 'string'
        or type(active.expiresAt) ~= 'string' then
      return redis.error_reply('Invalid active login session')
    end
    if active.status ~= 'failed' and active.status ~= 'expired' and active.expiresAt > ARGV[4] then
      return -1
    end
  end
end
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
-- The submission event precedes every worker event because the whole dispatch
-- runs atomically. A repeated outbox delivery returns above without adding it.
-- Logging failure must not turn an already accepted job into a failed POST.
local logType = redis.pcall('TYPE', KEYS[4])
local logKind = type(logType) == 'table' and logType.ok
if logKind == 'none' or logKind == 'stream' then
  local logged = redis.pcall('XADD', KEYS[4], 'MAXLEN', 2000, '*', 'json', ARGV[5])
  if type(logged) == 'string' then redis.pcall('EXPIRE', KEYS[4], 86400) end
end
return 1
`;

const statuses = new Set<Status>(['queued', 'starting_emulator', 'opening_game', 'preparing_qr', 'qr_ready', 'failed', 'expired']);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const missingSession = () => new ApiError(404, '登录申请不存在或已失效，请重新生成二维码。');
const invalidSession = () => new ApiError(502, '登录申请数据无效，请重新生成二维码。');

function parseSession(raw: string, id: string, userId?: string): StoredTask {
  let record: StoredTask;
  try { record = JSON.parse(raw) as StoredTask; }
  catch { throw invalidSession(); }
  if (userId !== undefined && (!record || record.userId !== userId)) throw missingSession();
  if (!record || record.id !== id || record.simulation !== true || !statuses.has(record.status)
    || typeof record.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.tokenHash)
    || typeof record.createdAt !== 'string' || typeof record.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.expiresAt))
    || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
    throw invalidSession();
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
        controller.signal.throwIfAborted();
        return await command(current.driver, controller.signal);
      };
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (connection) {
        if (this.connection === connection) this.connection = undefined;
        connection.driver.destroy();
      }
      throw new ApiError(503, 'Redis 暂时不可用，请检查连接配置后重试。', 'REDIS_UNAVAILABLE');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async enqueue(task: Submission): Promise<void> {
    const now = this.now();
    const ttl = Date.parse(task.expiresAt) - now;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new ApiError(410, '登录申请已过期，请重新生成二维码。');
    const record = JSON.stringify({ id: task.id, userId: task.userId, status: 'queued', createdAt: task.createdAt,
      expiresAt: task.expiresAt, simulation: true, tokenHash: hash(task.accessToken) });
    const payload = JSON.stringify({ version: 1, id: task.id, createdAt: task.createdAt,
      expiresAt: task.expiresAt, objectKey: `${this.config.ossPrefix}/${task.id}/qr.png` });
    const submittedLog = JSON.stringify({ time: task.createdAt, level: 'INFO',
      message: '登录申请已提交，等待执行服务器领取任务。' });
    const result = await this.request((driver, signal) => driver.eval(enqueueScript, {
      keys: [this.config.redisQueueKey, this.sessionKey(task.id), this.activeKey(task.userId),
        `${this.config.redisQueueKey}:logs:${task.id}`],
      arguments: [record, String(ttl), payload, new Date(now).toISOString(), submittedLog],
    }, signal));
    if (result === -1) throw new ApiError(409, '当前账号已有登录申请，请等待二维码过期或申请失败后重试。', 'ACTIVE_LOGIN_SESSION');
    if (result !== 0 && result !== 1) throw new ApiError(502, 'Redis 返回了无效结果，请重新申请。');
  }

  async get(id: string, token: string): Promise<Task> {
    const raw = await this.request((driver, signal) => driver.get(this.sessionKey(id), signal));
    if (raw === null) throw missingSession();
    const record = parseSession(raw, id);
    if (!timingSafeEqual(Buffer.from(record.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'))) throw missingSession();
    return this.publicTask(record);
  }

  async getForUser(id: string, userId: string): Promise<Task> {
    const raw = await this.request((driver, signal) => driver.get(this.sessionKey(id), signal));
    if (raw === null) throw missingSession();
    const record = parseSession(raw, id, userId);
    return this.publicTask(record);
  }

  async getActive(userId: string): Promise<Task | null> {
    const active = await this.request(async (driver, signal) => {
      const id = await driver.get(this.activeKey(userId), signal);
      if (id === null) return null;
      return { id, raw: await driver.get(this.sessionKey(id), signal) };
    });
    if (active === null || active.raw === null) return null;
    const record = parseSession(active.raw, active.id);
    if (record.userId !== userId) return null;
    const task = this.publicTask(record);
    // Only enqueue replaces stale locks atomically. Deleting a stale snapshot
    // here could remove a newer request's lock while these two GETs are in flight.
    return task.status === 'failed' || task.status === 'expired' ? null : task;
  }

  private sessionKey(id: string) { return `${this.config.redisQueueKey}:sessions:${id}`; }
  private activeKey(userId: string) { return `${this.config.redisQueueKey}:users:${userId}:active`; }

  private publicTask(record: StoredTask): Task {
    return { id: record.id, status: record.status === 'failed' ? 'failed' : this.now() >= Date.parse(record.expiresAt) ? 'expired' : record.status,
      createdAt: record.createdAt, expiresAt: record.expiresAt, simulation: true,
      ...(record.status === 'failed' ? loginFailure(record.errorCode) : {}) };
  }

  close() {
    this.connection?.driver.destroy();
    this.connection = undefined;
  }
}
