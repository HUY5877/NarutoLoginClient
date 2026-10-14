import OSS from 'ali-oss';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { logBackend } from './logging.js';

export interface ObjectReader {
  exists(id: string): Promise<boolean>;
  read(id: string): Promise<Buffer | null>;
}

export function objectKey(config: Pick<Config, 'ossPrefix'>, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(400, '无效的登录申请编号。');
  }
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(config.ossPrefix)) throw unavailable();
  return `${config.ossPrefix}/${id}/qr.png`;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && (
    'status' in error && error.status === 404 ||
    'code' in error && (error.code === 'NoSuchKey' || error.code === 'ENOENT')
  );
}

function unavailable(): ApiError { return new ApiError(503, '二维码存储暂时不可用，请稍后重试。'); }

export function createObjectReader(config: Config): ObjectReader {
  if (config.storageDriver === 'local') {
    const localPath = async (key: string): Promise<string> => {
      const root = await realpath(config.localObjectsDir);
      const file = await realpath(resolve(root, ...key.split('/')));
      const child = relative(root, file);
      // Reject directory junctions and symlinks that point outside the object store.
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw unavailable();
      if (!(await stat(file)).isFile()) throw unavailable();
      return file;
    };
    return {
      async exists(id) {
        const key = objectKey(config, id);
        try { await localPath(key); return true; }
        catch (error) {
          if (isMissing(error)) return false;
          logBackend('error', 'dependency.failed', { component: 'storage', phase: 'local.exists', error });
          throw unavailable();
        }
      },
      async read(id) {
        const key = objectKey(config, id);
        try { return await readFile(await localPath(key)); }
        catch (error) {
          if (isMissing(error)) return null;
          logBackend('error', 'dependency.failed', { component: 'storage', phase: 'local.read', error });
          throw unavailable();
        }
      },
    };
  }
  const client = new OSS({
    region: config.ossRegion!, bucket: config.ossBucket!, accessKeyId: config.ossAccessKeyId!,
    accessKeySecret: config.ossAccessKeySecret!, stsToken: config.ossStsToken, secure: true, timeout: config.timeoutMs,
  });
  return {
    async exists(id) {
      const key = objectKey(config, id);
      try { await client.head(key); return true; }
      catch (error) {
        if (isMissing(error)) return false;
        logBackend('error', 'dependency.failed', { component: 'storage', phase: 'oss.exists', timeoutMs: config.timeoutMs, error });
        throw unavailable();
      }
    },
    async read(id) {
      const key = objectKey(config, id);
      try { return (await client.get(key)).content; }
      catch (error) {
        if (isMissing(error)) return null;
        logBackend('error', 'dependency.failed', { component: 'storage', phase: 'oss.read', timeoutMs: config.timeoutMs, error });
        throw unavailable();
      }
    },
  };
}
