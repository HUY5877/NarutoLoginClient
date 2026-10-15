import { loadConfig, type Config } from './config.js';

interface LoaderOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const businessKeys = new Set([
  'HOST', 'PORT',
  'REDIS_URL', 'DATABASE_URL', 'JWT_SECRET', 'REDIS_QUEUE_KEY', 'LOCAL_OBJECTS_DIR',
  'SESSION_TTL_MS', 'REQUEST_TIMEOUT_MS', 'STORAGE_DRIVER', 'OSS_KEY_PREFIX',
  'OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET',
  'OSS_STS_TOKEN', 'ALLOWED_ORIGINS', 'SESSION_COOKIE_NAME',
]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Each instance loads one complete profile once, including concurrent initialization. */
export function createRuntimeConfigLoader(options: LoaderOptions = {}): () => Promise<Config> {
  let pending: Promise<Config> | undefined;
  return () => pending ??= load(options);
}

async function load({ env = process.env, fetch: request = globalThis.fetch, timeoutMs = 10000 }: LoaderOptions): Promise<Config> {
  const profile = env.APP_ENV ?? 'prod';
  if (profile !== 'prod' && profile !== 'test') throw new Error('APP_ENV 必须为 prod 或 test');
  const bootstrap = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] as const;
  for (const key of bootstrap) {
    if (!env[key]?.trim()) throw new Error(`缺少 Cloudflare 引导配置 ${key}`);
  }
  const namespaceKey = `CLOUDFLARE_KV_NAMESPACE_ID_${profile.toUpperCase()}`;
  const namespace = env[namespaceKey]?.trim()
    || (profile === 'prod' ? env.CLOUDFLARE_KV_NAMESPACE_ID?.trim() : undefined);
  if (!namespace) throw new Error(`缺少 Cloudflare 引导配置 ${namespaceKey}`);
  const productionNamespace = env.CLOUDFLARE_KV_NAMESPACE_ID_PROD?.trim() || env.CLOUDFLARE_KV_NAMESPACE_ID?.trim();
  if (profile === 'test' && namespace === productionNamespace) {
    throw new Error('Cloudflare 测试 namespace 必须与正式 namespace 不同');
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!)}/storage/kv/namespaces/${encodeURIComponent(namespace)}`;
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN!}`, 'Content-Type': 'application/json' };
  async function json(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await request(`${base}${path}`, { ...init, headers, signal: controller.signal });
          if (!response.ok) throw new Error();
          const body: unknown = await response.json();
          if (!object(body) || body.success !== true) throw new Error();
          return body;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs);
        }),
      ]);
      return result;
    } catch {
      // Cloudflare and fetch errors may include tokens, URLs, or response values.
      throw new Error(`Cloudflare ${profile} 配置读取失败，请检查连接与 KV 权限`);
    } finally { clearTimeout(timer); }
  }

  const keys = new Set<string>();
  const cursors = new Set<string>();
  let cursor = '';
  do {
    const query = new URLSearchParams({ limit: '1000', ...(cursor ? { cursor } : {}) });
    const page = await json(`/keys?${query}`);
    if (!Array.isArray(page.result)) throw new Error(`Cloudflare ${profile} 配置键列表格式无效`);
    for (const item of page.result) {
      if (!object(item) || typeof item.name !== 'string') {
        throw new Error(`Cloudflare ${profile} 配置键列表格式无效`);
      }
      // The namespace also contains executor settings. Only consume this server's contract.
      if (businessKeys.has(item.name)) keys.add(item.name);
    }
    const info = page.result_info;
    if (info !== undefined && !object(info)) throw new Error(`Cloudflare ${profile} 配置分页格式无效`);
    const next = object(info) ? info.cursor : undefined;
    if (next !== undefined && typeof next !== 'string') throw new Error(`Cloudflare ${profile} 配置分页格式无效`);
    cursor = typeof next === 'string' ? next : '';
    if (cursor && cursors.has(cursor)) throw new Error(`Cloudflare ${profile} 配置分页游标重复`);
    if (cursor) cursors.add(cursor);
  } while (cursor);

  const selected: NodeJS.ProcessEnv = {};
  const names = [...keys];
  for (let offset = 0; offset < names.length; offset += 100) {
    const batch = names.slice(offset, offset + 100);
    const body = await json('/bulk/get', { method: 'POST', body: JSON.stringify({ keys: batch, type: 'text' }) });
    const result = body.result;
    const values = object(result) ? result.values : undefined;
    if (!object(values)) throw new Error(`Cloudflare ${profile} 配置值格式无效`);
    for (const key of batch) {
      if (typeof values[key] !== 'string') throw new Error(`Cloudflare ${profile} 配置不完整`);
      selected[key] = values[key];
    }
  }
  for (const key of ['REDIS_QUEUE_KEY', 'OSS_KEY_PREFIX', 'PORT', 'SESSION_COOKIE_NAME', 'STORAGE_DRIVER',
    ...(selected.STORAGE_DRIVER === 'local' ? ['LOCAL_OBJECTS_DIR'] : [])]) {
    if (!selected[key]?.trim()) throw new Error(`Cloudflare ${profile} 缺少 ${key}，不会回退其他环境配置`);
  }
  return loadConfig(selected);
}

export const loadRuntimeConfig = createRuntimeConfigLoader();
