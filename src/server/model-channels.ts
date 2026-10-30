import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { User } from './auth.js';
import { ApiError } from './errors.js';
import type { ModelChannel, ModelChannelId, ModelChannelsResponse, ModelChannelTestResult } from '../shared/model-channels.js';

const definitions = [
  { id: 'openai', name: 'OpenAI', prefix: 'OPENAI', url: 'https://api.openai.com/v1/chat/completions' },
  { id: 'deepseek', name: 'DeepSeek', prefix: 'DEEPSEEK', url: 'https://api.deepseek.com/chat/completions' },
  { id: 'yuwan', name: '鱼玩', prefix: 'YUWAN', url: 'https://llm-proxy.yuwan-game.com/v1/chat/completions' },
] as const;
type Definition = typeof definitions[number];
interface Options { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; timeoutMs?: number }
interface Profile { environment: 'prod' | 'test'; base: string; token: string }
interface Snapshot { raw: Record<string, string>; model: string; enabled: boolean; keys: string[]; configurationError?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key));
const invalid = () => new ApiError(400, '模型配置格式无效，请检查模型名、开关和密钥。', 'MODEL_CHANNEL_INVALID');
const changed = () => new ApiError(409, '渠道配置已变更，请刷新后重新编辑。', 'MODEL_CHANNEL_CHANGED');

function requireAdmin(user: User) {
  if (!user.isAdmin) throw new ApiError(403, '需要管理员权限。', 'ADMIN_REQUIRED');
}
function definition(id: string): Definition {
  const selected = definitions.find(item => item.id === id);
  if (!selected) throw invalid();
  return selected;
}
function modelName(value: unknown): string {
  if (typeof value !== 'string' || controls.test(value) || [...value.trim()].length > 200) throw invalid();
  return value.trim();
}
function keyValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || controls.test(value) || [...value.trim()].length > 512) throw invalid();
  return value.trim();
}
function keyEntry(value: unknown): { id: string } | { value: string } {
  if (!object(value) || Object.keys(value).length !== 1) throw invalid();
  if ('value' in value) return { value: keyValue(value.value) };
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.id)) throw changed();
  return { id: value.id };
}
function selectProfile(env: NodeJS.ProcessEnv): Profile {
  const environment = env.APP_ENV ?? 'prod';
  if (environment !== 'prod' && environment !== 'test') throw new Error();
  const token = env.CLOUDFLARE_API_TOKEN?.trim(), account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const production = env.CLOUDFLARE_KV_NAMESPACE_ID_PROD?.trim() || env.CLOUDFLARE_KV_NAMESPACE_ID?.trim();
  const namespace = environment === 'prod' ? production : env.CLOUDFLARE_KV_NAMESPACE_ID_TEST?.trim();
  if (!token || !account || !namespace || environment === 'test' && namespace === production) throw new Error();
  return { environment, token, base: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/storage/kv/namespaces/${encodeURIComponent(namespace)}` };
}
function keysFor(channel: Definition): string[] {
  return [`${channel.prefix}_API_KEY`, `${channel.prefix}_MODEL`, `${channel.prefix}_ENABLED`];
}
function snapshot(channel: Definition, raw: Record<string, string>): Snapshot {
  const [keyName, modelKey, enabledKey] = keysFor(channel);
  const text = raw[keyName]?.trim() ?? '';
  const errors: string[] = [];
  let keys: string[] = [];
  try {
    if (text) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch {
        if (/^[\[{\"]/.test(text)) throw new Error();
        parsed = [raw[keyName]];
      }
      if (!Array.isArray(parsed) || parsed.length > 20) throw new Error();
      keys = parsed.map(keyValue);
    }
  } catch { errors.push('密钥配置格式无效，请重新填写密钥或关闭并清空。'); }
  let model = '';
  try { model = modelName(raw[modelKey] ?? ''); }
  catch { errors.push('模型名称格式无效，请重新填写。'); }
  const enabledText = raw[enabledKey]?.trim();
  let enabled = enabledText !== undefined ? enabledText === 'true' : keys.length > 0;
  if (enabledText !== undefined && enabledText !== 'true' && enabledText !== 'false') {
    enabled = false;
    errors.push('启停配置格式无效，请重新选择启用状态。');
  }
  return { raw, keys, model, enabled, ...(errors.length ? { configurationError: errors.join('') } : {}) };
}
function channelVersion(profile: Profile, channel: Definition, state: Snapshot): string {
  return createHmac('sha256', profile.token).update(JSON.stringify([profile.base, channel.id,
    ...keysFor(channel).map(key => state.raw[key] ?? null)])).digest('base64url');
}
function keyId(profile: Profile, channel: Definition, state: Snapshot, index: number): string {
  // Bind retained IDs to this namespace and the entire channel snapshot. No secret enters the browser.
  return createHmac('sha256', profile.token).update(JSON.stringify([profile.base, channel.id,
    ...keysFor(channel).map(key => state.raw[key] ?? ''), index])).digest('base64url');
}
function publicChannel(profile: Profile, channel: Definition, state: Snapshot): ModelChannel {
  return { id: channel.id, name: channel.name, model: state.model, enabled: state.enabled,
    version: channelVersion(profile, channel, state), ...(state.configurationError ? { configurationError: state.configurationError } : {}),
    keys: state.keys.map((key, index) => ({ id: keyId(profile, channel, state, index),
      masked: key.length > 8 ? `••••••••${key.slice(-4)}` : '••••••••' })) };
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) throw new Error();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { void reader.cancel().catch(() => {}); }
}

export class ModelChannelService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  constructor(options: Options = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }
  private profile(): Profile {
    try { return selectProfile(this.env); }
    catch { throw new ApiError(503, '当前环境的 Cloudflare 配置不完整，无法管理模型渠道。', 'MODEL_CHANNEL_UNAVAILABLE'); }
  }
  private async request<T>(url: string, init: RequestInit, timeout: number, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.fetch(url, { ...init, signal: controller.signal, redirect: 'error' }).then(consume),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, Math.max(1, timeout)); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  private async cloudflare(profile: Profile, path: string, method: string, body: unknown, timeout = 10_000): Promise<Record<string, unknown>> {
    return this.request(`${profile.base}${path}`, { method, headers: { Authorization: `Bearer ${profile.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) }, Math.min(timeout, this.timeoutMs), async response => {
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      const json = await boundedJson(response);
      if (!object(json) || json.success !== true) throw new Error();
      return json;
    });
  }
  private async read(profile: Profile, channels: readonly Definition[], timeout?: number): Promise<Map<ModelChannelId, Snapshot>> {
    try {
      const names = channels.flatMap(keysFor);
      const body = await this.cloudflare(profile, '/bulk/get', 'POST', { keys: names, type: 'text' }, timeout);
      const values = object(body.result) ? body.result.values : undefined;
      if (!object(values)) throw new Error();
      const raw: Record<string, string> = {};
      for (const name of names) {
        if (values[name] === null || values[name] === undefined) continue;
        if (typeof values[name] !== 'string') throw new Error();
        raw[name] = values[name];
      }
      return new Map(channels.map(channel => [channel.id, snapshot(channel, raw)]));
    } catch { throw new ApiError(503, '模型配置读取失败，请检查当前环境的 KV 权限和配置格式。', 'MODEL_CHANNEL_READ_FAILED'); }
  }
  async list(user: User): Promise<ModelChannelsResponse> {
    requireAdmin(user);
    const profile = this.profile(); const states = await this.read(profile, definitions);
    return { environment: profile.environment, channels: definitions.map(channel => publicChannel(profile, channel, states.get(channel.id)!)) };
  }
  private resolveKey(profile: Profile, channel: Definition, state: Snapshot, entry: { id: string } | { value: string }): string {
    if ('value' in entry) return entry.value;
    const index = state.keys.findIndex((_, index) => keyId(profile, channel, state, index) === entry.id);
    if (index < 0) throw changed();
    return state.keys[index];
  }
  async update(user: User, id: string, body: unknown): Promise<ModelChannel> {
    requireAdmin(user); const channel = definition(id);
    if (!object(body) || !fields(body, ['version', 'model', 'enabled', 'keys']) || typeof body.enabled !== 'boolean'
      || typeof body.version !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.version)
      || !Array.isArray(body.keys) || body.keys.length > 20) throw invalid();
    const model = modelName(body.model); const entries = body.keys.map(keyEntry);
    if (body.enabled && (!model || !entries.length)) throw invalid();
    const retained = entries.flatMap(entry => 'id' in entry ? [entry.id] : []);
    if (new Set(retained).size !== retained.length) throw invalid();
    const profile = this.profile(); const current = (await this.read(profile, [channel])).get(channel.id)!;
    if (body.version !== channelVersion(profile, channel, current)) throw changed();
    const keys = entries.map(entry => this.resolveKey(profile, channel, current, entry));
    const [keyName, modelKey, enabledKey] = keysFor(channel);
    const raw = { [keyName]: JSON.stringify(keys), [modelKey]: model, [enabledKey]: String(body.enabled) };
    try {
      const response = await this.cloudflare(profile, '/bulk', 'PUT', Object.entries(raw).map(([key, value]) => ({ key, value })));
      if (object(response.result) && 'successful_key_count' in response.result && response.result.successful_key_count !== 3) throw new Error();
    } catch { throw new ApiError(503, '保存未确认，请检查 Cloudflare KV 写权限，再刷新渠道确认结果。', 'MODEL_CHANNEL_SAVE_FAILED'); }
    return publicChannel(profile, channel, { raw, keys, model, enabled: body.enabled });
  }
  async test(user: User, id: string, body: unknown): Promise<ModelChannelTestResult> {
    requireAdmin(user); const channel = definition(id);
    if (!object(body) || !fields(body, ['model', 'key'])) throw invalid();
    const model = modelName(body.model); if (!model) throw invalid();
    const entry = keyEntry(body.key);
    const started = performance.now();
    const result = (ok: boolean, message: string): ModelChannelTestResult => ({ ok, message, latencyMs: Math.round(performance.now() - started) });
    let key: string;
    if ('value' in entry) key = entry.value;
    else {
      const profile = this.profile();
      const state = (await this.read(profile, [channel], this.timeoutMs - (performance.now() - started))).get(channel.id)!;
      if (state.configurationError) throw changed();
      key = this.resolveKey(profile, channel, state, entry);
    }
    const remaining = this.timeoutMs - (performance.now() - started);
    if (remaining <= 0) return result(false, '连接测试超时，请稍后重试。');
    try {
      return await this.request(channel.url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false,
          ...(channel.id === 'openai' ? { max_completion_tokens: 256 } : { max_tokens: 16 }) }) }, remaining, async response => {
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          const message = response.status === 401 || response.status === 403 ? '密钥无效或没有使用此模型的权限。'
            : response.status === 429 ? '模型服务限流或额度不足，请稍后重试。'
            : response.status === 400 || response.status === 404 ? '模型名称或请求不被服务支持，请检查配置。'
            : '模型服务请求失败，请稍后重试。';
          return result(false, message);
        }
        const json = await boundedJson(response);
        const choice = object(json) && Array.isArray(json.choices) ? json.choices[0] : undefined;
        const message = object(choice) && object(choice.message) ? choice.message : undefined;
        // Reasoning models can consume the small test budget before producing visible text.
        // A real completion envelope with accounted output tokens still proves connectivity.
        const usage = object(json) && object(json.usage) ? json.usage : undefined;
        if (object(json) && json.object === 'chat.completion' && typeof json.id === 'string' && !!json.id.trim()
          && typeof json.model === 'string' && !!json.model.trim() && object(choice) && choice.finish_reason === 'length'
          && message?.role === 'assistant' && (message.content === null || typeof message.content === 'string')
          && usage && Number.isSafeInteger(usage.completion_tokens) && (usage.completion_tokens as number) > 0
          && Number.isSafeInteger(usage.prompt_tokens) && (usage.prompt_tokens as number) >= 0
          && Number.isSafeInteger(usage.total_tokens) && usage.total_tokens === (usage.prompt_tokens as number) + (usage.completion_tokens as number)) {
          return result(true, '连接成功，模型已响应；测试输出达到上限。');
        }
        if (!message || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim()) {
          return result(false, '模型服务没有返回有效的回复，请检查模型兼容性。');
        }
        return result(true, '连接成功，模型已返回有效回复。');
      });
    } catch {
      return result(false, performance.now() - started >= this.timeoutMs - 1
        ? '连接测试超时，请稍后重试。' : '无法完成连接测试，请检查服务连接与模型配置。');
    }
  }
}
