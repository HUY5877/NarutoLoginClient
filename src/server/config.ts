export interface Config {
  host: string;
  port: number;
  serviceUrl: string;
  serviceToken: string;
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
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`配置 ${key} 必须是 ${min}–${max} 的整数`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const storageDriver = env.STORAGE_DRIVER ?? 'local';
  if (storageDriver !== 'local' && storageDriver !== 'oss') throw new Error('STORAGE_DRIVER 必须为 local 或 oss');
  const url = new URL(env.LOGIN_SERVICE_URL ?? 'http://127.0.0.1:4320');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('LOGIN_SERVICE_URL 必须为不含路径或凭据的 HTTP(S) 地址');
  }
  const ossPrefix = (env.OSS_KEY_PREFIX ?? 'login').replace(/^\/+|\/+$/g, '');
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(ossPrefix)) throw new Error('OSS_KEY_PREFIX 格式不正确');
  const config: Config = {
    host: env.HOST ?? '127.0.0.1', port: integer(env, 'PORT', 4300, 1, 65535),
    serviceUrl: url.origin, serviceToken: env.SERVICE_TOKEN ?? 'local-development-token',
    sessionTtlMs: integer(env, 'SESSION_TTL_MS', 120000, 5000, 600000),
    timeoutMs: integer(env, 'UPSTREAM_TIMEOUT_MS', 5000, 100, 30000),
    storageDriver, ossPrefix, ossRegion: env.OSS_REGION, ossBucket: env.OSS_BUCKET,
    ossAccessKeyId: env.OSS_ACCESS_KEY_ID, ossAccessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    ossStsToken: env.OSS_STS_TOKEN || undefined,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  };
  if (config.serviceToken.trim().length < 16) throw new Error('SERVICE_TOKEN 至少需要 16 个字符');
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && config.serviceToken === 'local-development-token') {
    throw new Error('监听非本机地址前必须配置独立 SERVICE_TOKEN');
  }
  if (storageDriver === 'oss' && [config.ossRegion, config.ossBucket, config.ossAccessKeyId, config.ossAccessKeySecret].some(v => !v)) {
    throw new Error('OSS 模式缺少 OSS_REGION、OSS_BUCKET、OSS_ACCESS_KEY_ID 或 OSS_ACCESS_KEY_SECRET');
  }
  return config;
}
