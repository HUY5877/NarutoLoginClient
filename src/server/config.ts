import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = existsSync(resolve(moduleDir, 'package.json')) ? moduleDir : resolve(moduleDir, '..');

export interface Config {
  appEnv?: 'prod' | 'test';
  host: string;
  port: number;
  redisUrl?: string;
  databaseUrl?: string;
  jwtSecret?: string;
  redisQueueKey: string;
  localObjectsDir: string;
  sessionTtlMs: number;
  timeoutMs: number;
  storageDriver: 'local' | 'oss';
  ossPrefix: string;
  ossRegion?: string;
  ossBucket?: string;
  ossAccessKeyId?: string;
  ossAccessKeySecret?: string;
  ossStsToken?: string;
  allowedOrigins: string[];
  sessionCookieName?: string;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`配置 ${key} 必须是 ${min}–${max} 的整数`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appEnv = env.APP_ENV ?? 'prod';
  if (appEnv !== 'prod' && appEnv !== 'test') throw new Error('APP_ENV 必须为 prod 或 test');
  const storageDriver = env.STORAGE_DRIVER ?? 'local';
  if (storageDriver !== 'local' && storageDriver !== 'oss') throw new Error('STORAGE_DRIVER 必须为 local 或 oss');
  const redisUrl = env.REDIS_URL?.trim() || undefined;
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.search || url.hash || !/^\/\d*$/.test(url.pathname || '/')) throw new Error();
    } catch { throw new Error('REDIS_URL 必须为有效的 redis:// 或 rediss:// 连接地址'); }
  }
  const redisQueueKey = env.REDIS_QUEUE_KEY ?? 'naruto:login:tasks';
  const jwtSecret = env.JWT_SECRET?.trim() || undefined;
  if (jwtSecret && Buffer.byteLength(jwtSecret, 'utf8') < 32) throw new Error('JWT_SECRET 至少需要 32 字节，请使用随机生成的密钥');
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (databaseUrl) {
    try {
      const url = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.replace(/^\//, '') || url.hash) throw new Error();
    } catch { throw new Error('DATABASE_URL 必须为有效的 postgres:// 或 postgresql:// 数据库连接地址'); }
  }
  if (!/^[a-zA-Z0-9_:{}-]{1,128}$/.test(redisQueueKey)) throw new Error('REDIS_QUEUE_KEY 格式不正确');
  const ossPrefix = (env.OSS_KEY_PREFIX ?? 'login').replace(/^\/+|\/+$/g, '');
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(ossPrefix)) throw new Error('OSS_KEY_PREFIX 格式不正确');
  const sessionCookieName = env.SESSION_COOKIE_NAME ?? 'naruto_session';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionCookieName)) throw new Error('SESSION_COOKIE_NAME 格式不正确');
  const config: Config = {
    appEnv,
    host: env.HOST ?? '127.0.0.1', port: integer(env, 'PORT', 4300, 1, 65535),
    redisUrl, redisQueueKey, databaseUrl, jwtSecret,
    localObjectsDir: resolve(env.LOCAL_OBJECTS_DIR ?? resolve(serverRoot, '../../.data/login-objects')),
    sessionTtlMs: integer(env, 'SESSION_TTL_MS', 300000, 5000, 600000),
    timeoutMs: integer(env, 'REQUEST_TIMEOUT_MS', 5000, 100, 30000),
    storageDriver, ossPrefix, ossRegion: env.OSS_REGION, ossBucket: env.OSS_BUCKET,
    ossAccessKeyId: env.OSS_ACCESS_KEY_ID, ossAccessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    ossStsToken: env.OSS_STS_TOKEN || undefined,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    sessionCookieName,
  };
  if (storageDriver === 'oss' && [config.ossRegion, config.ossBucket, config.ossAccessKeyId, config.ossAccessKeySecret].some(v => !v)) {
    throw new Error('OSS 模式缺少 OSS_REGION、OSS_BUCKET、OSS_ACCESS_KEY_ID 或 OSS_ACCESS_KEY_SECRET');
  }
  return config;
}
