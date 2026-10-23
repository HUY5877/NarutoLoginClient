import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';

export const QQ_APP_ID = '1104307008';
const MAX_BYTES = 64 * 1024;
const invalid = () => new ApiError(400, 'QQ 授权格式无效，请重新扫码。', 'INVALID_QQ_AUTHORIZATION');
export const qqExpired = () => new ApiError(410, 'QQ 授权已过期，请重新扫码。', 'QQ_AUTHORIZATION_EXPIRED');
export const qqUnavailable = () => new ApiError(503, 'QQ 授权服务暂时不可用，请稍后重试。', 'QQ_AUTHORIZATION_UNAVAILABLE');
const verificationFailed = () => new ApiError(502, 'QQ 授权校验失败，请重新扫码或稍后重试。', 'QQ_VERIFICATION_FAILED');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const controls = /[\u0000-\u001f\u007f-\u009f]/;

export interface QqAuthorization {
  schema_version: 1;
  app_id: typeof QQ_APP_ID;
  captured_at_epoch_ms: number;
  callback_url: string;
}
export interface ParsedQqAuthorization {
  authorization: QqAuthorization;
  fields: ReadonlyMap<string, string>;
  expiresAt: number;
}

/** The body parser's JSON.parse would otherwise silently accept duplicate credential keys. */
export function validateQqJson(input: Buffer | string): void {
  try {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw invalid();
    let offset = 0;
    const ws = () => { while (/[\t\n\r ]/.test(text[offset] ?? '\0')) offset++; };
    const string = (): string => {
      if (text[offset] !== '"') throw invalid();
      const start = offset++;
      while (offset < text.length) {
        const char = text[offset++];
        if (char === '\\') { offset++; continue; }
        if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
      }
      throw invalid();
    };
    const value = (depth: number): void => {
      if (depth > 24) throw invalid();
      ws();
      if (text[offset] === '{') {
        offset++; ws(); const keys = new Set<string>();
        if (text[offset] === '}') { offset++; return; }
        while (offset < text.length) {
          ws(); const key = string(); if (keys.has(key)) throw invalid(); keys.add(key); ws();
          if (text[offset++] !== ':') throw invalid(); value(depth + 1); ws();
          if (text[offset] === '}') { offset++; return; }
          if (text[offset++] !== ',') throw invalid();
        }
        throw invalid();
      }
      if (text[offset] === '[') {
        offset++; ws(); if (text[offset] === ']') { offset++; return; }
        while (offset < text.length) {
          value(depth + 1); ws(); if (text[offset] === ']') { offset++; return; }
          if (text[offset++] !== ',') throw invalid();
        }
        throw invalid();
      }
      if (text[offset] === '"') { string(); return; }
      const match = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      if (!match) throw invalid(); offset += match[0].length;
    };
    ws(); if (text[offset] !== '{') throw invalid(); value(0); ws(); if (offset !== text.length) throw invalid();
  } catch { throw invalid(); }
}

export function parseQqAuthorization(value: unknown, now: number): ParsedQqAuthorization {
  if (!object(value) || Object.keys(value).length !== 4 || value.schema_version !== 1 || value.app_id !== QQ_APP_ID
    || typeof value.captured_at_epoch_ms !== 'number' || !Number.isSafeInteger(value.captured_at_epoch_ms)
    || value.captured_at_epoch_ms < 0 || value.captured_at_epoch_ms > now || !Number.isSafeInteger(now)
    || typeof value.callback_url !== 'string' || value.callback_url.length > MAX_BYTES) throw invalid();
  const callback = value.callback_url;
  if (!/^[\x21-\x7e]+$/.test(callback) || /[<>"{}|\\^`]/.test(callback)) throw invalid();
  const match = callback.match(/^auth:\/\/tauth\.qq\.com\/(?:\?([^#]*))?(?:#([^#]*))?$/);
  if (!match || match[1] && match[2]) throw invalid();
  const payload = match[2] || match[1]; if (!payload) throw invalid();
  const parts = payload.split('&'); if (parts.length > 128) throw invalid();
  const fields = new Map<string, string>();
  const decode = (input: string): string => {
    try { return decodeURIComponent(input.replace(/\+/g, ' ')); } catch { throw invalid(); }
  };
  for (const part of parts) {
    const equals = part.indexOf('='); if (equals <= 0) throw invalid();
    const key = decode(part.slice(0, equals)), decoded = decode(part.slice(equals + 1));
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || fields.has(key) || controls.test(decoded)) throw invalid();
    fields.set(key, decoded);
  }
  if (fields.get('ret') !== '0' || !/^[0-9a-f]{16,256}$/i.test(fields.get('access_token') ?? '')
    || !/^[0-9a-f]{16,256}$/i.test(fields.get('openid') ?? '')
    || ['appid', 'app_id'].some(key => fields.has(key) && fields.get(key) !== QQ_APP_ID)) throw invalid();
  const seconds = fields.get('expires_in');
  if (!seconds || !/^\d{1,19}$/.test(seconds) || BigInt(seconds) <= 0n) throw invalid();
  let lifetimeStart = BigInt(value.captured_at_epoch_ms);
  const authTime = fields.get('auth_time');
  if (authTime !== undefined) {
    if (!/^(?:\d{10}|\d{13})$/.test(authTime)) throw invalid();
    lifetimeStart = BigInt(authTime) * (authTime.length === 10 ? 1000n : 1n);
    if (lifetimeStart < 1000000000000n || lifetimeStart > BigInt(value.captured_at_epoch_ms)) throw invalid();
  }
  const expiration = lifetimeStart + BigInt(seconds) * 1000n;
  // JavaScript Date's supported range is narrower than the safe-integer range.
  if (expiration > 8640000000000000n) throw invalid();
  const expiresAt = Number(expiration);
  if (expiresAt - now < 1000) throw qqExpired();
  return { authorization: { schema_version: 1, app_id: QQ_APP_ID,
    captured_at_epoch_ms: value.captured_at_epoch_ms, callback_url: callback }, fields, expiresAt };
}

export interface QqEncryptedAuthorization { ciphertext: Buffer; nonce: Buffer; authTag: Buffer }
export class QqAuthorizationCipher {
  private readonly key: Buffer;
  constructor(key: string) {
    if (!/^[0-9a-f]{64}$/i.test(key)) throw qqUnavailable();
    this.key = Buffer.from(key, 'hex');
  }
  fingerprint(ownerId: string, openid: string): string {
    return createHmac('sha256', this.key).update(`huy:qq-account:v1\0${ownerId}\0${QQ_APP_ID}\0${openid.toLowerCase()}`).digest('hex');
  }
  encrypt(value: QqAuthorization, context: string): QqEncryptedAuthorization {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`huy:qq-authorization:v1\0${context}`, 'utf8'));
    return { ciphertext: Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]), nonce, authTag: cipher.getAuthTag() };
  }
  decrypt(value: QqEncryptedAuthorization, context: string): unknown {
    try {
      if (value.nonce.length !== 12 || value.authTag.length !== 16 || value.ciphertext.length > MAX_BYTES) throw qqUnavailable();
      const cipher = createDecipheriv('aes-256-gcm', this.key, value.nonce);
      cipher.setAAD(Buffer.from(`huy:qq-authorization:v1\0${context}`, 'utf8')); cipher.setAuthTag(value.authTag);
      const plain = Buffer.concat([cipher.update(value.ciphertext), cipher.final()]);
      validateQqJson(plain); return JSON.parse(plain.toString('utf8')) as unknown;
    } catch { throw qqUnavailable(); }
  }
}

/** No redirects, no SDK logging and a bounded response. Never put the request URL in an error. */
export async function verifyQqAuthorization(parsed: ParsedQqAuthorization,
  { fetch: request = globalThis.fetch, timeoutMs = 10000 }: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<void> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const url = new URL('https://graph.qq.com/oauth2.0/me');
        url.searchParams.set('access_token', parsed.fields.get('access_token')!);
        const response = await request(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json, text/plain' } });
        if (!response.ok || response.redirected || !response.body) throw verificationFailed();
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength; if (bytes > 16384) throw verificationFailed(); chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
        const wrapped = text.match(/^callback\s*\(\s*([\s\S]*?)\s*\)\s*;?$/);
        const json = wrapped?.[1] ?? text; validateQqJson(json);
        const identity: unknown = JSON.parse(json);
        if (!object(identity) || Object.hasOwn(identity, 'error') || Object.hasOwn(identity, 'error_code')
          || identity.client_id !== QQ_APP_ID || typeof identity.openid !== 'string'
          || identity.openid.toLowerCase() !== parsed.fields.get('openid')!.toLowerCase()) throw verificationFailed();
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(verificationFailed()); }, timeoutMs); }),
    ]);
  } catch { throw verificationFailed(); }
  finally { clearTimeout(timer); controller.abort(); }
}
