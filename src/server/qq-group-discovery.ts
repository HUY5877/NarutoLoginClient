import { createClient } from 'redis';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import type { RedisDriver } from './queue.js';

type DiscoveryConfig = Pick<Config, 'redisUrl' | 'redisQueueKey' | 'timeoutMs'>;
const retentionMs = 600000;
const maxGroups = 20;
const appIdValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
const groupValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const invalid = () => new ApiError(400, 'QQ 机器人或群标识格式无效。', 'QQ_GROUP_DISCOVERY_INVALID');

const recordScript = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -tonumber(ARGV[4]) - 1)
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
`;
const listScript = `
return redis.call('ZREVRANGEBYSCORE', KEYS[1], ARGV[1], '(' .. ARGV[2], 'WITHSCORES', 'LIMIT', 0, ARGV[3])
`;

function createRedisDriver(config: DiscoveryConfig): RedisDriver {
  const client = createClient({ url: config.redisUrl,
    socket: { connectTimeout: config.timeoutMs, reconnectStrategy: false },
    disableOfflineQueue: true, commandsQueueMaxLength: 1000 });
  client.on('error', () => {});
  return {
    get isReady() { return client.isReady; },
    async connect() { await client.connect(); },
    eval: (script, options, signal) => client.withAbortSignal(signal).eval(script, options),
    get: (key, signal) => client.withAbortSignal(signal).get(key),
    destroy() { if (client.isOpen) client.destroy(); },
  };
}
function destroy(driver: RedisDriver): void {
  try { driver.destroy(); } catch { /* Cleanup must not expose driver diagnostics. */ }
}

/** Temporary observations only; discovering a group never selects or binds it. */
export class QqGroupDiscoveryService {
  private connection?: { driver: RedisDriver; opening?: Promise<void> };
  private readonly createDriver: () => RedisDriver;
  private readonly now: () => number;
  constructor(private readonly config: DiscoveryConfig,
    options: { createDriver?: () => RedisDriver; now?: () => number } = {}) {
    this.createDriver = options.createDriver ?? (() => createRedisDriver(config));
    this.now = options.now ?? Date.now;
  }

  private async request<T>(command: (driver: RedisDriver, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.config.redisUrl) throw new ApiError(503, 'Redis 未配置，请先配置 REDIS_URL。', 'REDIS_NOT_CONFIGURED');
    let connection: NonNullable<QqGroupDiscoveryService['connection']> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      connection = this.connection ??= { driver: this.createDriver() };
      const current = connection;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(); reject(new Error('Redis request timed out'));
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
        destroy(connection.driver);
      }
      throw new ApiError(503, 'QQ 群标识发现暂时不可用，请稍后重试。', 'REDIS_UNAVAILABLE');
    } finally { if (timer) clearTimeout(timer); }
  }

  async record(appId: string, groupOpenid: string): Promise<void> {
    if (!appIdValid(appId) || !groupValid(groupOpenid)) throw invalid();
    const now = this.now();
    await this.request(async (driver, signal) => {
      const result = await driver.eval(recordScript, { keys: [this.key(appId)],
        arguments: [String(now), String(now - retentionMs), groupOpenid, String(maxGroups), String(retentionMs / 1000)] }, signal);
      if (result !== 1) throw new Error('Invalid group discovery response');
    });
  }

  async list(appId: string): Promise<Array<{ groupOpenid: string; seenAt: string }>> {
    if (!appIdValid(appId)) throw invalid();
    const now = this.now();
    return this.request(async (driver, signal) => {
      const result = await driver.eval(listScript, { keys: [this.key(appId)],
        arguments: [String(now), String(now - retentionMs), String(maxGroups)] }, signal);
      if (!Array.isArray(result) || result.length % 2 !== 0 || result.length > maxGroups * 2) throw new Error('Invalid group discovery response');
      const groups: Array<{ groupOpenid: string; seenAt: string }> = [];
      for (let index = 0; index < result.length; index += 2) {
        const groupOpenid: unknown = result[index], score: unknown = result[index + 1];
        if (!groupValid(groupOpenid) || typeof score !== 'string' || !/^[0-9]{1,16}$/.test(score)) throw new Error('Invalid group discovery response');
        const seenAt = Number(score);
        if (!Number.isSafeInteger(seenAt) || seenAt <= now - retentionMs || seenAt > now) throw new Error('Invalid group discovery response');
        groups.push({ groupOpenid, seenAt: new Date(seenAt).toISOString() });
      }
      return groups;
    });
  }

  private key(appId: string): string { return `${this.config.redisQueueKey}:qq:observed-groups:${appId}`; }
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection) destroy(connection.driver);
  }
}
