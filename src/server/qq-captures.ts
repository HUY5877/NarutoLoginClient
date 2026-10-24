import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { logBackend } from './logging.js';
import { parseQqAuthorization, qqAccountFingerprint, QQ_APP_ID, qqUnavailable, type QqAuthorization } from './qq-authorization-data.js';

export interface QqAuthorizationItem {
  id: string; appId: string; label: string; accountHint: string;
  capturedAt: string; expiresAt: string; updatedAt: string; expired: boolean;
}
export interface QqCaptureUpload {
  userId: string; taskId: string; attemptId: string; captureId: string; tokenHash: string;
  authorizationHash: string; authorization: QqAuthorization;
}
export interface QqCaptureResult { captureId: string; item?: QqAuthorizationItem }
export interface QqCaptureStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  accept(input: QqCaptureUpload): Promise<QqCaptureResult>;
  list(ownerId: string): Promise<QqAuthorizationItem[]>;
}
interface QueryResult { rows: Record<string, unknown>[]; rowCount?: number | null }
interface QqPgClient { query(sql: string, values?: unknown[]): Promise<QueryResult>; release(destroy?: boolean): void }
interface QqPgPool { connect(): Promise<QqPgClient>; end(): Promise<void> }
type QqConfig = Pick<Config, 'databaseUrl' | 'timeoutMs'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const invalid = () => new ApiError(400, '抓号任务参数无效，请重新生成二维码。', 'INVALID_QQ_CAPTURE');
const denied = () => new ApiError(403, '抓号任务凭证无效，请重新生成二维码。', 'QQ_CAPTURE_FORBIDDEN');
const expired = () => new ApiError(410, '本次抓号任务已结束，请重新生成二维码。', 'QQ_CAPTURE_EXPIRED');
const conflict = () => new ApiError(409, '本轮抓号已收到其他授权，请重新生成二维码。', 'QQ_CAPTURE_CONFLICT');
const limitReached = () => new ApiError(409, '最多保存 200 个账号，请先联系管理员清理旧账号。', 'QQ_AUTHORIZATION_LIMIT');
const itemColumns = `id, label, account_hint AS "accountHint", captured_at AS "capturedAt",
  expires_at AS "expiresAt", updated_at AS "updatedAt", expires_at <= clock_timestamp() AS expired`;
const item = (row: Record<string, unknown>): QqAuthorizationItem => ({
  id: row.id as string, appId: QQ_APP_ID, label: row.label as string, accountHint: row.accountHint as string,
  capturedAt: new Date(row.capturedAt as string | Date).toISOString(),
  expiresAt: new Date(row.expiresAt as string | Date).toISOString(),
  updatedAt: new Date(row.updatedAt as string | Date).toISOString(), expired: row.expired === true,
});

// Both environments use their configured database. Existing plaintext account rows remain compatible.
// The worker owns pending/refresh/consume/cancel transitions; uploads lock the same task row.
export const qqCaptureSchema = `CREATE TABLE IF NOT EXISTS naruto_login.qq_authorizations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  app_id text NOT NULL CHECK (app_id = '1104307008'),
  openid_fingerprint text NOT NULL CHECK (openid_fingerprint ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  account_hint text NOT NULL CHECK (account_hint ~ '^[0-9a-f]{6}$'),
  captured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > captured_at),
  updated_at timestamptz NOT NULL,
  access_token text NOT NULL CHECK (char_length(access_token) BETWEEN 16 AND 256 AND access_token ~ '^[0-9a-fA-F]+$'),
  openid text NOT NULL CHECK (char_length(openid) BETWEEN 16 AND 256 AND openid ~ '^[0-9a-fA-F]+$'),
  callback_url text NOT NULL CHECK (octet_length(callback_url) BETWEEN 1 AND 65536),
  UNIQUE (owner_id, app_id, openid_fingerprint)
);
CREATE INDEX IF NOT EXISTS qq_authorizations_owner_updated_idx
  ON naruto_login.qq_authorizations (owner_id, updated_at DESC, id);
CREATE TABLE IF NOT EXISTS naruto_login.qq_capture_requests (
  task_id uuid NOT NULL REFERENCES naruto_login.login_events(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  attempt_id text NOT NULL CHECK (attempt_id ~ '^[0-9a-f]{32}$'),
  capture_id uuid NOT NULL,
  capture_token_hash text NOT NULL CHECK (capture_token_hash ~ '^[0-9a-f]{64}$'),
  login_type text NOT NULL CHECK (login_type IN ('android_qq', 'ios_qq')),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'consumed', 'cancelled')),
  authorization_hash text CHECK (authorization_hash ~ '^[0-9a-f]{64}$'),
  callback_url text CHECK (octet_length(callback_url) BETWEEN 1 AND 65536),
  captured_at timestamptz,
  authorization_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, attempt_id),
  CHECK (status NOT IN ('completed', 'consumed') OR
    (authorization_hash IS NOT NULL AND captured_at IS NOT NULL AND authorization_expires_at IS NOT NULL)),
  CHECK (status <> 'completed' OR callback_url IS NOT NULL),
  CHECK (authorization_expires_at IS NULL OR authorization_expires_at > captured_at)
);`;

export class PgQqCaptureStore implements QqCaptureStore {
  private readonly pool: QqPgPool;
  private initialization?: Promise<void>;
  constructor(config: QqConfig, options: { pool?: QqPgPool } = {}) {
    if (!config.databaseUrl) throw qqUnavailable();
    const pool = options.pool ?? new Pool({ connectionString: config.databaseUrl, max: 3,
      connectionTimeoutMillis: config.timeoutMs, idleTimeoutMillis: 30000,
      statement_timeout: config.timeoutMs, query_timeout: config.timeoutMs });
    if (pool instanceof Pool) pool.on('error', () => logBackend('error', 'qq_capture.pool_failed',
      { component: 'qq_capture', errorCode: 'DATABASE_UNAVAILABLE' }));
    this.pool = pool;
  }
  async initialize(): Promise<void> {
    if (!this.initialization) {
      const pending = this.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('naruto_login.qq_capture.schema.v1'))");
        // Parent tables belong to the auth service. Never initialize or rewrite them here.
        await client.query(qqCaptureSchema);
      }).catch(error => { if (this.initialization === pending) this.initialization = undefined; throw error; });
      this.initialization = pending;
    }
    await this.initialization;
  }
  private async transaction<T>(run: (client: QqPgClient) => Promise<T>): Promise<T> {
    let client: QqPgClient | undefined, transaction = false;
    try {
      client = await this.pool.connect(); await client.query('BEGIN'); transaction = true;
      const result = await run(client); await client.query('COMMIT'); transaction = false; return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logBackend('error', 'qq_capture.database_failed', { component: 'qq_capture', error });
      throw qqUnavailable();
    } finally {
      if (transaction) { try { await client?.query('ROLLBACK'); transaction = false; } catch { /* Destroy an uncertain connection. */ } }
      client?.release(transaction);
    }
  }
  async accept(input: QqCaptureUpload): Promise<QqCaptureResult> {
    await this.initialize();
    return this.transaction(async client => {
      const result = await client.query(`SELECT owner_id AS "ownerId", attempt_id AS "attemptId", capture_id AS "captureId",
        capture_token_hash AS "tokenHash", login_type AS "loginType", expires_at AS "expiresAt", status,
        authorization_hash AS "authorizationHash" FROM naruto_login.qq_capture_requests
        WHERE task_id = $1 AND attempt_id = $2 FOR UPDATE`, [input.taskId, input.attemptId]);
      const row = result.rows[0];
      if (!row || row.ownerId !== input.userId || row.attemptId !== input.attemptId || row.captureId !== input.captureId
        || typeof row.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.tokenHash)
        || !timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(input.tokenHash, 'hex'))
        || row.loginType !== 'android_qq' && row.loginType !== 'ios_qq') throw denied();
      // Read database time after acquiring the row lock, including time spent waiting for a refresh.
      const clock = await client.query('SELECT clock_timestamp() AS now');
      const now = new Date(clock.rows[0].now as string | Date).getTime();
      if (new Date(row.expiresAt as string | Date).getTime() <= now || row.status === 'cancelled') throw expired();
      if (row.status === 'completed' || row.status === 'consumed') {
        if (row.authorizationHash !== input.authorizationHash) throw conflict();
        return { captureId: input.captureId };
      }
      if (row.status !== 'pending') throw expired();
      const parsed = parseQqAuthorization(input.authorization, now);
      const openid = parsed.fields.get('openid')!, fingerprint = qqAccountFingerprint(input.userId, openid);
      // Serialize each owner's insertion/count. This lock is always acquired after the capture row.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('huy:qq-owner:' || $1))", [input.userId]);
      const existing = await client.query(`SELECT ${itemColumns} FROM naruto_login.qq_authorizations
        WHERE owner_id = $1 AND app_id = $2 AND openid_fingerprint = $3 FOR UPDATE`, [input.userId, QQ_APP_ID, fingerprint]);
      let saved = existing.rows[0];
      if (!saved) {
        const count = await client.query('SELECT count(*)::int AS count FROM naruto_login.qq_authorizations WHERE owner_id = $1', [input.userId]);
        if (Number(count.rows[0]?.count) >= 200) throw limitReached();
      }
      if (!saved || new Date(saved.capturedAt as string | Date).getTime() <= parsed.authorization.captured_at_epoch_ms) {
        const stored = await client.query(`INSERT INTO naruto_login.qq_authorizations
          (id, owner_id, app_id, openid_fingerprint, label, account_hint, captured_at, expires_at, updated_at, access_token, openid, callback_url)
          VALUES ($1,$2,$3,$4,'自己账号',$5,$6,$7,clock_timestamp(),$8,$9,$10)
          ON CONFLICT (owner_id, app_id, openid_fingerprint) DO UPDATE SET label = EXCLUDED.label,
            account_hint = EXCLUDED.account_hint, captured_at = EXCLUDED.captured_at, expires_at = EXCLUDED.expires_at,
            updated_at = EXCLUDED.updated_at, access_token = EXCLUDED.access_token, openid = EXCLUDED.openid, callback_url = EXCLUDED.callback_url
          RETURNING ${itemColumns}`, [randomUUID(), input.userId, QQ_APP_ID, fingerprint, openid.slice(-6).toLowerCase(),
          new Date(parsed.authorization.captured_at_epoch_ms), new Date(parsed.expiresAt), parsed.fields.get('access_token')!, openid,
          parsed.authorization.callback_url]);
        saved = stored.rows[0];
      }
      // Recheck expiry after any account-lock wait; rollback the account write if the ticket elapsed.
      const completed = await client.query(`UPDATE naruto_login.qq_capture_requests
        SET status = 'completed', callback_url = $2, captured_at = $3, authorization_expires_at = $4,
          authorization_hash = $5, updated_at = clock_timestamp()
        WHERE task_id = $1 AND attempt_id = $6 AND capture_id = $7 AND owner_id = $8
          AND status = 'pending' AND expires_at > clock_timestamp() AND $4 > clock_timestamp() RETURNING task_id`,
      [input.taskId, parsed.authorization.callback_url, new Date(parsed.authorization.captured_at_epoch_ms), new Date(parsed.expiresAt),
        input.authorizationHash, input.attemptId, input.captureId, input.userId]);
      if (completed.rows.length !== 1) throw expired();
      return { captureId: input.captureId, item: item(saved) };
    });
  }
  async list(ownerId: string): Promise<QqAuthorizationItem[]> {
    await this.initialize();
    return this.transaction(async client => {
      const result = await client.query(`SELECT ${itemColumns} FROM naruto_login.qq_authorizations
        WHERE owner_id = $1 ORDER BY updated_at DESC, id LIMIT 201`, [ownerId]);
      if (result.rows.length > 200) throw limitReached();
      return result.rows.map(item);
    });
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export class QqCaptureService {
  private store?: QqCaptureStore;
  private readonly now: () => number;
  constructor(private readonly config: QqConfig, options: { store?: QqCaptureStore; now?: () => number } = {}) {
    this.store = options.store; this.now = options.now ?? Date.now;
  }
  private database(): QqCaptureStore { return this.store ??= new PgQqCaptureStore(this.config); }
  async initialize(): Promise<void> { await this.database().initialize(); }
  async close(): Promise<void> { await this.store?.close(); }
  async upload(body: unknown): Promise<QqCaptureResult> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
    const input = body as Record<string, unknown>;
    const allowed = ['userId', 'taskId', 'attemptId', 'captureId', 'captureToken', 'authorization'];
    if (Object.keys(input).length !== allowed.length || Object.keys(input).some(key => !allowed.includes(key))
      || ['userId', 'taskId', 'captureId'].some(key => typeof input[key] !== 'string' || !uuid.test(input[key] as string))
      || typeof input.attemptId !== 'string' || !/^[0-9a-f]{32}$/.test(input.attemptId)
      || typeof input.captureToken !== 'string' || !/^[0-9a-f]{64}$/.test(input.captureToken)) throw invalid();
    const parsed = parseQqAuthorization(input.authorization, this.now());
    return this.database().accept({ userId: (input.userId as string).toLowerCase(), taskId: (input.taskId as string).toLowerCase(),
      captureId: (input.captureId as string).toLowerCase(), attemptId: input.attemptId,
      tokenHash: digest(input.captureToken), authorizationHash: digest(parsed.authorization.callback_url), authorization: parsed.authorization });
  }
  async list(ownerId: string): Promise<{ items: QqAuthorizationItem[] }> {
    if (!uuid.test(ownerId)) throw new ApiError(401, '请先登录账号。', 'AUTH_REQUIRED');
    return { items: await this.database().list(ownerId.toLowerCase()) };
  }
}
