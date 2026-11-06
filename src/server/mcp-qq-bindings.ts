import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

interface QueryResult { rows: Record<string, unknown>[] }
export interface McpQqBindingClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
}
export interface McpQqBindingPool { connect(): Promise<McpQqBindingClient>; end(): Promise<void> }
type BindingConfig = Pick<Config, 'databaseUrl' | 'timeoutMs'> & { hyrzPublicUrl?: string };
export interface McpQqNumberBinding { qq: string; userId: string; boundAt: string }
export interface McpQqBindingStore {
  initialize(): Promise<void>;
  create(qq: string, tokenHash: string, now: Date, expiresAt: Date): Promise<void>;
  preview(tokenHash: string, now: Date): Promise<{ qq: string; expiresAt: string }>;
  confirm(userId: string, tokenHash: string, now: Date): Promise<McpQqNumberBinding>;
  resolve(qq: string): Promise<{ qq: string; userId: string }>;
  unbind(userId: string): Promise<void>;
  assertActiveUser(userId: string): Promise<void>;
  close(): Promise<void>;
}

const unavailable = () => new ApiError(503, '数字 QQ 绑定服务暂不可用。', 'MCP_QQ_BINDING_UNAVAILABLE');
const invalidRequest = () => new ApiError(409, '绑定链接已失效，请重新生成。', 'MCP_QQ_BINDING_EXPIRED');
const inactive = () => new ApiError(403, '网站账号不存在或已停用。', 'MCP_USER_INACTIVE');
const conflict = () => new ApiError(409, '该 QQ 已绑定其他网站账号，请先解除原绑定。', 'MCP_QQ_ALREADY_BOUND');
const safeError = (error: unknown): ApiError => error instanceof ApiError ? error
  : error && typeof error === 'object' && 'code' in error && error.code === '23505' ? conflict() : unavailable();
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const fullMatch = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const qqPattern = /^[1-9][0-9]*$/;
const userPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const validateQq = (qq: string) => { if (!fullMatch(qqPattern, qq)) throw new ApiError(400, 'QQ 号必须是不含前导零的数字字符串。', 'INVALID_QQ_NUMBER'); };
const validateUser = (userId: string) => { if (!fullMatch(userPattern, userId)) throw new ApiError(400, '网站用户 ID 格式无效。', 'INVALID_USER_ID'); };
const validateToken = (token: string) => { if (!fullMatch(tokenPattern, token)) throw new ApiError(400, '绑定链接格式无效。', 'INVALID_QQ_BINDING_TOKEN'); };

const schema = `CREATE TABLE IF NOT EXISTS naruto_login.qq_number_bindings (
  user_id uuid PRIMARY KEY REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  qq_number text NOT NULL UNIQUE CHECK (qq_number ~ '^[1-9][0-9]*$'),
  bound_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS naruto_login.qq_number_binding_requests (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  qq_number text NOT NULL CHECK (qq_number ~ '^[1-9][0-9]*$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'revoked')),
  user_id uuid REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  bound_at timestamptz,
  CHECK (status <> 'confirmed' OR (user_id IS NOT NULL AND bound_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS qq_number_binding_requests_qq_idx ON naruto_login.qq_number_binding_requests(qq_number);
CREATE INDEX IF NOT EXISTS qq_number_binding_requests_expires_idx ON naruto_login.qq_number_binding_requests(expires_at);`;

/** Owns only the numeric QQ tables; the existing openid tables are never read or changed. */
export class PgMcpQqBindingStore implements McpQqBindingStore {
  private pool?: McpQqBindingPool;
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly config: BindingConfig,
    private readonly options: { beforeInitialize: () => Promise<void>; pool?: McpQqBindingPool }) {
    this.pool = options.pool;
  }
  private getPool(): McpQqBindingPool {
    if (this.closing) throw unavailable();
    if (!this.pool) {
      if (!this.config.databaseUrl) throw unavailable();
      const pool = new Pool({ connectionString: this.config.databaseUrl, max: 3,
        connectionTimeoutMillis: this.config.timeoutMs, query_timeout: this.config.timeoutMs,
        statement_timeout: this.config.timeoutMs, idle_in_transaction_session_timeout: this.config.timeoutMs,
        idleTimeoutMillis: 10000, allowExitOnIdle: true, application_name: 'naruto-login-client-mcp-qq-binding' });
      // Driver errors can contain credentials; never forward them to application logs or callers.
      pool.on('error', () => {});
      this.pool = pool;
    }
    return this.pool;
  }
  private async transaction<T>(run: (client: McpQqBindingClient) => Promise<T>): Promise<T> {
    let client: McpQqBindingClient | undefined; let failed = false;
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
          await client.query("SELECT pg_advisory_xact_lock(hashtext('naruto_login.qq_number_binding.schema.v1'))");
          await client.query(schema);
        });
      })().catch(error => { if (this.initialization === pending) this.initialization = undefined; throw safeError(error); });
      this.initialization = pending;
    }
    await this.initialization;
  }
  private async lockBindings(client: McpQqBindingClient): Promise<void> {
    // All numeric binding writes share this cross-process lock, including challenge revocation.
    // A common lock order prevents deadlocks when two users exchange QQ numbers.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('naruto_login.qq_number_binding.write.v1'))");
  }
  private async activeUser(client: McpQqBindingClient, userId: string): Promise<void> {
    const result = await client.query('SELECT id FROM naruto_login.users WHERE id = $1 AND is_invalid = false FOR SHARE', [userId]);
    if (!result.rows.length) throw inactive();
  }
  async create(qq: string, tokenHash: string, now: Date, expiresAt: Date): Promise<void> {
    await this.transaction(async client => {
      await this.lockBindings(client);
      await client.query('DELETE FROM naruto_login.qq_number_binding_requests WHERE expires_at <= $1', [now]);
      await client.query("UPDATE naruto_login.qq_number_binding_requests SET status = 'revoked' WHERE qq_number = $1 AND status = 'pending'", [qq]);
      await client.query(`INSERT INTO naruto_login.qq_number_binding_requests(token_hash, qq_number, created_at, expires_at, status)
        VALUES ($1, $2, $3, $4, 'pending')`, [tokenHash, qq, now, expiresAt]);
    });
  }
  async preview(tokenHash: string, now: Date): Promise<{ qq: string; expiresAt: string }> {
    return this.transaction(async client => {
      const result = await client.query(`SELECT qq_number, expires_at FROM naruto_login.qq_number_binding_requests
        WHERE token_hash = $1 AND status IN ('pending', 'confirmed') AND expires_at > $2`, [tokenHash, now]);
      const row = result.rows[0]; if (!row) throw invalidRequest();
      return { qq: row.qq_number as string, expiresAt: iso(row.expires_at) };
    });
  }
  async confirm(userId: string, tokenHash: string, now: Date): Promise<McpQqNumberBinding> {
    return this.transaction(async client => {
      await this.lockBindings(client); await this.activeUser(client, userId);
      const request = (await client.query(`SELECT qq_number, status, user_id, bound_at FROM naruto_login.qq_number_binding_requests
        WHERE token_hash = $1 AND expires_at > $2 FOR UPDATE`, [tokenHash, now])).rows[0];
      if (!request || request.status === 'revoked') throw invalidRequest();
      const qq = request.qq_number as string;
      if (request.status === 'confirmed') {
        if (request.user_id !== userId) throw invalidRequest();
        const binding = (await client.query(`SELECT user_id FROM naruto_login.qq_number_bindings
          WHERE user_id = $1 AND qq_number = $2 AND bound_at = $3`, [userId, qq, request.bound_at])).rows[0];
        if (!binding) throw invalidRequest();
        return { qq, userId, boundAt: iso(request.bound_at) };
      }
      const owner = (await client.query('SELECT user_id, bound_at FROM naruto_login.qq_number_bindings WHERE qq_number = $1', [qq])).rows[0];
      if (owner && owner.user_id !== userId) throw conflict();
      const boundAt = owner ? new Date(owner.bound_at as string | Date) : now;
      const old = (await client.query('SELECT qq_number FROM naruto_login.qq_number_bindings WHERE user_id = $1', [userId])).rows[0];
      if (old && old.qq_number !== qq) {
        await client.query("UPDATE naruto_login.qq_number_binding_requests SET status = 'revoked' WHERE qq_number = $1", [old.qq_number]);
      }
      await client.query(`INSERT INTO naruto_login.qq_number_bindings(user_id, qq_number, bound_at) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET qq_number = EXCLUDED.qq_number, bound_at = EXCLUDED.bound_at`, [userId, qq, boundAt]);
      await client.query(`UPDATE naruto_login.qq_number_binding_requests SET status = 'confirmed', user_id = $2, bound_at = $3
        WHERE token_hash = $1`, [tokenHash, userId, boundAt]);
      return { qq, userId, boundAt: boundAt.toISOString() };
    });
  }
  async resolve(qq: string): Promise<{ qq: string; userId: string }> {
    return this.transaction(async client => {
      const row = (await client.query(`SELECT b.user_id FROM naruto_login.qq_number_bindings b
        JOIN naruto_login.users u ON u.id = b.user_id WHERE b.qq_number = $1 AND u.is_invalid = false`, [qq])).rows[0];
      if (!row) throw new ApiError(404, '该 QQ 尚未绑定有效的网站账号。', 'MCP_QQ_NOT_BOUND');
      return { qq, userId: row.user_id as string };
    });
  }
  async unbind(userId: string): Promise<void> {
    await this.transaction(async client => {
      await this.lockBindings(client); await this.activeUser(client, userId);
      await client.query(`UPDATE naruto_login.qq_number_binding_requests SET status = 'revoked'
        WHERE user_id = $1 OR qq_number IN (SELECT qq_number FROM naruto_login.qq_number_bindings WHERE user_id = $1)`, [userId]);
      await client.query('DELETE FROM naruto_login.qq_number_bindings WHERE user_id = $1', [userId]);
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

export class McpQqBindingService {
  private readonly store: McpQqBindingStore;
  private readonly now: () => number;
  private initialization?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly config: BindingConfig,
    private readonly options: { beforeInitialize: () => Promise<void>; store?: McpQqBindingStore; now?: () => number }) {
    this.store = options.store ?? new PgMcpQqBindingStore(config, { beforeInitialize: async () => {} });
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
  private origin(requestOrigin?: string): string {
    try {
      const value = this.config.hyrzPublicUrl ?? requestOrigin;
      // Validate the original text too: URL normalizes empty credentials, bare
      // query/fragment markers, whitespace and backslashes before inspection.
      if (!fullMatch(/^https?:\/\/[^/?#@\\\s]+\/?$/, value)) throw unavailable();
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw unavailable();
      return url.origin;
    } catch { throw unavailable(); }
  }
  async create(qq: string, requestOrigin?: string): Promise<{ qq: string; bindingUrl: string; expiresAt: string }> {
    validateQq(qq); const origin = this.origin(requestOrigin);
    return this.run(async () => {
      const token = randomBytes(32).toString('base64url'); const now = new Date(this.now()); const expires = new Date(now.getTime() + 300000);
      await this.store.create(qq, digest(token), now, expires);
      return { qq, bindingUrl: `${origin}/#mcp-bind=${token}`, expiresAt: expires.toISOString() };
    });
  }
  async preview(token: string): Promise<{ qq: string; expiresAt: string }> {
    validateToken(token); return this.run(() => this.store.preview(digest(token), new Date(this.now())));
  }
  async confirm(userId: string, token: string): Promise<McpQqNumberBinding> {
    validateUser(userId); validateToken(token); return this.run(() => this.store.confirm(userId.toLowerCase(), digest(token), new Date(this.now())));
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
