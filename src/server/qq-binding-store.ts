import { Pool } from 'pg';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { logBackend } from './logging.js';

export interface QqBindingScope { userId: string; appId: string; groupOpenid: string }
export interface QqBindingStatus {
  enabled: boolean;
  binding: { boundAt: string } | null;
  challenge: { id: string; expiresAt: string; received: boolean; senderName: string | null } | null;
}
interface QueryResult { rows: Record<string, unknown>[] }
interface QqBindingClient { query(sql: string, values?: unknown[]): Promise<QueryResult>; release(destroy?: boolean): void }
interface QqBindingPool { connect(): Promise<QqBindingClient>; end(): Promise<void> }
export interface QqBindingStore {
  initialize(): Promise<void>;
  getStatus(scope: QqBindingScope, now: Date): Promise<QqBindingStatus>;
  createChallenge(scope: QqBindingScope, challengeId: string, codeHash: string, now: Date, expiresAt: Date): Promise<void>;
  receiveCandidate(appId: string, groupOpenid: string, codeHash: string, memberOpenid: string, senderName: string | null, now: Date): Promise<void>;
  confirm(scope: QqBindingScope, challengeId: string, now: Date): Promise<{ boundAt: string }>;
  unbind(scope: QqBindingScope): Promise<void>;
  close(): Promise<void>;
}

const schema = `CREATE TABLE IF NOT EXISTS naruto_login.qq_bindings (
  user_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  bot_app_id text NOT NULL,
  group_openid text NOT NULL,
  member_openid text NOT NULL,
  bound_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, bot_app_id, group_openid),
  CONSTRAINT qq_bindings_member_key UNIQUE (bot_app_id, group_openid, member_openid)
);
CREATE TABLE IF NOT EXISTS naruto_login.qq_binding_challenges (
  user_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  bot_app_id text NOT NULL,
  group_openid text NOT NULL,
  challenge_id uuid NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  member_openid text,
  sender_name text,
  PRIMARY KEY (user_id, bot_app_id, group_openid),
  CONSTRAINT qq_binding_challenges_code_key UNIQUE (bot_app_id, group_openid, code_hash)
);`;
const scopeValues = (scope: QqBindingScope) => [scope.userId, scope.appId, scope.groupOpenid];
const whereScope = 'user_id = $1 AND bot_app_id = $2 AND group_openid = $3';
const noCandidate = () => new ApiError(409, '绑定验证尚未完成或已过期，请重新生成绑定码并在群内验证。', 'QQ_BINDING_NOT_READY');

/** users is initialized by AuthService before this store creates its own tables. */
export class PgQqBindingStore implements QqBindingStore {
  private readonly pool: QqBindingPool;
  private initialization?: Promise<void>;
  constructor(config: Pick<Config, 'databaseUrl' | 'timeoutMs'>,
    private readonly options: { beforeInitialize: () => Promise<void>; pool?: QqBindingPool }) {
    const pool = options.pool ?? new Pool({ connectionString: config.databaseUrl, max: 3,
      connectionTimeoutMillis: config.timeoutMs, query_timeout: config.timeoutMs, statement_timeout: config.timeoutMs,
      idle_in_transaction_session_timeout: config.timeoutMs, idleTimeoutMillis: 10000, allowExitOnIdle: true,
      application_name: 'naruto-login-client-qq-binding' });
    if (pool instanceof Pool) pool.on('error', () => logBackend('error', 'qq_binding.pool_failed', { component: 'qq_binding', errorCode: 'DATABASE_UNAVAILABLE' }));
    this.pool = pool;
  }
  private async transaction<T>(run: (client: QqBindingClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let failed = false;
    try {
      await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result;
    } catch (error) {
      failed = true; try { await client.query('ROLLBACK'); } catch { /* Never expose driver diagnostics. */ }
      throw error;
    } finally { client.release(failed); }
  }
  async initialize(): Promise<void> {
    if (!this.initialization) {
      const pending = (async () => {
        await this.options.beforeInitialize();
        await this.transaction(async client => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('naruto_login.qq_binding.schema.v1'))");
          await client.query(schema);
        });
      })().catch(error => { if (this.initialization === pending) this.initialization = undefined; throw error; });
      this.initialization = pending;
    }
    await this.initialization;
  }
  private async lockUser(client: QqBindingClient, userId: string): Promise<void> {
    const user = await client.query('SELECT id FROM naruto_login.users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows.length) throw new ApiError(401, '请重新登录账号。', 'AUTH_REQUIRED');
  }
  async getStatus(scope: QqBindingScope, now: Date): Promise<QqBindingStatus> {
    return this.transaction(async client => {
      // A single statement gives binding and candidate from the same PostgreSQL snapshot.
      const result = await client.query(`SELECT b.bound_at AS "boundAt", c.challenge_id AS "challengeId", c.expires_at AS "expiresAt",
        c.member_openid IS NOT NULL AS received, c.sender_name AS "senderName"
        FROM (SELECT $1::uuid AS user_id, $2::text AS bot_app_id, $3::text AS group_openid) s
        LEFT JOIN naruto_login.qq_bindings b USING (user_id, bot_app_id, group_openid)
        LEFT JOIN naruto_login.qq_binding_challenges c ON c.user_id = s.user_id AND c.bot_app_id = s.bot_app_id
          AND c.group_openid = s.group_openid AND c.expires_at > $4`, [...scopeValues(scope), now]);
      const row = result.rows[0];
      return { enabled: true, binding: row.boundAt ? { boundAt: new Date(row.boundAt as string | Date).toISOString() } : null,
        challenge: row.expiresAt ? { id: row.challengeId as string, expiresAt: new Date(row.expiresAt as string | Date).toISOString(), received: row.received === true,
          senderName: typeof row.senderName === 'string' ? row.senderName : null } : null };
    });
  }
  async createChallenge(scope: QqBindingScope, challengeId: string, codeHash: string, now: Date, expiresAt: Date): Promise<void> {
    await this.transaction(async client => {
      await this.lockUser(client, scope.userId);
      await client.query(`INSERT INTO naruto_login.qq_binding_challenges
        (user_id, bot_app_id, group_openid, challenge_id, code_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, bot_app_id, group_openid) DO UPDATE SET challenge_id = EXCLUDED.challenge_id, code_hash = EXCLUDED.code_hash,
          created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, member_openid = NULL, sender_name = NULL`,
      [...scopeValues(scope), challengeId, codeHash, now, expiresAt]);
    });
  }
  async receiveCandidate(appId: string, groupOpenid: string, codeHash: string, memberOpenid: string, senderName: string | null, now: Date): Promise<void> {
    await this.transaction(async client => {
      await client.query(`UPDATE naruto_login.qq_binding_challenges SET member_openid = $4, sender_name = $5
        WHERE bot_app_id = $1 AND group_openid = $2 AND code_hash = $3 AND expires_at > $6 AND member_openid IS NULL`,
      [appId, groupOpenid, codeHash, memberOpenid, senderName, now]);
    });
  }
  async confirm(scope: QqBindingScope, challengeId: string, now: Date): Promise<{ boundAt: string }> {
    try {
      return await this.transaction(async client => {
        await this.lockUser(client, scope.userId);
        const result = await client.query(`SELECT member_openid FROM naruto_login.qq_binding_challenges
          WHERE ${whereScope} AND challenge_id = $4 AND expires_at > $5 FOR UPDATE`, [...scopeValues(scope), challengeId, now]);
        const member = result.rows[0]?.member_openid;
        if (typeof member !== 'string' || !member) throw noCandidate();
        await client.query(`INSERT INTO naruto_login.qq_bindings (user_id, bot_app_id, group_openid, member_openid, bound_at)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, bot_app_id, group_openid)
          DO UPDATE SET member_openid = EXCLUDED.member_openid, bound_at = EXCLUDED.bound_at`, [...scopeValues(scope), member, now]);
        await client.query(`DELETE FROM naruto_login.qq_binding_challenges WHERE ${whereScope}`, scopeValues(scope));
        return { boundAt: now.toISOString() };
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new ApiError(409, '该群成员已绑定其他网站账号，请先解绑原账号。', 'QQ_BINDING_MEMBER_TAKEN');
      }
      throw error;
    }
  }
  async unbind(scope: QqBindingScope): Promise<void> {
    await this.transaction(async client => {
      await this.lockUser(client, scope.userId);
      await client.query(`DELETE FROM naruto_login.qq_binding_challenges WHERE ${whereScope}`, scopeValues(scope));
      await client.query(`DELETE FROM naruto_login.qq_bindings WHERE ${whereScope}`, scopeValues(scope));
    });
  }
  async close(): Promise<void> { await this.pool.end(); }
}
