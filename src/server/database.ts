import { Pool, type PoolClient } from 'pg';
import { parseUserOptions } from '../shared/user-options.js';
import { DEFAULT_LOGIN_TYPE, parseLoginType, type LoginType } from '../shared/login-types.js';
import type { Status, Submission } from './queue.js';
import type { ManagedUser, MonthlySort, MonthlyUserStats } from '../shared/admin.js';

export interface PublicUser { id: string; username: string; isAdmin: boolean }
export type ApplicationStatus = 'pending' | 'approved' | 'rejected';
export interface RegistrationApplication {
  id: string;
  userId: string;
  username: string;
  status: ApplicationStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reason: string | null;
}

export interface StoredUser {
  id: string;
  username: string;
  usernameKey: string;
  password: string;
  isInvalid: boolean;
  isAdmin: boolean;
}

export interface AuthStore {
  initialize(): Promise<void>;
  createRegistration(user: StoredUser, applicationId: string, now: Date): Promise<RegistrationApplication>;
  findUser(usernameKey: string): Promise<(StoredUser & { applicationStatus?: ApplicationStatus | null }) | null>;
  findActiveUser(userId: string): Promise<PublicUser | null>;
  listRegistrationApplications(status: ApplicationStatus | 'all', limit: number): Promise<RegistrationApplication[]>;
  reviewRegistration(applicationId: string, adminId: string, decision: 'approved' | 'rejected', reason: string | null, now: Date): Promise<RegistrationApplication>;
  close(): Promise<void>;
}

export interface UserChanges { username: string; usernameKey: string; password?: string; isInvalid: boolean; isAdmin: boolean }
export interface DailyEvent {
  id: string; username: string; createdAt: string; expiresAt: string; status: Status;
  loginType?: LoginType;
}
export interface AdminStore {
  initialize(): Promise<void>;
  listUsers(search: string, offset: number, limit: number): Promise<{ items: ManagedUser[]; total: number }>;
  getManagedUser(id: string): Promise<ManagedUser | null>;
  createUser(adminId: string, user: StoredUser, now: Date): Promise<ManagedUser>;
  updateUser(adminId: string, id: string, changes: UserChanges, now: Date): Promise<ManagedUser>;
  deleteUser(adminId: string, id: string): Promise<void>;
  listDailyEvents(start: Date, end: Date, offset: number, limit: number): Promise<{ items: DailyEvent[]; total: number }>;
  listMonthlyStats(start: Date, end: Date, sort: MonthlySort, offset: number, limit: number): Promise<{ items: MonthlyUserStats[]; total: number; totalRequests: number }>;
}
export class UserManagementError extends Error {
  constructor(public code: 'NOT_FOUND' | 'ADMIN_REQUIRED' | 'SELF_PROTECTED') { super('User management failed'); }
}
type ManagedUserRow = Omit<ManagedUser, 'createdAt'> & { createdAt: Timestamp };
const managedUserColumns = `u.id, u.username, u.is_admin AS "isAdmin", u.is_invalid AS "isInvalid", u.created_at AS "createdAt",
  (SELECT a.status FROM naruto_login.registration_applications a WHERE a.user_id = u.id
   ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS "applicationStatus"`;
const managedUser = (row: ManagedUserRow): ManagedUser => ({
  id: row.id, username: row.username, isAdmin: row.isAdmin, isInvalid: row.isInvalid,
  createdAt: new Date(row.createdAt).toISOString(), applicationStatus: row.applicationStatus,
});

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
  getLatestForUser(userId: string): Promise<LoginEvent | null>;
  markDispatched(id: string, userId: string, now: Date): Promise<void>;
  updateStatus(id: string, userId: string, status: Status, now: Date, expiresAt?: string): Promise<void>;
}

type Timestamp = Date | string;
type ApplicationRow = Omit<RegistrationApplication, 'createdAt' | 'reviewedAt'> & {
  createdAt: Timestamp;
  reviewedAt: Timestamp | null;
};
const applicationColumns = `a.id, a.user_id AS "userId", u.username, a.status,
  a.created_at AS "createdAt", a.reviewed_at AS "reviewedAt", a.reviewed_by AS "reviewedBy", a.reason`;

function registrationApplication(row: ApplicationRow): RegistrationApplication {
  return {
    id: row.id, userId: row.userId, username: row.username, status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    reviewedAt: row.reviewedAt === null ? null : new Date(row.reviewedAt).toISOString(),
    reviewedBy: row.reviewedBy, reason: row.reason,
  };
}

type LoginEventRow = Omit<LoginEvent, 'createdAt' | 'expiresAt' | 'dispatchedAt' | 'finishedAt' | 'userOptions'> & {
  createdAt: Timestamp;
  expiresAt: Timestamp;
  dispatchedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  userOptions: unknown;
};

const eventColumns = `id, user_id AS "userId", request_id AS "requestId", status,
  access_token AS "accessToken", created_at AS "createdAt", expires_at AS "expiresAt",
  dispatched_at AS "dispatchedAt", finished_at AS "finishedAt", user_options AS "userOptions", login_type AS "loginType"`;
const expireEvents = `UPDATE naruto_login.login_events SET status = 'expired', finished_at = $2
  WHERE user_id = $1 AND finished_at IS NULL AND expires_at <= $2`;

function loginEvent(row: LoginEventRow): LoginEvent {
  const loginType = parseLoginType(row.loginType);
  if (!loginType) throw new Error('Stored login event login type is invalid');
  const userOptions = parseUserOptions(row.userOptions);
  if (!userOptions) throw new Error('Stored login event user options are invalid');
  const iso = (value: Timestamp) => new Date(value).toISOString();
  return {
    id: row.id, userId: row.userId, requestId: row.requestId, status: row.status,
    accessToken: row.accessToken, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt),
    dispatchedAt: row.dispatchedAt === null ? null : iso(row.dispatchedAt),
    finishedAt: row.finishedAt === null ? null : iso(row.finishedAt),
    userOptions, loginType,
  };
}

export class UsernameTakenError extends Error {
  constructor() { super('Username already exists'); }
}

export class ApplicationReviewError extends Error {
  constructor(public code: 'NOT_FOUND' | 'ALREADY_REVIEWED' | 'ADMIN_REQUIRED') {
    super('Registration application review could not be completed');
  }
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
ALTER TABLE naruto_login.users ADD COLUMN IF NOT EXISTS is_invalid boolean NOT NULL DEFAULT false;
ALTER TABLE naruto_login.users ALTER COLUMN is_invalid SET DEFAULT true;
ALTER TABLE naruto_login.users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS naruto_login.registration_applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES naruto_login.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES naruto_login.users(id) ON DELETE SET NULL,
  reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS naruto_login_registration_applications_pending_user_idx
  ON naruto_login.registration_applications (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS naruto_login_registration_applications_status_created_idx
  ON naruto_login.registration_applications (status, created_at DESC);
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
  user_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT naruto_login_login_events_user_request_key UNIQUE (user_id, request_id)
);
ALTER TABLE naruto_login.login_events ADD COLUMN IF NOT EXISTS user_options jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE naruto_login.login_events ADD COLUMN IF NOT EXISTS login_type text NOT NULL DEFAULT 'android_qq'
  CHECK (login_type IN ('android_qq', 'ios_qq', 'android_wechat', 'ios_wechat'));
CREATE UNIQUE INDEX IF NOT EXISTS naruto_login_login_events_active_user_idx
  ON naruto_login.login_events (user_id) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS naruto_login_login_events_user_expires_idx ON naruto_login.login_events (user_id, expires_at);
CREATE INDEX IF NOT EXISTS naruto_login_login_events_user_created_idx ON naruto_login.login_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS naruto_login_login_events_created_idx ON naruto_login.login_events (created_at DESC, id DESC);
`;

// Each application service owns one pool, reused across requests and warm serverless invocations.
export class PgAuthStore implements AuthStore, LoginEventStore, AdminStore {
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
      }).catch(error => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  async createRegistration(user: StoredUser, applicationId: string, now: Date): Promise<RegistrationApplication> {
    await this.initialize();
    try {
      return await this.transaction(async client => {
        await client.query(
          `INSERT INTO naruto_login.users (id, username, username_key, password, is_invalid, is_admin, created_at)
           VALUES ($1, $2, $3, $4, true, false, $5)`,
          [user.id, user.username, user.usernameKey, user.password, now],
        );
        await client.query(
          `INSERT INTO naruto_login.registration_applications (id, user_id, status, created_at)
           VALUES ($1, $2, 'pending', $3)`,
          [applicationId, user.id, now],
        );
        const result = await client.query<ApplicationRow>(
          `SELECT ${applicationColumns} FROM naruto_login.registration_applications a
           JOIN naruto_login.users u ON u.id = a.user_id WHERE a.id = $1`, [applicationId],
        );
        return registrationApplication(result.rows[0]);
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505'
        && 'constraint' in error && error.constraint === 'naruto_login_users_username_key_key') {
        throw new UsernameTakenError();
      }
      throw error;
    }
  }

  async findUser(usernameKey: string): Promise<(StoredUser & { applicationStatus?: ApplicationStatus | null }) | null> {
    const result = await this.pool.query<StoredUser & { applicationStatus: ApplicationStatus | null }>(
      `SELECT u.id, u.username, u.username_key AS "usernameKey", u.password,
         u.is_invalid AS "isInvalid", u.is_admin AS "isAdmin",
         (SELECT a.status FROM naruto_login.registration_applications a WHERE a.user_id = u.id
          ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS "applicationStatus"
       FROM naruto_login.users u WHERE u.username_key = $1`,
      [usernameKey],
    );
    return result.rows[0] ?? null;
  }

  async findActiveUser(userId: string): Promise<PublicUser | null> {
    const result = await this.pool.query<PublicUser>(
      'SELECT id, username, is_admin AS "isAdmin" FROM naruto_login.users WHERE id = $1 AND is_invalid = false',
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async listUsers(search: string, offset: number, limit: number) {
    await this.initialize();
    return this.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      // Literal substring search: underscores in valid usernames must not become wildcards.
      const where = `strpos(lower(u.username), lower($1)) > 0`;
      const count = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM naruto_login.users u WHERE ${where}`, [search]);
      const result = await client.query<ManagedUserRow>(`SELECT ${managedUserColumns} FROM naruto_login.users u
        WHERE ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT $2 OFFSET $3`, [search, limit, offset]);
      return { items: result.rows.map(managedUser), total: count.rows[0].total };
    });
  }

  async getManagedUser(id: string): Promise<ManagedUser | null> {
    await this.initialize();
    const result = await this.pool.query<ManagedUserRow>(`SELECT ${managedUserColumns} FROM naruto_login.users u WHERE u.id = $1`, [id]);
    return result.rows[0] ? managedUser(result.rows[0]) : null;
  }

  private async manageUser<T>(adminId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.initialize();
    try {
      return await this.transaction(async client => {
        // Serialize administrator mutations, including cross-admin edits, to avoid lock-order races.
        await client.query('SELECT pg_advisory_xact_lock(19830527, 1179018069)');
        const actor = await client.query('SELECT id FROM naruto_login.users WHERE id = $1 AND is_admin = true AND is_invalid = false FOR SHARE', [adminId]);
        if (!actor.rows.length) throw new UserManagementError('ADMIN_REQUIRED');
        return run(client);
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505'
        && 'constraint' in error && error.constraint === 'naruto_login_users_username_key_key') throw new UsernameTakenError();
      throw error;
    }
  }

  async createUser(adminId: string, user: StoredUser, now: Date): Promise<ManagedUser> {
    return this.manageUser(adminId, async client => {
      await client.query(`INSERT INTO naruto_login.users (id, username, username_key, password, is_invalid, is_admin, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [user.id, user.username, user.usernameKey, user.password, user.isInvalid, user.isAdmin, now]);
      return { id: user.id, username: user.username, isInvalid: user.isInvalid, isAdmin: user.isAdmin,
        createdAt: now.toISOString(), applicationStatus: null };
    });
  }

  async updateUser(adminId: string, id: string, changes: UserChanges, now: Date): Promise<ManagedUser> {
    return this.manageUser(adminId, async client => {
      if (id === adminId && (changes.isInvalid || !changes.isAdmin)) throw new UserManagementError('SELF_PROTECTED');
      // Match registration review's lock order: application first, then its account.
      await client.query(`SELECT id FROM naruto_login.registration_applications
        WHERE user_id = $1 AND status = 'pending' ORDER BY id FOR UPDATE`, [id]);
      const result = await client.query<ManagedUserRow>(`UPDATE naruto_login.users u
        SET username = $2, username_key = $3, password = COALESCE($4, password), is_invalid = $5, is_admin = $6
        WHERE u.id = $1 RETURNING ${managedUserColumns}`, [id, changes.username, changes.usernameKey, changes.password ?? null, changes.isInvalid, changes.isAdmin]);
      if (!result.rows[0]) throw new UserManagementError('NOT_FOUND');
      // Explicit activation resolves any pending application so a later review cannot undo this edit.
      if (!changes.isInvalid) await client.query(`UPDATE naruto_login.registration_applications
        SET status = 'approved', reviewed_at = $2, reviewed_by = $3, reason = '管理员在用户管理中启用账号'
        WHERE user_id = $1 AND status = 'pending'`, [id, now, adminId]);
      return managedUser({ ...result.rows[0], applicationStatus: !changes.isInvalid && result.rows[0].applicationStatus === 'pending'
        ? 'approved' : result.rows[0].applicationStatus });
    });
  }

  async deleteUser(adminId: string, id: string): Promise<void> {
    return this.manageUser(adminId, async client => {
      if (id === adminId) throw new UserManagementError('SELF_PROTECTED');
      await client.query('SELECT id FROM naruto_login.registration_applications WHERE user_id = $1 ORDER BY id FOR UPDATE', [id]);
      const result = await client.query('DELETE FROM naruto_login.users WHERE id = $1 RETURNING id', [id]);
      if (!result.rows.length) throw new UserManagementError('NOT_FOUND');
    });
  }

  async listDailyEvents(start: Date, end: Date, offset: number, limit: number) {
    await this.initialize();
    return this.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const count = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM naruto_login.login_events
        WHERE created_at >= $1 AND created_at < $2`, [start, end]);
      const result = await client.query<Omit<DailyEvent, 'createdAt' | 'expiresAt'> & { createdAt: Timestamp; expiresAt: Timestamp }>(
        `SELECT e.id, u.username, e.created_at AS "createdAt", e.expires_at AS "expiresAt", e.status, e.login_type AS "loginType"
         FROM naruto_login.login_events e JOIN naruto_login.users u ON u.id = e.user_id
         WHERE e.created_at >= $1 AND e.created_at < $2 ORDER BY e.created_at DESC, e.id DESC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
      return { items: result.rows.map(row => ({ id: row.id, username: row.username, status: row.status, loginType: row.loginType ?? DEFAULT_LOGIN_TYPE,
        createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString() })), total: count.rows[0].total };
    });
  }

  async listRegistrationApplications(status: ApplicationStatus | 'all', limit: number): Promise<RegistrationApplication[]> {
    await this.initialize();
    const result = await this.pool.query<ApplicationRow>(
      `SELECT ${applicationColumns} FROM naruto_login.registration_applications a
       JOIN naruto_login.users u ON u.id = a.user_id
       WHERE ($1 = 'all' OR a.status = $1) ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
      [status, limit],
    );
    return result.rows.map(registrationApplication);
  }

  async listMonthlyStats(start: Date, end: Date, sort: MonthlySort, offset: number, limit: number) {
    await this.initialize();
    // One durable event is one request; retries/QR refreshes reuse its ID.
    // Aggregate all statuses, independently of Redis execution-log retention.
    const primary = sort === 'days' ? 'request_days' : 'request_count';
    const secondary = sort === 'days' ? 'request_count' : 'request_days';
    return this.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const count = await client.query<{ total: number; totalRequests: number }>(
        `SELECT count(DISTINCT user_id)::int AS total, count(*)::int AS "totalRequests"
         FROM naruto_login.login_events WHERE created_at >= $1 AND created_at < $2`, [start, end]);
      const result = await client.query<MonthlyUserStats>(
        `WITH stats AS (
           SELECT user_id, count(*)::int AS request_count,
             count(DISTINCT (created_at AT TIME ZONE 'Asia/Shanghai')::date)::int AS request_days
           FROM naruto_login.login_events WHERE created_at >= $1 AND created_at < $2 GROUP BY user_id
         )
         SELECT s.user_id AS "userId", u.username, s.request_count AS "requestCount", s.request_days AS "requestDays",
           dense_rank() OVER (ORDER BY ${primary} DESC)::int AS rank
         FROM stats s JOIN naruto_login.users u ON u.id = s.user_id
         ORDER BY ${primary} DESC, ${secondary} DESC, s.user_id ASC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
      return { items: result.rows.map(row => ({ userId: row.userId, username: row.username, rank: row.rank,
        requestCount: row.requestCount, requestDays: row.requestDays })), ...count.rows[0] };
    });
  }

  async reviewRegistration(applicationId: string, adminId: string, decision: 'approved' | 'rejected', reason: string | null, now: Date): Promise<RegistrationApplication> {
    await this.initialize();
    return await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(19830527, 1179018069)');
      // Hold the actor's privileges stable until the decision commits.
      const actor = await client.query(
        'SELECT id FROM naruto_login.users WHERE id = $1 AND is_admin = true AND is_invalid = false FOR SHARE', [adminId],
      );
      if (!actor.rows.length) throw new ApplicationReviewError('ADMIN_REQUIRED');
      const selected = await client.query<ApplicationRow>(
        `SELECT ${applicationColumns} FROM naruto_login.registration_applications a
         JOIN naruto_login.users u ON u.id = a.user_id WHERE a.id = $1 FOR UPDATE OF a`, [applicationId],
      );
      const application = selected.rows[0];
      if (!application) throw new ApplicationReviewError('NOT_FOUND');
      if (application.status !== 'pending') throw new ApplicationReviewError('ALREADY_REVIEWED');
      await client.query('UPDATE naruto_login.users SET is_invalid = $2 WHERE id = $1', [application.userId, decision === 'rejected']);
      await client.query(
        `UPDATE naruto_login.registration_applications SET status = $2, reviewed_at = $3, reviewed_by = $4, reason = $5
         WHERE id = $1 AND status = 'pending'`, [applicationId, decision, now, adminId, reason],
      );
      return registrationApplication({ ...application, status: decision, reviewedAt: now, reviewedBy: adminId, reason });
    });
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
          (id, user_id, request_id, status, access_token, created_at, expires_at, dispatched_at, finished_at, user_options, login_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING ${eventColumns}`,
        [candidate.id, candidate.userId, candidate.requestId, candidate.status, candidate.accessToken,
          new Date(candidate.createdAt), new Date(candidate.expiresAt),
          candidate.dispatchedAt === null ? null : new Date(candidate.dispatchedAt),
          candidate.finishedAt === null ? null : new Date(candidate.finishedAt), JSON.stringify(candidate.userOptions),
          candidate.loginType ?? DEFAULT_LOGIN_TYPE],
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

  async getLatestForUser(userId: string): Promise<LoginEvent | null> {
    await this.initialize();
    const result = await this.pool.query<LoginEventRow>(
      `SELECT ${eventColumns} FROM naruto_login.login_events WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? loginEvent(result.rows[0]) : null;
  }

  async updateStatus(id: string, userId: string, status: Status, now: Date, expiresAt?: string): Promise<void> {
    await this.initialize();
    // A verified worker lease can outlive the queue reservation. Preserve hard
    // failures and monotonic ready status; only time-expired reservations revive.
    await this.pool.query(`UPDATE naruto_login.login_events
      SET status = CASE WHEN GREATEST(expires_at, COALESCE($5::timestamptz, expires_at)) <= $4 THEN 'expired' ELSE $3 END,
          expires_at = GREATEST(expires_at, COALESCE($5::timestamptz, expires_at)),
          finished_at = CASE WHEN GREATEST(expires_at, COALESCE($5::timestamptz, expires_at)) <= $4 OR $3 IN ('failed', 'expired') THEN $4 ELSE NULL END
      WHERE id = $1 AND user_id = $2 AND (finished_at IS NULL OR (status = 'expired' AND $5::timestamptz > $4))
        AND (expires_at <= $4 OR status NOT IN ('qr_ready', 'failed', 'expired') OR $3 IN ('failed', 'expired') OR $5::timestamptz > expires_at)`,
    [id, userId, status, now, expiresAt ?? null]);
  }

  async close(): Promise<void> { await this.pool.end(); }
}
