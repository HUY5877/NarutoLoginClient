import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from 'redis';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

export type Status = 'queued' | 'starting_emulator' | 'opening_game' | 'preparing_qr' | 'qr_ready' | 'failed' | 'expired';
export interface Task {
  id: string;
  status: Status;
  createdAt: string;
  expiresAt: string;
  simulation: true;
  error?: string;
}
export interface Submission { id: string; accessToken: string; createdAt: string; expiresAt: string }
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
// Check types before writing and remove the session if LPUSH itself fails.
const enqueueScript = `
local queueType = redis.call('TYPE', KEYS[1]).ok
if queueType ~= 'none' and queueType ~= 'list' then
  return redis.error_reply('Login queue must be a list')
end
local existing = redis.call('GET', KEYS[2])
if existing then
  if existing == ARGV[1] then return 0 end
  return redis.error_reply('Login session already exists')
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
local queued = redis.pcall('LPUSH', KEYS[1], ARGV[3])
if type(queued) == 'table' and queued.err then
  redis.call('DEL', KEYS[2])
  return queued
end
return 1
`;

const statuses = new Set<Status>(['queued', 'starting_emulator', 'opening_game', 'preparing_qr', 'qr_ready', 'failed', 'expired']);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const missingSession = () => new ApiError(404, '登录申请不存在或已失效，请重新生成二维码。');

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
    } catch {
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
    const ttl = Date.parse(task.expiresAt) - this.now();
    if (!Number.isFinite(ttl) || ttl <= 0) throw new ApiError(410, '登录申请已过期，请重新生成二维码。');
    const record = JSON.stringify({ id: task.id, status: 'queued', createdAt: task.createdAt,
      expiresAt: task.expiresAt, simulation: true, tokenHash: hash(task.accessToken) });
    const payload = JSON.stringify({ version: 1, id: task.id, createdAt: task.createdAt,
      expiresAt: task.expiresAt, objectKey: `${this.config.ossPrefix}/${task.id}/qr.png` });
    const result = await this.request((driver, signal) => driver.eval(enqueueScript, {
      keys: [this.config.redisQueueKey, `${this.config.redisQueueKey}:sessions:${task.id}`],
      arguments: [record, String(ttl), payload],
    }, signal));
    if (result !== 0 && result !== 1) throw new ApiError(502, 'Redis 返回了无效结果，请重新申请。');
  }

  async get(id: string, token: string): Promise<Task> {
    const raw = await this.request((driver, signal) => driver.get(`${this.config.redisQueueKey}:sessions:${id}`, signal));
    if (raw === null) throw missingSession();
    let record: Task & { tokenHash: string };
    try { record = JSON.parse(raw) as typeof record; }
    catch { throw new ApiError(502, '登录申请数据无效，请重新生成二维码。'); }
    if (!record || record.id !== id || record.simulation !== true || !statuses.has(record.status)
      || typeof record.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.tokenHash)
      || typeof record.createdAt !== 'string' || typeof record.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.expiresAt))
      || Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
      throw new ApiError(502, '登录申请数据无效，请重新生成二维码。');
    }
    if (!timingSafeEqual(Buffer.from(record.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'))) throw missingSession();
    return { id, status: this.now() >= Date.parse(record.expiresAt) ? 'expired' : record.status,
      createdAt: record.createdAt, expiresAt: record.expiresAt, simulation: true,
      ...(record.status === 'failed' ? { error: '二维码生成失败，请重新申请。' } : {}) };
  }

  close() {
    this.connection?.driver.destroy();
    this.connection = undefined;
  }
}
