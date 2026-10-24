import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

export const QQ_APP_ID = '1104307008';
const MAX_BYTES = 64 * 1024;
const invalid = () => new ApiError(400, 'QQ 授权格式无效，请重新扫码。', 'INVALID_QQ_AUTHORIZATION');
export const qqExpired = () => new ApiError(410, 'QQ 授权已过期，请重新扫码。', 'QQ_AUTHORIZATION_EXPIRED');
export const qqUnavailable = () => new ApiError(503, 'QQ 授权服务暂时不可用，请稍后重试。', 'QQ_AUTHORIZATION_UNAVAILABLE');
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

export function parseQqAuthorization(value: unknown, now: number, { allowExpired = false }: { allowExpired?: boolean } = {}): ParsedQqAuthorization {
  if (!object(value) || Object.keys(value).length !== 4 || value.schema_version !== 1 || value.app_id !== QQ_APP_ID
    || typeof value.captured_at_epoch_ms !== 'number' || !Number.isSafeInteger(value.captured_at_epoch_ms)
    || value.captured_at_epoch_ms < 0 || !Number.isSafeInteger(now)
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
  // Device and server clocks need not agree. Accept the capture without allowing a fast
  // device clock to postpone its fallback expiry or supersede later account captures.
  const capturedAt = Math.min(value.captured_at_epoch_ms, now);
  let lifetimeStart = BigInt(capturedAt);
  const authTime = fields.get('auth_time');
  if (authTime !== undefined) {
    if (!/^(?:\d{10}|\d{13})$/.test(authTime)) throw invalid();
    lifetimeStart = BigInt(authTime) * (authTime.length === 10 ? 1000n : 1n);
    // QQ's original authorization time is independent of the device's capture clock.
    if (lifetimeStart < 1000000000000n) throw invalid();
  }
  const expiration = lifetimeStart + BigInt(seconds) * 1000n;
  // JavaScript Date's supported range is narrower than the safe-integer range.
  if (expiration > 8640000000000000n) throw invalid();
  const expiresAt = Number(expiration);
  if (!allowExpired && expiresAt - now < 1000) throw qqExpired();
  return { authorization: { schema_version: 1, app_id: QQ_APP_ID,
    captured_at_epoch_ms: capturedAt, callback_url: callback }, fields, expiresAt };
}

export function qqAccountFingerprint(ownerId: string, openid: string): string {
  return createHash('sha256').update(`huy:qq-account:v2\0${ownerId}\0${QQ_APP_ID}\0${openid.toLowerCase()}`).digest('hex');
}
