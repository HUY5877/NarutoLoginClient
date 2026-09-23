import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig, type Config } from '../src/server/config.js';
import { ApiError } from '../src/server/errors.js';
import { createObjectReader, objectKey } from '../src/server/storage.js';

const id = '123e4567-e89b-42d3-a456-426614174000';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const OSS = createRequire(new URL('../src/server/package.json', import.meta.url))('ali-oss') as {
  prototype: { head(key: string): Promise<unknown>; get(key: string): Promise<{ content: Buffer }> };
};

async function withStore(run: (config: Config, fixture: string) => Promise<void>) {
  const fixture = await mkdtemp(join(tmpdir(), 'naruto-storage-'));
  const localObjectsDir = join(fixture, 'objects');
  try { await run({ ...loadConfig({}), localObjectsDir }, fixture); }
  finally {
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
    assert.ok(basename(fixture).startsWith('naruto-storage-'));
    await rm(fixture, { recursive: true, force: true });
  }
}

function isUnavailable(error: unknown): boolean {
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 503);
  assert.equal(error.message, '二维码存储暂时不可用，请稍后重试。');
  return true;
}

test('本地对象尚未生成时返回不存在，生成后直接从磁盘读取二维码', async () => {
  await withStore(async config => {
    const reader = createObjectReader(config);
    assert.equal(await reader.exists(id), false);
    assert.equal(await reader.read(id), null);
    const file = join(config.localObjectsDir, objectKey(config, id));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, png);
    assert.equal(await reader.exists(id), true);
    assert.deepEqual(await reader.read(id), png);
    await rm(file);
    assert.equal(await reader.exists(id), false);
    assert.equal(await reader.read(id), null);
  });
});

test('对象编号和前缀不能包含跳出存储目录的路径', async () => {
  await withStore(async config => {
    const reader = createObjectReader(config);
    for (const value of ['../outside', `${id}/../outside`, `..\\${id}`, 'invalid']) {
      await assert.rejects(reader.exists(value), { status: 400 });
      await assert.rejects(reader.read(value), { status: 400 });
    }
    assert.equal(objectKey({ ossPrefix: 'login/preview' }, id), `login/preview/${id}/qr.png`);
    for (const ossPrefix of ['../outside', '/outside', 'login/../../outside', 'login\\outside']) {
      const invalid = createObjectReader({ ...config, ossPrefix });
      await assert.rejects(invalid.read(id), isUnavailable);
    }
  });
});

test('本地对象不能通过目录联接或符号链接读取存储根目录以外的文件', async () => {
  await withStore(async (config, fixture) => {
    const outside = join(fixture, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'qr.png'), png);
    const prefix = join(config.localObjectsDir, config.ossPrefix);
    await mkdir(prefix, { recursive: true });
    await symlink(outside, join(prefix, id), process.platform === 'win32' ? 'junction' : 'dir');
    const reader = createObjectReader(config);
    await assert.rejects(reader.exists(id), isUnavailable);
    await assert.rejects(reader.read(id), isUnavailable);
  });
});

test('本地对象出现目录或其他读盘异常时返回受控 503', async () => {
  await withStore(async config => {
    await mkdir(join(config.localObjectsDir, objectKey(config, id)), { recursive: true });
    const reader = createObjectReader(config);
    await assert.rejects(reader.exists(id), isUnavailable);
    await assert.rejects(reader.read(id), isUnavailable);
  });
});

function ossConfig(): Config {
  return loadConfig({ STORAGE_DRIVER: 'oss', OSS_REGION: 'oss-cn-shanghai', OSS_BUCKET: 'fixture-bucket',
    OSS_ACCESS_KEY_ID: 'fixture-id', OSS_ACCESS_KEY_SECRET: 'fixture-secret' });
}

test('OSS 使用 HEAD 查询对象、GET 读取内容，两次均使用同一个唯一编号路径', async t => {
  const received: string[] = [];
  t.mock.method(OSS.prototype, 'head', async (key: string) => { received.push(`HEAD ${key}`); });
  t.mock.method(OSS.prototype, 'get', async (key: string) => { received.push(`GET ${key}`); return { content: png }; });
  const reader = createObjectReader(ossConfig());
  assert.equal(await reader.exists(id), true);
  assert.deepEqual(await reader.read(id), png);
  assert.deepEqual(received, [`HEAD login/${id}/qr.png`, `GET login/${id}/qr.png`]);
});

test('OSS 404 和 NoSuchKey 表示二维码尚未上传', async t => {
  t.mock.method(OSS.prototype, 'head', async () => { throw { status: 404 }; });
  t.mock.method(OSS.prototype, 'get', async () => { throw { code: 'NoSuchKey' }; });
  const reader = createObjectReader(ossConfig());
  assert.equal(await reader.exists(id), false);
  assert.equal(await reader.read(id), null);
});

test('OSS 权限和网络异常转为受控 503，不泄露 SDK 错误或凭据', async t => {
  t.mock.method(OSS.prototype, 'head', async () => { throw new Error('fixture-secret: connection failed'); });
  t.mock.method(OSS.prototype, 'get', async () => { throw { status: 403, message: 'fixture-secret' }; });
  const reader = createObjectReader(ossConfig());
  await assert.rejects(reader.exists(id), isUnavailable);
  await assert.rejects(reader.read(id), isUnavailable);
});
