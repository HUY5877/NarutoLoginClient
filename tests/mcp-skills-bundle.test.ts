import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(new URL('../src/server/mcp/copy-skills.mjs', import.meta.url));

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'naruto-mcp-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'mcp', 'copy-skills.mjs');
  const source = join(root, 'mcp', 'skills');
  const cwd = join(root, 'unrelated-working-directory');
  await mkdir(dirname(script), { recursive: true });
  await mkdir(cwd);
  await assert.doesNotReject(() => copyFile(sourceScript, script), 'skill 复制脚本必须存在');
  const files = new Map<string, Buffer>([
    ['hyrz-service/SKILL.md', Buffer.from('# 火影日常\n\n业务规范。\n')],
    ['hyrz-service/agents/openai.yaml', Buffer.from('interface:\n  display_name: 火影日常\n')],
    ['hyrz-service/assets/nested/example.bin', Buffer.from([0, 1, 127, 128, 255])],
  ]);
  for (const [relative, contents] of files) {
    const path = join(source, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return { root, script, source, cwd, files };
}

async function fileNames(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await fileNames(root, relative));
    else files.push(relative);
  }
  return files.sort();
}

async function assertContents(destination: string, expected: Map<string, Buffer>) {
  assert.deepEqual(await fileNames(destination), [...expected.keys()].sort());
  for (const [relative, contents] of expected) {
    assert.deepEqual(await readFile(join(destination, relative)), contents, relative);
  }
}

test('skill 构建复制默认写入脚本相邻 dist/skills，且不依赖工作目录', async t => {
  const { root, script, cwd, files } = await fixture(t);
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assertContents(join(root, 'dist', 'skills'), files);
});

test('skill 构建复制支持临时目标，并完整保留嵌套文件和原始字节', async t => {
  const { root, script, cwd, files } = await fixture(t);
  const destination = join(root, 'custom-output', 'skills');
  const result = spawnSync(process.execPath, [script, destination], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assertContents(destination, files);
});
