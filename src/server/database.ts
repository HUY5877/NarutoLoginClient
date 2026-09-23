import { Pool, type PoolClient } from 'pg';
import type { Status, Submission } from './queue.js';

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

export interface LoginEvent extends Submission {
  requestId: string;
  status: Status;
  dispatchedAt: string | null;
  finishedAt: string | null;
}

export interface LoginEventStore {
  initialize(): Promise<void>;
  reserve(candidate: LoginEvent, now: Date): Promise<LoginEvent>;
  getActive(userId: string, now: Date): Promise<LoginEvent | null>;
  getEvent(id: string, userId: string): Promise<LoginEvent | null>;
  markDispatched(id: string, userId: string, now: Date): Promise<void>;
  updateStatus(id: string, userId: string, status: Status, now: Date): Promise<void>;
}

type Timestamp = Date | string;
type LoginEventRow = Omit<LoginEvent, 'createdAt' | 'expiresAt' | 'dispatchedAt' | 'finishedAt'> & {
  createdAt: Timestamp;
  expiresAt: Timestamp;
  dispatchedAt: Timestamp | null;
  finishedAt: Timestamp | null;
};

const eventColumns = `id, user_id AS "userId", request_id AS "requestId", status,
  access_token AS "accessToken", created_at AS "createdAt", expires_at AS "expiresAt",
  dispatched_at AS "dispatchedAt", finished_at AS "finishedAt"`;
const expireEvents = `UPDATE naruto_login.login_events SET status = 'expired', finished_at = $2
  WHERE user_id = $1 AND finished_at IS NULL AND expires_at <= $2`;

function loginEvent(row: LoginEventRow): LoginEvent {
  const iso = (value: Timestamp) => new Date(value).toISOString();
  return {
    id: row.id, userId: row.userId, requestId: row.requestId, status: row.status,
    accessToken: row.accessToken, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt),
    dispatchedAt: row.dispatchedAt === null ? null : iso(row.dispatchedAt),
    finishedAt: row.finishedAt === null ? null : iso(row.finishedAt),
  };
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
CREATE TABLE IF NOT EXISTS naruto_login.login_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'starting_emulator', 'opening_game', 'preparing_qr', 'qr_ready', 'failed', 'expired')),
  access_token text NOT NULL CHECK (access_token ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  dispatched_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT naruto_login_login_events_user_request_key UNIQUE (user_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS naruto_login_login_events_active_user_idx
  ON naruto_login.login_events (user_id) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS naruto_login_login_events_user_expires_idx ON naruto_login.login_events (user_id, expires_at);
`;

// Each application service owns one pool, reused across requests and warm serverless invocations.
export class PgAuthStore implements AuthStore, LoginEventStore {
  private readonly pool: Pool;
  private initialization?: Promise<void>;

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
    if (!this.initialization) {
      this.initialization = this.transaction(async client => {
        // Serialize schema setup across concurrent cold starts without touching existing data.
        await client.query('SELECT pg_advisory_xact_lock(19830527, 1179018068)');
        await client.query(schema);
        // Bound maintenance work during startup; the expiration index avoids a full-table scan.
        await client.query(`DELETE FROM naruto_login.sessions WHERE token_hash IN (
          SELECT token_hash FROM naruto_login.sessions WHERE expires_at <= now()
          ORDER BY expires_at LIMIT 1000
        )`);
      }).catch(error => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
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

  async reserve(candidate: LoginEvent, now: Date): Promise<LoginEvent> {
    await this.initialize();
    return await this.transaction(async client => {
      // The parent row exists before the first event, so this also serializes first submissions.
      const owner = await client.query('SELECT id FROM naruto_login.users WHERE id = $1 FOR UPDATE', [candidate.userId]);
      if (!owner.rows.length) throw new Error('Login event account does not exist');
      await client.query(expireEvents, [candidate.userId, now]);
      // A retried request retains its original event even after that event has expired.
      const repeated = await client.query<LoginEventRow>(
        `SELECT ${eventColumns} FROM naruto_login.login_events WHERE user_id = $1 AND request_id = $2`,
        [candidate.userId, candidate.requestId],
      );
      if (repeated.rows[0]) return loginEvent(repeated.rows[0]);
      const active = await client.query<LoginEventRow>(
        `SELECT ${eventColumns} FROM naruto_login.login_events WHERE user_id = $1 AND finished_at IS NULL AND expires_at > $2`,
        [candidate.userId, now],
      );
      if (active.rows[0]) return loginEvent(active.rows[0]);
      const inserted = await client.query<LoginEventRow>(
        `INSERT INTO naruto_login.login_events
          (id, user_id, request_id, status, access_token, created_at, expires_at, dispatched_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${eventColumns}`,
        [candidate.id, candidate.userId, candidate.requestId, candidate.status, candidate.accessToken,
          new Date(candidate.createdAt), new Date(candidate.expiresAt),
          candidate.dispatchedAt === null ? null : new Date(candidate.dispatchedAt),
          candidate.finishedAt === null ? null : new Date(candidate.finishedAt)],
      );
      return loginEvent(inserted.rows[0]);
    });
  }

  async getActive(userId: string, now: Date): Promise<LoginEvent | null> {
    await this.initialize();
    return await this.transaction(async client => {
      await client.query(expireEvents, [userId, now]);
      const result = await client.query<LoginEventRow>(
        `SELECT ${eventColumns} FROM naruto_login.login_events WHERE user_id = $1 AND finished_at IS NULL AND expires_at > $2`,
        [userId, now],
      );
      return result.rows[0] ? loginEvent(result.rows[0]) : null;
    });
  }

  async getEvent(id: string, userId: string): Promise<LoginEvent | null> {
    await this.initialize();
    const result = await this.pool.query<LoginEventRow>(
      `SELECT ${eventColumns} FROM naruto_login.login_events WHERE id = $1 AND user_id = $2`, [id, userId],
    );
    return result.rows[0] ? loginEvent(result.rows[0]) : null;
  }

  async markDispatched(id: string, userId: string, now: Date): Promise<void> {
    await this.initialize();
    await this.pool.query(`UPDATE naruto_login.login_events SET dispatched_at = COALESCE(dispatched_at, $3)
      WHERE id = $1 AND user_id = $2`, [id, userId, now]);
  }

  async updateStatus(id: string, userId: string, status: Status, now: Date): Promise<void> {
    await this.initialize();
    // Ready work can still fail; only failed/expired events are finished and cannot revive.
    await this.pool.query(`UPDATE naruto_login.login_events
      SET status = CASE WHEN expires_at <= $4 THEN 'expired' ELSE $3 END,
          finished_at = CASE WHEN expires_at <= $4 OR $3 IN ('failed', 'expired') THEN $4 ELSE NULL END
      WHERE id = $1 AND user_id = $2 AND finished_at IS NULL
        AND (expires_at <= $4 OR status NOT IN ('qr_ready', 'failed', 'expired') OR $3 IN ('failed', 'expired'))`,
    [id, userId, status, now]);
  }

  async close(): Promise<void> { await this.pool.end(); }
}
