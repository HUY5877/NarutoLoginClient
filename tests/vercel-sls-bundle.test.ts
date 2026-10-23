import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRequire = createRequire(new URL('../src/server/package.json', import.meta.url));
const { build } = serverRequire('esbuild') as typeof import('../src/server/node_modules/esbuild/lib/main.js');
const repository = fileURLToPath(new URL('../', import.meta.url));

test('SLS 服务端打包包含 SDK 实际运行入口及配置依赖，避免部署后冷启动缺包', async () => {
  const result = await build({
    absWorkingDir: repository,
    entryPoints: ['src/server/sls-logs.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    // Native bindings remain external; this test verifies the SDK's JavaScript dependency graph.
    external: ['lz4-napi'],
    write: false,
    metafile: true,
  });
  assert.ok(result.metafile);
  const included = new Set(Object.keys(result.metafile.inputs).map(input => realpathSync(resolve(repository, input))));
  for (const dependency of ['@alicloud/sls20201230', '@alicloud/openapi-core', '@darabonba/typescript']) {
    const runtimeEntry = realpathSync(serverRequire.resolve(dependency));
    assert.ok(included.has(runtimeEntry), `服务端打包遗漏运行依赖 ${dependency}：${runtimeEntry}`);
  }
});
