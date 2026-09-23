import OSS from 'ali-oss';
import type { Config } from './config.js';
import { ApiError } from './upstream.js';

export interface ObjectReader {
  exists(id: string): Promise<boolean>;
  read(id: string): Promise<Buffer | null>;
}

export function objectKey(config: Pick<Config, 'ossPrefix'>, id: string): string {
  return `${config.ossPrefix}/${id}/qr.png`;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && ('status' in error && error.status === 404 || 'code' in error && error.code === 'NoSuchKey');
}

export function createObjectReader(config: Config): ObjectReader {
  if (config.storageDriver === 'local') {
    const request = async (id: string, method: string): Promise<Response> => {
      try {
        const response = await fetch(`${config.serviceUrl}/internal/objects/${id}/qr.png`, {
          method, headers: { 'X-Service-Token': config.serviceToken }, signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (response.status !== 404 && !response.ok) throw new Error('storage read failed');
        return response;
      } catch { throw new ApiError(503, '二维码存储暂时不可用，请稍后重试。'); }
    };
    return {
      async exists(id) { return (await request(id, 'HEAD')).ok; },
      async read(id) {
        const response = await request(id, 'GET');
        if (!response.ok) return null;
        try { return Buffer.from(await response.arrayBuffer()); }
        catch { throw new ApiError(503, '二维码存储暂时不可用，请稍后重试。'); }
      },
    };
  }
  const client = new OSS({
    region: config.ossRegion!, bucket: config.ossBucket!, accessKeyId: config.ossAccessKeyId!,
    accessKeySecret: config.ossAccessKeySecret!, stsToken: config.ossStsToken, secure: true, timeout: config.timeoutMs,
  });
  return {
    async exists(id) {
      try { await client.head(objectKey(config, id)); return true; }
      catch (error) { if (isMissing(error)) return false; throw new ApiError(503, '二维码存储暂时不可用，请稍后重试。'); }
    },
    async read(id) {
      try { return (await client.get(objectKey(config, id))).content; }
      catch (error) { if (isMissing(error)) return null; throw new ApiError(503, '二维码存储暂时不可用，请稍后重试。'); }
    },
  };
}
