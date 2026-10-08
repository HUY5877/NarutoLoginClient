import { randomUUID } from 'node:crypto';
import { credentials, type User } from './auth.js';
import { UserManagementError, UsernameTakenError, type AdminStore, type UserChanges } from './database.js';
import { ApiError } from './errors.js';
import type { TaskRunService } from './task-runs.js';
import type { DailyTask, DailyTaskPage, ManagedUser, PageResult } from '../shared/admin.js';
import { taskFailureMessage } from '../shared/task-errors.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pageSize = 20;
function pageNumber(value: unknown) {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}$/.test(value)) throw new ApiError(400, '无效的页码。', 'INVALID_PAGE');
  return Number(value);
}
function requireAdmin(user: User) {
  if (!user.isAdmin) throw new ApiError(403, '需要管理员权限。', 'ADMIN_REQUIRED');
}
function userId(id: string) {
  if (!uuid.test(id)) throw new ApiError(400, '无效的用户编号。', 'INVALID_USER_ID');
}
function userInput(body: unknown, creating: boolean): UserChanges {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, '请填写用户信息。', 'INVALID_USER');
  const input = body as Record<string, unknown>;
  // A blank password when editing means keep the existing password.
  const keepPassword = !creating && (input.password === undefined || input.password === '');
  const parsed = credentials({ username: input.username, password: keepPassword ? 'placeholder' : input.password });
  if (typeof input.isAdmin !== 'boolean' || typeof input.isInvalid !== 'boolean') {
    throw new ApiError(400, '请选择用户角色和账号状态。', 'INVALID_USER');
  }
  return { username: parsed.username, usernameKey: parsed.usernameKey, isAdmin: input.isAdmin, isInvalid: input.isInvalid,
    ...(keepPassword ? {} : { password: parsed.password }) };
}

export class AdminService {
  private readonly now: () => number;
  constructor(private readonly options: {
    store?: AdminStore; runs: Pick<TaskRunService, 'getSummaries'>; now?: () => number;
  }) { this.now = options.now ?? Date.now; }

  private async database<T>(run: (store: AdminStore) => Promise<T>): Promise<T> {
    if (!this.options.store) throw new ApiError(503, '账号数据库未配置，请先配置 DATABASE_URL。', 'DATABASE_NOT_CONFIGURED');
    try { await this.options.store.initialize(); return await run(this.options.store); }
    catch (error) {
      if (error instanceof UsernameTakenError) throw new ApiError(409, '该用户名已被注册。', 'USERNAME_TAKEN');
      if (error instanceof UserManagementError) {
        if (error.code === 'ADMIN_REQUIRED') throw new ApiError(403, '需要管理员权限。', 'ADMIN_REQUIRED');
        if (error.code === 'NOT_FOUND') throw new ApiError(404, '用户不存在，请刷新列表。', 'USER_NOT_FOUND');
        if (error.code === 'SELF_PROTECTED') throw new ApiError(409, '不能删除、停用或撤销当前账号的管理员权限。', 'USER_SELF_PROTECTED');
      }
      throw new ApiError(503, '管理数据暂时不可用，请稍后重试。', 'ADMIN_UNAVAILABLE');
    }
  }
  async listUsers(admin: User, query: { search?: unknown; page?: unknown }): Promise<PageResult<ManagedUser>> {
    requireAdmin(admin);
    if (query.search !== undefined && (typeof query.search !== 'string' || [...query.search].length > 24)) {
      throw new ApiError(400, '搜索内容最多为 24 个字符。', 'INVALID_SEARCH');
    }
    const page = pageNumber(query.page);
    return { ...await this.database(store => store.listUsers(typeof query.search === 'string' ? query.search.trim() : '', (page - 1) * pageSize, pageSize)), page, pageSize };
  }
  async getUser(admin: User, id: string) {
    requireAdmin(admin); userId(id);
    const user = await this.database(store => store.getManagedUser(id));
    if (!user) throw new ApiError(404, '用户不存在，请刷新列表。', 'USER_NOT_FOUND');
    return { user };
  }
  async createUser(admin: User, body: unknown) {
    requireAdmin(admin);
    const input = userInput(body, true);
    const user = await this.database(store => store.createUser(admin.id, { ...input, id: randomUUID(), password: input.password! }, new Date(this.now())));
    return { user };
  }
  async updateUser(admin: User, id: string, body: unknown) {
    requireAdmin(admin); userId(id);
    const input = userInput(body, false);
    if (id === admin.id && (input.isInvalid || !input.isAdmin)) {
      throw new ApiError(409, '不能停用或撤销当前账号的管理员权限。', 'USER_SELF_PROTECTED');
    }
    return { user: await this.database(store => store.updateUser(admin.id, id, input, new Date(this.now()))) };
  }
  async deleteUser(admin: User, id: string) {
    requireAdmin(admin); userId(id);
    if (id === admin.id) throw new ApiError(409, '不能删除当前登录的管理员账号。', 'USER_SELF_PROTECTED');
    await this.database(store => store.deleteUser(admin.id, id));
  }
  async dailyTasks(admin: User, query: { page?: unknown }): Promise<DailyTaskPage> {
    requireAdmin(admin);
    const page = pageNumber(query.page), now = this.now();
    const date = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const start = new Date(`${date}T00:00:00+08:00`), end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const events = await this.database(store => store.listDailyEvents(start, end, (page - 1) * pageSize, pageSize));
    const summaries = await this.options.runs.getSummaries(events.items.map(event => event.id));
    const items: DailyTask[] = events.items.map((event, index) => {
      const run = summaries[index];
      const status: DailyTask['status'] = run?.status ?? (event.status === 'failed' ? 'failed'
        : Date.parse(event.expiresAt) <= now ? 'unavailable' : event.status === 'qr_ready' ? 'waiting_scan' : event.status);
      return { id: event.id, username: event.username, requestedAt: event.createdAt,
        scannedAt: run?.authorizedAt ?? null,
        // finishedAt on a failed/expired run does not mean the daily script completed.
        completedAt: run?.status === 'completed' && run.startedAt ? run.finishedAt : null,
        status,
        ...(status === 'failed' ? {
          ...(run?.errorCode ? { errorCode: run.errorCode } : {}),
          errorMessage: taskFailureMessage(run?.errorCode, '未记录具体错误原因。'),
        } : {}) };
    });
    return { items, total: events.total, page, pageSize, date, timeZone: 'Asia/Shanghai' };
  }
}
