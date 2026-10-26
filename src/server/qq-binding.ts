import { createHash, createPrivateKey, createPublicKey, randomInt, randomUUID, sign, verify } from 'node:crypto';
import type { Config, QqBotConfig } from './config.js';
import { ApiError } from './errors.js';
import { PgQqBindingStore, type QqBindingStore, type QqBindingScope, type QqBindingStatus } from './qq-binding-store.js';

type QqBindingConfig = Pick<Config, 'qqBot' | 'databaseUrl' | 'timeoutMs'>;
export interface QqWebhookHeaders { appId?: string; signature?: string; timestamp?: string }
const unavailable = () => new ApiError(503, 'QQ 群提醒绑定服务暂时不可用，请稍后重试。', 'QQ_BINDING_UNAVAILABLE');
const unauthorized = () => new ApiError(401, 'QQ 机器人回调验证失败。', 'QQ_WEBHOOK_UNAUTHORIZED');
const invalid = () => new ApiError(400, 'QQ 机器人回调格式无效。', 'QQ_WEBHOOK_INVALID');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
const disabled = (): QqBindingStatus => ({ enabled: false, binding: null, challenge: null });

function privateKey(secret: string) {
  if (!secret) throw unavailable();
  const bytes = Buffer.from(secret); const seed = Buffer.alloc(32);
  for (let i = 0; i < seed.length; i++) seed[i] = bytes[i % bytes.length];
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}

/** Official protocol signs timestamp + the exact HTTP request bytes. */
export function verifyQqWebhook(secret: string, timestamp: string, raw: Buffer, signature: string): boolean {
  if (!/^[a-f0-9]{128}$/i.test(signature)) return false;
  try { return verify(null, Buffer.concat([Buffer.from(timestamp), raw]), createPublicKey(privateKey(secret)), Buffer.from(signature, 'hex')); }
  catch { return false; }
}

export class QqBindingService {
  private store?: QqBindingStore;
  private readonly now: () => number;
  constructor(private readonly config: QqBindingConfig,
    private readonly options: { store?: QqBindingStore; now?: () => number; initializeUsers?: () => Promise<void> } = {}) {
    this.store = options.store; this.now = options.now ?? Date.now;
  }
  private bot(): QqBotConfig {
    if (!this.config.qqBot) throw new ApiError(503, 'QQ 群提醒绑定尚未配置。', 'QQ_BINDING_DISABLED');
    return this.config.qqBot;
  }
  private scope(userId: string): QqBindingScope {
    const bot = this.bot(); return { userId, appId: bot.appId, groupOpenid: bot.groupOpenid };
  }
  private async request<T>(run: (store: QqBindingStore) => Promise<T>): Promise<T> {
    this.bot();
    if (!this.store && (!this.config.databaseUrl || !this.options.initializeUsers)) throw unavailable();
    const store = this.store ??= new PgQqBindingStore(this.config, { beforeInitialize: this.options.initializeUsers! });
    try { await store.initialize(); return await run(store); }
    catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  }
  async getStatus(userId: string): Promise<QqBindingStatus> {
    if (!this.config.qqBot) return disabled();
    return this.request(store => store.getStatus(this.scope(userId), new Date(this.now())));
  }
  async createChallenge(userId: string): Promise<{ id: string; code: string; expiresAt: string }> {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const id = randomUUID();
    const now = new Date(this.now()), expiresAt = new Date(now.getTime() + 300000);
    await this.request(store => store.createChallenge(this.scope(userId), id, hashCode(code), now, expiresAt));
    return { id, code, expiresAt: expiresAt.toISOString() };
  }
  async confirm(userId: string, body: unknown): Promise<{ binding: { boundAt: string } }> {
    this.bot();
    if (!object(body) || typeof body.challengeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.challengeId)) {
      throw new ApiError(400, '请读取当前绑定验证信息后再确认。', 'QQ_BINDING_INVALID_CHALLENGE');
    }
    const challengeId = body.challengeId;
    return { binding: await this.request(store => store.confirm(this.scope(userId), challengeId, new Date(this.now()))) };
  }
  async unbind(userId: string): Promise<void> { await this.request(store => store.unbind(this.scope(userId))); }
  async handleWebhook(raw: Buffer, headers: QqWebhookHeaders): Promise<Record<string, unknown>> {
    const bot = this.bot();
    if (headers.appId !== bot.appId) throw unauthorized();
    if (raw.length > 65536) throw invalid();
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { throw invalid(); }
    if (!object(payload)) throw invalid();
    if (payload.op === 13) {
      const data = payload.d;
      // Keep this signing input disjoint from JSON event bodies: an unrestricted token would be a signing oracle.
      // The official example uses an alphanumeric token; accept base64url tokens for compatibility.
      if (!object(data) || typeof data.plain_token !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(data.plain_token)
        || typeof data.event_ts !== 'string' || !/^[0-9]{1,16}$/.test(data.event_ts)) throw invalid();
      return { plain_token: data.plain_token, signature: sign(null, Buffer.from(data.event_ts + data.plain_token), privateKey(bot.appSecret)).toString('hex') };
    }
    const timestamp = headers.timestamp ?? '';
    if (!/^[0-9]{10,11}$/.test(timestamp) || Math.abs(this.now() - Number(timestamp) * 1000) > 300000
      || !verifyQqWebhook(bot.appSecret, timestamp, raw, headers.signature ?? '')) throw unauthorized();
    if (payload.op !== 0) throw invalid();
    if (payload.t !== 'GROUP_AT_MESSAGE_CREATE') return { op: 12 };
    const data = payload.d;
    if (!object(data) || data.group_openid !== bot.groupOpenid || !object(data.author) || !identifier(data.author.member_openid)
      || typeof data.content !== 'string') return { op: 12 };
    // QQ may retain the robot mention prefix. Require the whole remaining message to be the binding command.
    const content = data.content.replace(/^\s*<@!?[A-Za-z0-9_-]+>\s*/, '').trim();
    const code = /^绑定\s+([A-Z0-9]{8})$/.exec(content)?.[1];
    if (!code) return { op: 12 };
    const senderName = typeof data.author.username === 'string' ? data.author.username.trim().slice(0, 80) || null : null;
    const memberOpenid = data.author.member_openid;
    await this.request(store => store.receiveCandidate(bot.appId, bot.groupOpenid, hashCode(code), memberOpenid, senderName, new Date(this.now())));
    return { op: 12 };
  }
  async close(): Promise<void> { await this.store?.close(); }
}
