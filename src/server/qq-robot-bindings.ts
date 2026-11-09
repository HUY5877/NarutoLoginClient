import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

interface QueryResult { rows: Record<string, unknown>[] }
export interface QqRobotBindingClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
}
export interface QqRobotBindingPool { connect(): Promise<QqRobotBindingClient>; end(): Promise<void> }
type BindingConfig = Pick<Config, 'databaseUrl' | 'timeoutMs'> & { hyrzPublicUrl?: string };
export interface QqRobotBindingStatus {
  enabled: boolean;
  binding: { qq: string; boundAt: string } | null;
  challenge: { id: string; expiresAt: string } | null;
}
export interface QqRobotBindingStore {
  initialize(): Promise<void>;
  bind(qq: string, now: Date): Promise<{ qq: string; userId: string }>;
  getStatus(userId: string, now: Date): Promise<QqRobotBindingStatus>;
  createChallenge(userId: string, id: string, codeHash: string, now: Date, expiresAt: Date): Promise<void>;
  redeem(qq: string, codeHash: string, now: Date): Promise<{ qq: string; userId: string }>;
  resolve(qq: string): Promise<{ qq: string; userId: string }>;
  unbind(userId: string): Promise<void>;
  assertActiveUser(userId: string): Promise<void>;
  close(): Promise<void>;
}

const unavailable = () => new ApiError(503, '数字 QQ 绑定服务暂不可用。', 'MCP_QQ_BINDING_UNAVAILABLE');
const invalidCode = () => new ApiError(409, '绑定码已失效，请登录网站重新生成。', 'MCP_QQ_BINDING_CODE_EXPIRED');
const inactive = () => new ApiError(403, '网站账号不存在或已停用。', 'MCP_USER_INACTIVE');
const conflict = () => new ApiError(409, '该 QQ 已绑定其他网站账号，请先解除原绑定。', 'MCP_QQ_ALREADY_BOUND');
const safeError = (error: unknown): ApiError => error instanceof ApiError ? error
  : error && typeof error === 'object' && 'code' in error && error.code === '23505' ? conflict() : unavailable();
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const fullMatch = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const qqPattern = /^[1-9][0-9]*$/;
const userPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^[A-Za-z0-9_-]{24}$/;
const validateQq = (qq: string) => { if (!fullMatch(qqPattern, qq)) throw new ApiError(400, 'QQ 号必须是不含前导零的数字字符串。', 'INVALID_QQ_NUMBER'); };
const validateUser = (userId: string) => { if (!fullMatch(userPattern, userId)) throw new ApiError(400, '网站用户 ID 格式无效。', 'INVALID_USER_ID'); };
const validateCode = (code: string) => { if (!fullMatch(codePattern, code)) throw new ApiError(400, '绑定码格式无效。', 'INVALID_QQ_BINDING_CODE'); };

const schema = `CREATE TABLE IF NOT EXISTS naruto_login.qq_robot_bindings (
  user_id uuid PRIMARY KEY REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  qq_number text NOT NULL UNIQUE CHECK (qq_number ~ '^[1-9][0-9]*$'),
  bound_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS naruto_login.qq_robot_binding_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  challenge_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'revoked')),
  qq_number text CHECK (qq_number ~ '^[1-9][0-9]*$'),
  bound_at timestamptz,
  CHECK (status <> 'confirmed' OR (qq_number IS NOT NULL AND bound_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS qq_robot_binding_codes_user_idx ON naruto_login.qq_robot_binding_codes(user_id);
CREATE INDEX IF NOT EXISTS qq_robot_binding_codes_expires_idx ON naruto_login.qq_robot_binding_codes(expires_at);`;

/** New robot associations are independent of every legacy QQ mapping and request table. */
export class PgQqRobotBindingStore implements QqRobotBindingStore {
  private pool?: QqRobotBindingPool;
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly config: BindingConfig,
    private readonly options: { beforeInitialize: () => Promise<void>; pool?: QqRobotBindingPool }) {
    this.pool = options.pool;
  }
  private getPool(): QqRobotBindingPool {
    if (this.closing) throw unavailable();
    if (!this.pool) {
      if (!this.config.databaseUrl) throw unavailable();
      const pool = new Pool({ connectionString: this.config.databaseUrl, max: 3,
        connectionTimeoutMillis: this.config.timeoutMs, query_timeout: this.config.timeoutMs,
        statement_timeout: this.config.timeoutMs, idle_in_transaction_session_timeout: this.config.timeoutMs,
        idleTimeoutMillis: 10000, allowExitOnIdle: true, application_name: 'naruto-login-client-qq-robot-binding' });
      // Driver errors can contain credentials; never forward them to application logs or callers.
      pool.on('error', () => {});
      this.pool = pool;
    }
    return this.pool;
  }
  private async transaction<T>(run: (client: QqRobotBindingClient) => Promise<T>): Promise<T> {
    let client: QqRobotBindingClient | undefined; let failed = false;
    try {
      client = await this.getPool().connect(); await client.query('BEGIN');
      const value = await run(client); await client.query('COMMIT'); return value;
    } catch (error) {
      failed = true;
      if (client) try { await client.query('ROLLBACK'); } catch { /* Preserve only safe error information. */ }
      throw safeError(error);
    } finally { client?.release(failed); }
  }
  async initialize(): Promise<void> {
    if (this.closing) throw unavailable();
    if (!this.initialization) {
      const pending = (async () => {
        await this.options.beforeInitialize();
        await this.transaction(async client => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('naruto_login.qq_robot_binding.schema.v1'))");
          await client.query(schema);
        });
      })().catch(error => { if (this.initialization === pending) this.initialization = undefined; throw safeError(error); });
      this.initialization = pending;
    }
    await this.initialization;
  }
  private async lockBindings(client: QqRobotBindingClient): Promise<void> {
    // Robot association/code writes share one cross-process lock, separate from legacy bindings.
    // A common lock order prevents deadlocks when two users exchange QQ numbers.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('naruto_login.qq_robot_binding.write.v1'))");
  }
  private async activeUser(client: QqRobotBindingClient, userId: string): Promise<void> {
    const result = await client.query('SELECT id FROM naruto_login.users WHERE id = $1 AND is_invalid = false FOR SHARE', [userId]);
    if (!result.rows.length) throw inactive();
  }
  async bind(qq: string, now: Date): Promise<{ qq: string; userId: string }> {
    validateQq(qq);
    return this.transaction(async client => {
      await this.lockBindings(client);
      const existing = (await client.query('SELECT user_id FROM naruto_login.qq_robot_bindings WHERE qq_number = $1', [qq])).rows[0];
      let userId: string;
      if (existing) {
        userId = existing.user_id as string;
        await this.activeUser(client, userId);
      } else {
        userId = randomUUID();
        // Independent random credentials cannot identify or take over an existing website account.
        const username = randomBytes(12).toString('hex');
        const password = randomBytes(32).toString('base64url');
        await client.query(`INSERT INTO naruto_login.users(id, username, username_key, password, is_invalid, is_admin, created_at)
          VALUES ($1, $2, $2, $3, false, false, $4)`, [userId, username, password, now]);
        await client.query('INSERT INTO naruto_login.qq_robot_bindings(user_id, qq_number, bound_at) VALUES ($1, $2, $3)', [userId, qq, now]);
      }
      return { qq, userId };
    });
  }
  async getStatus(userId: string, now: Date): Promise<QqRobotBindingStatus> {
    return this.transaction(async client => {
      await this.activeUser(client, userId);
      const row = (await client.query(`SELECT b.qq_number, b.bound_at, c.challenge_id, c.expires_at
        FROM (SELECT $1::uuid AS user_id) u
        LEFT JOIN naruto_login.qq_robot_bindings b USING (user_id)
        LEFT JOIN naruto_login.qq_robot_binding_codes c ON c.user_id = u.user_id
          AND c.status = 'pending' AND c.expires_at > $2`, [userId, now])).rows[0];
      return { enabled: true,
        binding: row.qq_number ? { qq: row.qq_number as string, boundAt: iso(row.bound_at) } : null,
        challenge: row.challenge_id ? { id: row.challenge_id as string, expiresAt: iso(row.expires_at) } : null };
    });
  }
  async createChallenge(userId: string, id: string, codeHash: string, now: Date, expiresAt: Date): Promise<void> {
    await this.transaction(async client => {
      await this.lockBindings(client); await this.activeUser(client, userId);
      await client.query('DELETE FROM naruto_login.qq_robot_binding_codes WHERE expires_at <= $1', [now]);
      await client.query("UPDATE naruto_login.qq_robot_binding_codes SET status = 'revoked' WHERE user_id = $1", [userId]);
      await client.query(`INSERT INTO naruto_login.qq_robot_binding_codes
        (code_hash, challenge_id, user_id, created_at, expires_at, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [codeHash, id, userId, now, expiresAt]);
    });
  }
  async redeem(qq: string, codeHash: string, now: Date): Promise<{ qq: string; userId: string }> {
    return this.transaction(async client => {
      await this.lockBindings(client);
      const code = (await client.query(`SELECT user_id, status, qq_number, bound_at
        FROM naruto_login.qq_robot_binding_codes WHERE code_hash = $1 AND expires_at > $2 FOR UPDATE`, [codeHash, now])).rows[0];
      if (!code || code.status === 'revoked') throw invalidCode();
      const userId = code.user_id as string;
      await this.activeUser(client, userId);
      if (code.status === 'confirmed') {
        if (code.qq_number !== qq) throw invalidCode();
        const current = (await client.query(`SELECT user_id FROM naruto_login.qq_robot_bindings
          WHERE user_id = $1 AND qq_number = $2 AND bound_at = $3`, [userId, qq, code.bound_at])).rows[0];
        if (!current) throw invalidCode();
        return { qq, userId };
      }
      const source = (await client.query('SELECT user_id FROM naruto_login.qq_robot_bindings WHERE qq_number = $1', [qq])).rows[0];
      const destination = (await client.query('SELECT qq_number FROM naruto_login.qq_robot_bindings WHERE user_id = $1', [userId])).rows[0];
      const affectedUsers = [...new Set([userId, ...(source ? [source.user_id as string] : [])])];
      // Proof of the website account and real QQ sender permits moving the association,
      // but never moves/deletes users, tasks, or official OpenID records.
      await client.query("UPDATE naruto_login.qq_robot_binding_codes SET status = 'revoked' WHERE user_id = ANY($1::uuid[])", [affectedUsers]);
      await client.query('DELETE FROM naruto_login.qq_robot_bindings WHERE user_id = $1 OR qq_number = $2', [userId, qq]);
      await client.query('INSERT INTO naruto_login.qq_robot_bindings(user_id, qq_number, bound_at) VALUES ($1, $2, $3)', [userId, qq, now]);
      await client.query(`UPDATE naruto_login.qq_robot_binding_codes SET status = 'confirmed', qq_number = $2, bound_at = $3
        WHERE code_hash = $1`, [codeHash, qq, now]);
      return { qq, userId };
    });
  }
  async resolve(qq: string): Promise<{ qq: string; userId: string }> {
    return this.transaction(async client => {
      const row = (await client.query(`SELECT b.user_id FROM naruto_login.qq_robot_bindings b
        JOIN naruto_login.users u ON u.id = b.user_id WHERE b.qq_number = $1 AND u.is_invalid = false`, [qq])).rows[0];
      if (!row) throw new ApiError(404, '该 QQ 尚未绑定有效的网站账号。', 'MCP_QQ_NOT_BOUND');
      return { qq, userId: row.user_id as string };
    });
  }
  async unbind(userId: string): Promise<void> {
    await this.transaction(async client => {
      await this.lockBindings(client); await this.activeUser(client, userId);
      await client.query("UPDATE naruto_login.qq_robot_binding_codes SET status = 'revoked' WHERE user_id = $1", [userId]);
      await client.query('DELETE FROM naruto_login.qq_robot_bindings WHERE user_id = $1', [userId]);
    });
  }
  async assertActiveUser(userId: string): Promise<void> {
    await this.transaction(client => this.activeUser(client, userId));
  }
  async close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      try { await this.initialization; } catch { /* Initialization failure must not prevent cleanup. */ }
      try { await this.pool?.end(); } catch (error) { throw safeError(error); }
    })();
    await this.closing;
  }
}

export class QqRobotBindingService {
  private readonly store: QqRobotBindingStore;
  private readonly now: () => number;
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly config: BindingConfig,
    private readonly options: { beforeInitialize: () => Promise<void>; store?: QqRobotBindingStore; now?: () => number }) {
    this.store = options.store ?? new PgQqRobotBindingStore(config, { beforeInitialize: async () => {} });
    this.now = options.now ?? Date.now;
  }
  private async ready(): Promise<void> {
    if (this.closing || !this.config.databaseUrl) throw unavailable();
    if (!this.initialization) {
      const pending = (async () => { await this.options.beforeInitialize(); await this.store.initialize(); })()
        .catch(error => { if (this.initialization === pending) this.initialization = undefined; throw safeError(error); });
      this.initialization = pending;
    }
    await this.initialization;
  }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try { await this.ready(); return await work(); } catch (error) { throw safeError(error); }
  }
  async bind(qq: string, bindingCode?: string): Promise<{ qq: string; userId: string }> {
    validateQq(qq);
    if (bindingCode !== undefined) {
      validateCode(bindingCode);
      return this.run(() => this.store.redeem(qq, digest(bindingCode), new Date(this.now())));
    }
    return this.run(() => this.store.bind(qq, new Date(this.now())));
  }
  async getStatus(userId: string): Promise<QqRobotBindingStatus> {
    validateUser(userId);
    return this.run(() => this.store.getStatus(userId.toLowerCase(), new Date(this.now())));
  }
  async createChallenge(userId: string): Promise<{ id: string; code: string; expiresAt: string }> {
    validateUser(userId);
    return this.run(async () => {
      const id = randomUUID(), code = randomBytes(18).toString('base64url');
      const now = new Date(this.now()), expiresAt = new Date(now.getTime() + 300000);
      await this.store.createChallenge(userId.toLowerCase(), id, digest(code), now, expiresAt);
      return { id, code, expiresAt: expiresAt.toISOString() };
    });
  }
  async resolve(qq: string): Promise<{ qq: string; userId: string }> {
    validateQq(qq); return this.run(() => this.store.resolve(qq));
  }
  async unbind(userId: string): Promise<{ userId: string; status: 'unbound' }> {
    validateUser(userId); const canonicalId = userId.toLowerCase();
    return this.run(async () => { await this.store.unbind(canonicalId); return { userId: canonicalId, status: 'unbound' }; });
  }
  async assertActiveUser(userId: string): Promise<void> {
    validateUser(userId); await this.run(() => this.store.assertActiveUser(userId.toLowerCase()));
  }
  async close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      try { await this.initialization; } catch { /* Still close resources after failure. */ }
      try { await this.store.close(); } catch (error) { throw safeError(error); }
    })();
    await this.closing;
  }
}
