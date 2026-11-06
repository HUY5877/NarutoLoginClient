import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { logBackend } from './logging.js';
import { prepareQqAuthorizationTables } from './qq-authorization-schema.js';
import { parseStrictQqAuthorization as parseQqAuthorization, QqAuthorizationCipher, QQ_APP_ID, qqExpired, qqUnavailable, verifyQqAuthorization,
  type ParsedQqAuthorization, type QqAuthorization, type QqEncryptedAuthorization } from './qq-authorization-data.js';

export interface QqAuthorizationRecord extends QqEncryptedAuthorization {
  id: string;
  ownerId: string;
  fingerprint: string;
  label: string;
  accountHint: string;
  capturedAt: string;
  expiresAt: string;
  updatedAt: string;
}
export interface QqAuthorizationItem {
  id: string; label: string; accountHint: string; capturedAt: string; expiresAt: string; updatedAt: string; expired: boolean;
}
export interface QqAuthorizationStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  upsert(record: QqAuthorizationRecord): Promise<QqAuthorizationRecord>;
  list(ownerId: string): Promise<QqAuthorizationRecord[]>;
  get(ownerId: string, id: string): Promise<QqAuthorizationRecord | null>;
  delete(ownerId: string, id: string): Promise<boolean>;
}
interface QueryResult { rows: Record<string, unknown>[]; rowCount?: number | null }
interface QqPgClient { query(sql: string, values?: unknown[]): Promise<QueryResult>; release(destroy?: boolean): void }
interface QqPgPool { connect(): Promise<QqPgClient>; end(): Promise<void> }
type QqConfig = Pick<Config, 'appEnv' | 'databaseUrl' | 'timeoutMs' | 'qqAuthorizationEncryptionKey'>;
const missing = () => new ApiError(404, '未找到这条 QQ 授权。', 'QQ_AUTHORIZATION_NOT_FOUND');
const notEnabled = () => new ApiError(404, '接口不存在。', 'QQ_AUTHORIZATION_DISABLED');
const limitReached = () => new ApiError(409, '最多保存 200 个账号，请先删除不再使用的账号。', 'QQ_AUTHORIZATION_LIMIT');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const columns = `id, owner_id AS "ownerId", openid_fingerprint AS fingerprint, label, account_hint AS "accountHint",
  captured_at AS "capturedAt", expires_at AS "expiresAt", updated_at AS "updatedAt", ciphertext, nonce, auth_tag AS "authTag"`;
const schema = `CREATE TABLE IF NOT EXISTS naruto_login.qq_authorizations_encrypted (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  app_id text NOT NULL CHECK (app_id = '1104307008'),
  openid_fingerprint text NOT NULL CHECK (openid_fingerprint ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  account_hint text NOT NULL CHECK (account_hint ~ '^[0-9a-f]{6}$'),
  captured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > captured_at),
  updated_at timestamptz NOT NULL,
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 65536),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  encryption_version smallint NOT NULL DEFAULT 1 CHECK (encryption_version = 1),
  UNIQUE (owner_id, app_id, openid_fingerprint)
);
CREATE INDEX IF NOT EXISTS qq_authorizations_encrypted_owner_updated_idx
  ON naruto_login.qq_authorizations_encrypted (owner_id, updated_at DESC, id);`;
const rowRecord = (row: Record<string, unknown>): QqAuthorizationRecord => ({
  id: row.id as string, ownerId: row.ownerId as string, fingerprint: row.fingerprint as string,
  label: row.label as string, accountHint: row.accountHint as string,
  capturedAt: new Date(row.capturedAt as string | Date).toISOString(), expiresAt: new Date(row.expiresAt as string | Date).toISOString(),
  updatedAt: new Date(row.updatedAt as string | Date).toISOString(), ciphertext: row.ciphertext as Buffer,
  nonce: row.nonce as Buffer, authTag: row.authTag as Buffer,
});

/** This store cannot be constructed for production, and checks the server's actual database before any DDL. */
export class PgQqAuthorizationStore implements QqAuthorizationStore {
  private readonly pool: QqPgPool;
  private initialization?: Promise<void>;
  constructor(config: QqConfig, options: { pool?: QqPgPool } = {}) {
    if (config.appEnv !== 'test') throw notEnabled();
    try { if (!config.databaseUrl || new URL(config.databaseUrl).pathname !== '/naruto_login_test') throw qqUnavailable(); }
    catch { throw qqUnavailable(); }
    const pool = options.pool ?? new Pool({ connectionString: config.databaseUrl, max: 3,
      connectionTimeoutMillis: config.timeoutMs, idleTimeoutMillis: 30000, statement_timeout: config.timeoutMs, query_timeout: config.timeoutMs });
    if (pool instanceof Pool) pool.on('error', () => logBackend('error', 'qq_authorization.pool_failed', { component: 'qq_authorization', errorCode: 'DATABASE_UNAVAILABLE' }));
    this.pool = pool;
  }
  async initialize(): Promise<void> {
    if (!this.initialization) {
      const pending = this.initializeOnce().catch(() => { if (this.initialization === pending) this.initialization = undefined; throw qqUnavailable(); });
      this.initialization = pending;
    }
    await this.initialization;
  }
  private async initializeOnce(): Promise<void> {
    const client = await this.pool.connect(); let transaction = false;
    try {
      const result = await client.query('SELECT current_database() AS database');
      if (result.rows[0]?.database !== 'naruto_login_test') throw qqUnavailable();
      await client.query('BEGIN'); transaction = true;
      await prepareQqAuthorizationTables(client, 'test');
      // users is owned by the existing auth service. Never initialize or modify existing tables here.
      await client.query(schema); await client.query('COMMIT'); transaction = false;
    } finally {
      if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Do not leak driver diagnostics. */ } }
      client.release(transaction);
    }
  }
  private async request<T>(run: (client: QqPgClient) => Promise<T>): Promise<T> {
    await this.initialize(); let client: QqPgClient | undefined, succeeded = false;
    try { client = await this.pool.connect(); const result = await run(client); succeeded = true; return result; }
    catch (error) { if (error instanceof ApiError) throw error; throw qqUnavailable(); }
    finally { client?.release(!succeeded); }
  }
  async upsert(record: QqAuthorizationRecord): Promise<QqAuthorizationRecord> {
    return this.request(async client => {
      let transaction = false;
      try {
        await client.query('BEGIN'); transaction = true;
        // Serialize each owner's count + insertion so simultaneous uploads cannot exceed the limit.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('huy:qq-owner:' || $1))", [record.ownerId]);
        const found = await client.query(`SELECT ${columns} FROM naruto_login.qq_authorizations_encrypted
          WHERE owner_id = $1 AND app_id = $2 AND openid_fingerprint = $3 FOR UPDATE`, [record.ownerId, QQ_APP_ID, record.fingerprint]);
        if (found.rows[0] && new Date(found.rows[0].capturedAt as string | Date).getTime() > Date.parse(record.capturedAt)) {
          await client.query('COMMIT'); transaction = false; return rowRecord(found.rows[0]);
        }
        if (!found.rows[0]) {
          const count = await client.query('SELECT count(*)::int AS count FROM naruto_login.qq_authorizations_encrypted WHERE owner_id = $1', [record.ownerId]);
          if (Number(count.rows[0]?.count) >= 200) throw limitReached();
        }
        const result = await client.query(`INSERT INTO naruto_login.qq_authorizations_encrypted
          (id, owner_id, app_id, openid_fingerprint, label, account_hint, captured_at, expires_at, updated_at, ciphertext, nonce, auth_tag)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (owner_id, app_id, openid_fingerprint) DO UPDATE SET label = EXCLUDED.label,
            account_hint = EXCLUDED.account_hint, captured_at = EXCLUDED.captured_at, expires_at = EXCLUDED.expires_at,
            updated_at = EXCLUDED.updated_at, ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag
          RETURNING ${columns}`, [record.id, record.ownerId, QQ_APP_ID, record.fingerprint, record.label, record.accountHint,
          record.capturedAt, record.expiresAt, record.updatedAt, record.ciphertext, record.nonce, record.authTag]);
        await client.query('COMMIT'); transaction = false; return rowRecord(result.rows[0]);
      } finally { if (transaction) await client.query('ROLLBACK').catch(() => {}); }
    });
  }
  async list(ownerId: string): Promise<QqAuthorizationRecord[]> {
    return this.request(async client => {
      const result = await client.query(`SELECT ${columns} FROM naruto_login.qq_authorizations_encrypted WHERE owner_id = $1
        ORDER BY updated_at DESC, id LIMIT 201`, [ownerId]);
      if (result.rows.length > 200) throw limitReached();
      return result.rows.map(rowRecord);
    });
  }
  async get(ownerId: string, id: string): Promise<QqAuthorizationRecord | null> {
    return this.request(async client => {
      const result = await client.query(`SELECT ${columns} FROM naruto_login.qq_authorizations_encrypted WHERE owner_id = $1 AND id = $2`, [ownerId, id]);
      return result.rows[0] ? rowRecord(result.rows[0]) : null;
    });
  }
  async delete(ownerId: string, id: string): Promise<boolean> {
    return this.request(async client => (await client.query('DELETE FROM naruto_login.qq_authorizations_encrypted WHERE owner_id = $1 AND id = $2 RETURNING id', [ownerId, id])).rows.length === 1);
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export class QqAuthorizationService {
  private store?: QqAuthorizationStore;
  private readonly now: () => number;
  private readonly verify: (authorization: ParsedQqAuthorization) => Promise<void>;
  private cipher?: QqAuthorizationCipher;
  constructor(private readonly config: QqConfig, options: { store?: QqAuthorizationStore;
    now?: () => number; verify?: (authorization: ParsedQqAuthorization) => Promise<void> } = {}) {
    this.store = options.store; this.now = options.now ?? Date.now; this.verify = options.verify ?? verifyQqAuthorization;
  }
  private ready(): { store: QqAuthorizationStore; cipher: QqAuthorizationCipher } {
    if (this.config.appEnv !== 'test') throw notEnabled();
    if (!this.config.databaseUrl || !this.config.qqAuthorizationEncryptionKey) throw qqUnavailable();
    const cipher = this.cipher ??= new QqAuthorizationCipher(this.config.qqAuthorizationEncryptionKey);
    const store = this.store ??= new PgQqAuthorizationStore(this.config);
    return { store, cipher };
  }
  async initialize(): Promise<void> { await this.ready().store.initialize(); }
  isConfigured(): boolean {
    return this.config.appEnv === 'test' && !!this.config.databaseUrl && /^[0-9a-f]{64}$/i.test(this.config.qqAuthorizationEncryptionKey ?? '');
  }
  async close(): Promise<void> { await this.store?.close(); }
  private item(row: QqAuthorizationRecord): QqAuthorizationItem {
    return { id: row.id, label: row.label, accountHint: row.accountHint, capturedAt: row.capturedAt,
      expiresAt: row.expiresAt, updatedAt: row.updatedAt, expired: Date.parse(row.expiresAt) - this.now() < 1000 };
  }
  private validateOwner(ownerId: string): void { if (!uuid.test(ownerId)) throw new ApiError(401, '请先登录账号。', 'AUTH_REQUIRED'); }
  private validateId(id: string): void { if (!uuid.test(id)) throw new ApiError(400, '无效的 QQ 授权编号。', 'INVALID_QQ_AUTHORIZATION_ID'); }
  async upload(ownerId: string, body: unknown): Promise<{ item: QqAuthorizationItem }> {
    this.validateOwner(ownerId); const { store, cipher } = this.ready();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'label' && key !== 'authorization')) {
      throw new ApiError(400, '请填写账号备注并提交完整授权。', 'INVALID_QQ_AUTHORIZATION');
    }
    const input = body as Record<string, unknown>, label = typeof input.label === 'string' ? input.label.trim() : '';
    if ([...label].length < 1 || [...label].length > 40
      || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(label)
      || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(label)) {
      throw new ApiError(400, '账号备注须为 1–40 个常规字符。', 'INVALID_QQ_AUTHORIZATION_LABEL');
    }
    const parsed = parseQqAuthorization(input.authorization, this.now());
    try { await this.verify(parsed); } catch { throw new ApiError(502, 'QQ 授权校验失败，请重新扫码或稍后重试。', 'QQ_VERIFICATION_FAILED'); }
    // The network check may take time; do not store a grant that expired while verification was running.
    parseQqAuthorization(parsed.authorization, this.now());
    const openid = parsed.fields.get('openid')!, fingerprint = cipher.fingerprint(ownerId, openid);
    const encrypted = cipher.encrypt(parsed.authorization, `${ownerId}:${QQ_APP_ID}:${fingerprint}`);
    const record = await store.upsert({ id: randomUUID(), ownerId, fingerprint, label,
      accountHint: openid.slice(-6).toLowerCase(), capturedAt: new Date(parsed.authorization.captured_at_epoch_ms).toISOString(),
      expiresAt: new Date(parsed.expiresAt).toISOString(), updatedAt: new Date(this.now()).toISOString(), ...encrypted });
    return { item: this.item(record) };
  }
  async list(ownerId: string): Promise<{ items: QqAuthorizationItem[] }> {
    this.validateOwner(ownerId); const rows = await this.ready().store.list(ownerId);
    if (rows.length > 200) throw limitReached(); return { items: rows.map(row => this.item(row)) };
  }
  async get(ownerId: string, id: string): Promise<{ item: QqAuthorizationItem; authorization: QqAuthorization }> {
    this.validateOwner(ownerId); this.validateId(id); const { store, cipher } = this.ready();
    const row = await store.get(ownerId, id); if (!row) throw missing();
    if (this.item(row).expired) throw qqExpired();
    const parsed = parseQqAuthorization(cipher.decrypt(row, `${ownerId}:${QQ_APP_ID}:${row.fingerprint}`), this.now());
    if (parsed.expiresAt !== Date.parse(row.expiresAt) || parsed.authorization.captured_at_epoch_ms !== Date.parse(row.capturedAt)
      || cipher.fingerprint(ownerId, parsed.fields.get('openid')!) !== row.fingerprint) throw qqUnavailable();
    return { item: this.item(row), authorization: parsed.authorization };
  }
  async delete(ownerId: string, id: string): Promise<void> {
    this.validateOwner(ownerId); this.validateId(id);
    if (!await this.ready().store.delete(ownerId, id)) throw missing();
  }
}

/** Lazy initialization keeps existing website routes available when this optional test service is unconfigured. */
export function createQqAuthorizationService(config: Config): QqAuthorizationService {
  return new QqAuthorizationService(config);
}
