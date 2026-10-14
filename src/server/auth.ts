import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { decodeJwt, decodeProtectedHeader, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { Config } from './config.js';
import { ApplicationReviewError, PgAuthStore, UsernameTakenError, type ApplicationStatus,
  type AuthStore, type PublicUser, type RegistrationApplication, type StoredUser } from './database.js';
import { ApiError } from './errors.js';
import { logBackend } from './logging.js';

export type User = PublicUser;
export interface AuthSession { user: User; token: string; expiresAt: Date }
export interface AuthOptions { store?: AuthStore; now?: () => number }

const JWT_TTL_SECONDS = 7 * 24 * 60 * 60;
const JWT_ISSUER = 'naruto-login-client';
const JWT_AUDIENCE = 'naruto-login-client';
const unavailable = () => new ApiError(503, '账号服务暂时不可用，请稍后重试。', 'AUTH_UNAVAILABLE');
const publicUser = (user: User): User => ({ id: user.id, username: user.username, isAdmin: user.isAdmin === true });
const requireAdmin = (admin: User) => {
  if (admin.isAdmin !== true) throw new ApiError(403, '需要管理员权限。', 'ADMIN_REQUIRED');
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validClaims(payload: JWTPayload, now: number): boolean {
  return typeof payload.sub === 'string' && uuid.test(payload.sub)
    && typeof payload.jti === 'string' && uuid.test(payload.jti)
    && typeof payload.iat === 'number' && Number.isSafeInteger(payload.iat) && payload.iat >= 0 && payload.iat <= now
    && typeof payload.exp === 'number' && Number.isSafeInteger(payload.exp) && payload.exp > now
    && payload.exp > payload.iat && payload.exp - payload.iat <= JWT_TTL_SECONDS;
}

export function credentials(body: unknown): { username: string; usernameKey: string; password: string } {
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

  constructor(private readonly config: Pick<Config, 'databaseUrl' | 'timeoutMs' | 'jwtSecret'>, options: AuthOptions = {}) {
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
      const started = performance.now();
      const pending = Promise.resolve().then(() => store.initialize()).catch(error => {
        if (this.initialization === pending) this.initialization = undefined;
        logBackend('error', 'auth.database_failed', { component: 'auth', phase: 'initialize',
          operation: 'initialize', durationMs: Math.round(performance.now() - started), error });
        throw unavailable();
      });
      this.initialization = pending;
    }
    await this.initialization;
  }

  private async request<T>(operation: string, run: (store: AuthStore) => Promise<T>): Promise<T> {
    await this.initialize();
    const started = performance.now();
    try { return await run(this.database()); }
    catch (error) {
      logBackend('error', 'auth.database_failed', { component: 'auth', phase: 'query', operation,
        durationMs: Math.round(performance.now() - started), error });
      throw unavailable();
    }
  }

  private jwtKey(): Uint8Array {
    const key = new TextEncoder().encode(this.config.jwtSecret ?? '');
    if (key.byteLength < 32) throw new ApiError(503, '登录签名密钥未配置，请先配置 JWT_SECRET。', 'JWT_NOT_CONFIGURED');
    return key;
  }

  private async newSession(user: User): Promise<AuthSession> {
    const key = this.jwtKey();
    const issuedAt = Math.floor(this.now() / 1000);
    const expires = issuedAt + JWT_TTL_SECONDS;
    const started = performance.now();
    try {
      const token = await new SignJWT().setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id).setIssuer(JWT_ISSUER).setAudience(JWT_AUDIENCE)
        .setIssuedAt(issuedAt).setExpirationTime(expires).setJti(randomUUID()).sign(key);
      return { user: publicUser(user), token, expiresAt: new Date(expires * 1000) };
    } catch (error) {
      logBackend('error', 'auth.operation_failed', { component: 'auth', phase: 'jwt', operation: 'create_session',
        durationMs: Math.round(performance.now() - started), error });
      throw unavailable();
    }
  }

  async register(body: unknown): Promise<{ application: RegistrationApplication; message: string }> {
    const input = credentials(body);
    await this.initialize();
    const started = performance.now();
    try {
      const user: StoredUser = { id: randomUUID(), username: input.username, usernameKey: input.usernameKey,
        password: input.password, isInvalid: true, isAdmin: false };
      const application = await this.database().createRegistration(user, randomUUID(), new Date(this.now()));
      return { application, message: '注册申请已提交，请等待管理员审核。' };
    } catch (error) {
      if (error instanceof UsernameTakenError) throw new ApiError(409, '该用户名已被注册。', 'USERNAME_TAKEN');
      logBackend('error', 'auth.database_failed', { component: 'auth', phase: 'query', operation: 'create_registration',
        durationMs: Math.round(performance.now() - started), error });
      throw unavailable();
    }
  }

  async login(body: unknown): Promise<AuthSession> {
    const input = credentials(body);
    const user = await this.request('find_user', store => store.findUser(input.usernameKey));
    const started = performance.now();
    let valid: boolean;
    try { valid = verifyPassword(input.password, user?.password ?? ''); }
    catch (error) {
      logBackend('error', 'auth.operation_failed', { component: 'auth', phase: 'password', operation: 'verify_password',
        durationMs: Math.round(performance.now() - started), error });
      throw unavailable();
    }
    if (!user || !valid) throw new ApiError(401, '用户名或密码错误。', 'INVALID_CREDENTIALS');
    if (user.isInvalid) {
      if (user.applicationStatus === 'pending') throw new ApiError(403, '注册申请正在审核中，请等待管理员批准。', 'REGISTRATION_PENDING');
      if (user.applicationStatus === 'rejected') throw new ApiError(403, '注册申请未通过审核，请联系管理员。', 'REGISTRATION_REJECTED');
      throw new ApiError(403, '账号已被停用，请联系管理员。', 'ACCOUNT_DISABLED');
    }
    return await this.newSession(user);
  }

  async getUser(token: string | undefined): Promise<User | null> {
    if (!token || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const now = Math.floor(this.now() / 1000);
    // Reject malformed input without requiring a configured key or a database.
    // Decoding is only a format check; identity is trusted after jwtVerify below.
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== 'HS256' || header.typ !== 'JWT' || !validClaims(decodeJwt(token), now)) return null;
    } catch { return null; }
    const key = this.jwtKey();
    let subject: string;
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE, typ: 'JWT',
        requiredClaims: ['sub', 'iat', 'exp', 'jti'], maxTokenAge: JWT_TTL_SECONDS,
        currentDate: new Date(this.now()),
      });
      if (!validClaims(payload, now)) return null;
      subject = payload.sub!;
    } catch { return null; }
    const user = await this.request('find_active_user', store => store.findActiveUser(subject));
    return user ? publicUser(user) : null;
  }

  async listApplications(admin: User, status: unknown): Promise<{ applications: RegistrationApplication[] }> {
    requireAdmin(admin);
    const selected = status === undefined ? 'pending' : status;
    if (typeof selected !== 'string' || !['pending', 'approved', 'rejected', 'all'].includes(selected)) {
      throw new ApiError(400, '无效的注册申请状态。', 'INVALID_APPLICATION_STATUS');
    }
    const applications = await this.request('list_applications', store => store.listRegistrationApplications(selected as ApplicationStatus | 'all', 100));
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
    const started = performance.now();
    try {
      const application = await this.database().reviewRegistration(id, admin.id, input.decision, reason, new Date(this.now()));
      return { application };
    } catch (error) {
      if (error instanceof ApplicationReviewError) {
        if (error.code === 'ADMIN_REQUIRED') throw new ApiError(403, '需要管理员权限。', 'ADMIN_REQUIRED');
        if (error.code === 'NOT_FOUND') throw new ApiError(404, '注册申请不存在。', 'APPLICATION_NOT_FOUND');
        if (error.code === 'ALREADY_REVIEWED') throw new ApiError(409, '该注册申请已完成审核。', 'APPLICATION_ALREADY_REVIEWED');
      }
      logBackend('error', 'auth.database_failed', { component: 'auth', phase: 'query', operation: 'review_registration',
        durationMs: Math.round(performance.now() - started), error });
      throw unavailable();
    }
  }

  async close(): Promise<void> {
    const started = performance.now();
    try { await this.store?.close(); }
    catch (error) {
      logBackend('error', 'auth.database_failed', { component: 'auth', phase: 'close', operation: 'close',
        durationMs: Math.round(performance.now() - started), error });
      throw unavailable();
    }
    finally { this.store = undefined; this.initialization = undefined; }
  }
}
