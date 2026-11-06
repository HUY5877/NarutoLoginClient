import type { LoginEventService } from './login-events.js';
import { ApiError } from './errors.js';
import type { Task } from './queue.js';
import type { ObjectReader } from './storage.js';

export type QrTaskResult =
  | { status: 'running'; taskId: string; pollAfterMs: number }
  | { status: 'error'; taskId: string; code: string; message: string }
  | { status: 'success'; taskId: string; url: string; expiresAt: string };

interface Options {
  events: Pick<LoginEventService, 'getForUser' | 'recordStatus'>;
  storage: ObjectReader;
  now?: () => number;
}

export class QrTaskResultService {
  private readonly now: () => number;
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; }

  private running(taskId: string): QrTaskResult { return { status: 'running', taskId, pollAfterMs: 1000 }; }
  private error(taskId: string, code: string, message: string): QrTaskResult {
    return { status: 'error', taskId, code, message };
  }

  private unavailable(task: Task, taskId: string): QrTaskResult | undefined {
    if (task.status === 'failed' || task.runStatus === 'failed' || task.runStatus === 'interrupted') {
      return this.error(taskId, 'QR_FAILED', '本次二维码生成失败或任务已中断，请重新申请。');
    }
    const remaining = Date.parse(task.expiresAt) - this.now();
    if (task.status === 'expired' || task.runStatus === 'expired' || !Number.isFinite(remaining) || remaining < 1000) {
      return this.error(taskId, 'QR_EXPIRED', '二维码已过期，请重新申请。');
    }
    if (task.loginAuthorized || task.scanCaptured || task.runStatus === 'finishing_login'
      || task.runStatus === 'running_daily' || task.runStatus === 'completed') {
      return this.error(taskId, 'QR_UNAVAILABLE', '扫码已完成，无需再次扫码。');
    }
    if (task.refreshRequestId) return this.running(taskId);
  }

  async get(userId: string, taskId: string): Promise<QrTaskResult> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (typeof userId !== 'string' || typeof taskId !== 'string' || !uuid.test(userId) || !uuid.test(taskId)) {
      throw new ApiError(400, '无效的用户或登录申请编号。');
    }
    try {
      const original = await this.options.events.getForUser(taskId, userId, { requireLive: true });
      const stopped = this.unavailable(original, taskId);
      if (stopped) return stopped;
      // Match the web image route: the object must contain a PNG header, not merely exist.
      const content = await this.options.storage.read(taskId);
      const current = await this.options.events.getForUser(taskId, userId, { requireLive: true });
      const changed = this.unavailable(current, taskId);
      if (changed) return changed;
      if (current.qrRevision !== original.qrRevision) return this.running(taskId);
      if (!content) {
        if (current.status === 'qr_ready') await this.options.events.recordStatus(taskId, userId, 'preparing_qr');
        return this.running(taskId);
      }
      if (!content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return this.error(taskId, 'QR_INVALID_IMAGE', '二维码图片格式无效，请重新申请。');
      }
      if (!this.options.storage.signUrl) {
        return this.error(taskId, 'QR_STORAGE_UNSUPPORTED', '当前使用本地图片存储，无法提供 OSS 签名链接。');
      }
      const issuedAt = this.now();
      const expiresSeconds = Math.min(60, Math.floor((Date.parse(current.expiresAt) - issuedAt) / 1000));
      if (expiresSeconds <= 0) return this.error(taskId, 'QR_EXPIRED', '二维码已过期，请重新申请。');
      // ali-oss signs at whole-second resolution. Report a conservative deadline.
      const expiresAt = Math.floor(issuedAt / 1000) * 1000 + expiresSeconds * 1000;
      const url = await this.options.storage.signUrl(taskId, expiresSeconds);
      const latest = await this.options.events.getForUser(taskId, userId, { requireLive: true });
      const ended = this.unavailable(latest, taskId);
      if (ended) return ended;
      if (latest.qrRevision !== original.qrRevision || expiresAt > Date.parse(latest.expiresAt)) return this.running(taskId);
      if (expiresAt <= this.now()) return this.error(taskId, 'QR_EXPIRED', '二维码链接已过期，请重新查询。');
      if (new URL(url).protocol !== 'https:') throw new Error('Invalid storage URL');
      return { status: 'success', taskId, url, expiresAt: new Date(expiresAt).toISOString() };
    } catch (error) {
      // Dependency exception text may contain credentials or a signed URL.
      if (error instanceof ApiError && error.status === 404) {
        throw new ApiError(404, '登录申请不存在或不属于当前账号。');
      }
      return this.error(taskId, 'QR_RESULT_UNAVAILABLE', '二维码查询暂时不可用，请稍后重试。');
    }
  }
}
