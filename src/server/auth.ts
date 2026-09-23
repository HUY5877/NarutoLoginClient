import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { ApplicationReviewError, PgAuthStore, UsernameTakenError, type ApplicationStatus,
  type AuthStore, type PublicUser, type RegistrationApplication, type StoredSession, type StoredUser } from './database.js';
import { ApiError } from './errors.js';

export type User = PublicUser;
export interface AuthSession { user: User; token: string; expiresAt: Date }
export interface AuthOptions { store?: AuthStore; now?: () => number }

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const unavailable = () => new ApiError(503, '账号服务暂时不可用，请稍后重试。', 'AUTH_UNAVAILABLE');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const publicUser = (user: User): User => ({ id: user.id, username: user.username, isAdmin: user.isAdmin === true });
const requireAdmin = (admin: User) => {
  if (admin.isAdmin !== true) throw new ApiError(403, '需要管理员权限。', 'ADMIN_REQUIRED');
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function credentials(body: unknown): { username: string; usernameKey: string; password: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, '请填写用户名和密码。', 'INVALID_CREDENTIALS');
  const { username: value, password } = body as Record<string, unknown>;
  const username = typeof value === 'string' ? value.trim() : '';
  if (!/^[\p{Script=Han}A-Za-z0-9_-]{3,24}$/u.test(username)) {
    throw new ApiError(400, '用户名须为 3–24 个汉字、字母、数字、下划线或短横线。', 'INVALID_USERNAME');
  }
  if (typeof password !== 'string' || [...password].length < 6 || [...password].length > 128) {
    throw new ApiError(400, '密码须为 6–128 个字符。', 'INVALID_PASSWORD');
  }
  return { username, usernameKey: username.replace(/[A-Z]/g, char => char.toLowerCase()), password };
}

function verifyPassword(password: string, stored: string): boolean {
  const actual = Buffer.from(password);
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class AuthService {
  private store?: AuthStore;
  private initialization?: Promise<void>;
  private readonly now: () => number;

  constructor(private readonly config: Pick<Config, 'databaseUrl' | 'timeoutMs'>, options: AuthOptions = {}) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  private database(): AuthStore {
    if (!this.config.databaseUrl) {
      throw new ApiError(503, '账号数据库未配置，请先配置 DATABASE_URL。', 'DATABASE_NOT_CONFIGURED');
    }
    return this.store ??= new PgAuthStore(this.config.databaseUrl, this.config.timeoutMs);
  }

  async initialize(): Promise<void> {
    const store = this.database();
    if (!this.initialization) {
      const pending = Promise.resolve().then(() => store.initialize()).catch(() => {
        if (this.initialization === pending) this.initialization = undefined;
        throw unavailable();
      });
      this.initialization = pending;
    }
    await this.initialization;
  }

  private async request<T>(run: (store: AuthStore) => Promise<T>): Promise<T> {
    await this.initialize();
    try { return await run(this.database()); }
    catch { throw unavailable(); }
  }

  private newSession(user: User): { result: AuthSession; stored: StoredSession } {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(this.now() + SESSION_TTL_MS);
    return { result: { user: publicUser(user), token, expiresAt }, stored: { tokenHash: tokenHash(token), userId: user.id, expiresAt } };
  }

  async register(body: unknown): Promise<{ application: RegistrationApplication; message: string }> {
    const input = credentials(body);
    await this.initialize();
    try {
      const user: StoredUser = { id: randomUUID(), username: input.username, usernameKey: input.usernameKey,
        password: input.password, isInvalid: true, isAdmin: false };
      const application = await this.database().createRegistration(user, randomUUID(), new Date(this.now()));
      return { application, message: '注册申请已提交，请等待管理员审核。' };
    } catch (error) {
      if (error instanceof UsernameTakenError) throw new ApiError(409, '该用户名已被注册。', 'USERNAME_TAKEN');
      throw unavailable();
    }
  }

  async login(body: unknown): Promise<AuthSession> {
    const input = credentials(body);
    const user = await this.request(store => store.findUser(input.usernameKey));
    let valid: boolean;
    try { valid = verifyPassword(input.password, user?.password ?? ''); }
    catch { throw unavailable(); }
    if (!user || !valid) throw new ApiError(401, '用户名或密码错误。', 'INVALID_CREDENTIALS');
    if (user.isInvalid) {
      if (user.applicationStatus === 'pending') throw new ApiError(403, '注册申请正在审核中，请等待管理员批准。', 'REGISTRATION_PENDING');
      if (user.applicationStatus === 'rejected') throw new ApiError(403, '注册申请未通过审核，请联系管理员。', 'REGISTRATION_REJECTED');
      throw new ApiError(403, '账号已被停用，请联系管理员。', 'ACCOUNT_DISABLED');
    }
    const session = this.newSession(user);
    await this.request(store => store.createSession(session.stored));
    return session.result;
  }

  async getUser(token: string | undefined): Promise<User | null> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const user = await this.request(store => store.findSessionUser(tokenHash(token), new Date(this.now())));
    return user ? publicUser(user) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
    await this.request(store => store.deleteSession(tokenHash(token)));
  }

  async listApplications(admin: User, status: unknown): Promise<{ applications: RegistrationApplication[] }> {
    requireAdmin(admin);
    const selected = status === undefined ? 'pending' : status;
    if (typeof selected !== 'string' || !['pending', 'approved', 'rejected', 'all'].includes(selected)) {
      throw new ApiError(400, '无效的注册申请状态。', 'INVALID_APPLICATION_STATUS');
    }
    const applications = await this.request(store => store.listRegistrationApplications(selected as ApplicationStatus | 'all', 100));
    return { applications };
  }

  async reviewApplication(admin: User, id: string, body: unknown): Promise<{ application: RegistrationApplication }> {
    requireAdmin(admin);
    if (!uuid.test(id)) throw new ApiError(400, '无效的注册申请编号。', 'INVALID_APPLICATION_ID');
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (input.decision !== 'approved' && input.decision !== 'rejected') {
      throw new ApiError(400, '请选择批准或拒绝。', 'INVALID_REVIEW_DECISION');
    }
    if (input.reason !== undefined && input.reason !== null
      && (typeof input.reason !== 'string' || [...input.reason].length > 200)) {
      throw new ApiError(400, '审核备注须为不超过 200 个字符的文字。', 'INVALID_REVIEW_REASON');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() || null : null;
    await this.initialize();
    try {
      const application = await this.database().reviewRegistration(id, admin.id, input.decision, reason, new Date(this.now()));
      return { application };
    } catch (error) {
      if (error instanceof ApplicationReviewError) {
        if (error.code === 'ADMIN_REQUIRED') throw new ApiError(403, '需要管理员权限。', 'ADMIN_REQUIRED');
        if (error.code === 'NOT_FOUND') throw new ApiError(404, '注册申请不存在。', 'APPLICATION_NOT_FOUND');
        if (error.code === 'ALREADY_REVIEWED') throw new ApiError(409, '该注册申请已完成审核。', 'APPLICATION_ALREADY_REVIEWED');
      }
      throw unavailable();
    }
  }

  async close(): Promise<void> {
    try { await this.store?.close(); }
    catch { throw unavailable(); }
    finally { this.store = undefined; this.initialization = undefined; }
  }
}
