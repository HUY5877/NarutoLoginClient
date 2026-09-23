import { Pool, type PoolClient } from 'pg';

export interface StoredUser {
  id: string;
  username: string;
  usernameKey: string;
  password: string;
}

export interface StoredSession {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
}

export interface AuthStore {
  initialize(): Promise<void>;
  createUserAndSession(user: StoredUser, session: StoredSession): Promise<void>;
  findUser(usernameKey: string): Promise<StoredUser | null>;
  createSession(session: StoredSession): Promise<void>;
  findSessionUser(tokenHash: string, now: Date): Promise<Pick<StoredUser, 'id' | 'username'> | null>;
  deleteSession(tokenHash: string): Promise<void>;
  close(): Promise<void>;
}

export class UsernameTakenError extends Error {
  constructor() { super('Username already exists'); }
}

const schema = `
CREATE SCHEMA IF NOT EXISTS naruto_login;
CREATE TABLE IF NOT EXISTS naruto_login.users (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  username_key text NOT NULL,
  password text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT naruto_login_users_username_key_key UNIQUE (username_key)
);
CREATE TABLE IF NOT EXISTS naruto_login.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS naruto_login_sessions_expires_at_idx ON naruto_login.sessions (expires_at);
CREATE INDEX IF NOT EXISTS naruto_login_sessions_user_id_idx ON naruto_login.sessions (user_id);
`;

// Each application service owns one pool, reused across requests and warm serverless invocations.
export class PgAuthStore implements AuthStore {
  private readonly pool: Pool;

  constructor(connectionString: string, timeoutMs = 5000) {
    this.pool = new Pool({
      connectionString,
      max: 3,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
      idle_in_transaction_session_timeout: timeoutMs,
      idleTimeoutMillis: 10000,
      allowExitOnIdle: true,
      application_name: 'naruto-login-client-auth',
    });
    // Request errors are sanitized by AuthService. Idle connection errors must not crash Node.
    this.pool.on('error', () => {});
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failed = false;
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failed = true;
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      // Discard a connection after a transaction error, including a timed out query.
      client.release(failed);
    }
  }

  async initialize(): Promise<void> {
    await this.transaction(async client => {
      // Serialize schema setup across concurrent cold starts without touching existing data.
      await client.query('SELECT pg_advisory_xact_lock(19830527, 1179018068)');
      await client.query(schema);
      // Bound maintenance work during startup; the expiration index avoids a full-table scan.
      await client.query(`DELETE FROM naruto_login.sessions WHERE token_hash IN (
        SELECT token_hash FROM naruto_login.sessions WHERE expires_at <= now()
        ORDER BY expires_at LIMIT 1000
      )`);
    });
  }

  async createUserAndSession(user: StoredUser, session: StoredSession): Promise<void> {
    try {
      await this.transaction(async client => {
        await client.query(
          'INSERT INTO naruto_login.users (id, username, username_key, password) VALUES ($1, $2, $3, $4)',
          [user.id, user.username, user.usernameKey, user.password],
        );
        await client.query(
          'INSERT INTO naruto_login.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
          [session.tokenHash, session.userId, session.expiresAt],
        );
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505'
        && 'constraint' in error && error.constraint === 'naruto_login_users_username_key_key') {
        throw new UsernameTakenError();
      }
      throw error;
    }
  }

  async findUser(usernameKey: string): Promise<StoredUser | null> {
    const result = await this.pool.query<StoredUser>(
      'SELECT id, username, username_key AS "usernameKey", password FROM naruto_login.users WHERE username_key = $1',
      [usernameKey],
    );
    return result.rows[0] ?? null;
  }

  async createSession(session: StoredSession): Promise<void> {
    await this.pool.query(
      'INSERT INTO naruto_login.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [session.tokenHash, session.userId, session.expiresAt],
    );
  }

  async findSessionUser(tokenHash: string, now: Date): Promise<Pick<StoredUser, 'id' | 'username'> | null> {
    const result = await this.pool.query<Pick<StoredUser, 'id' | 'username'>>(
      `SELECT u.id, u.username FROM naruto_login.sessions s
       JOIN naruto_login.users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [tokenHash, now],
    );
    return result.rows[0] ?? null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM naruto_login.sessions WHERE token_hash = $1', [tokenHash]);
  }

  async close(): Promise<void> { await this.pool.end(); }
}
