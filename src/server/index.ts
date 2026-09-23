import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { releasePort } from './port.js';
import { createObjectReader } from './storage.js';
import { TaskService } from './upstream.js';

const config = loadConfig();
try {
  await releasePort(config.host, config.port);
} catch (error) {
  console.error(error instanceof Error ? error.message : `无法清理端口 ${config.port}。`);
  process.exit(1);
}
const app = createApp(config, { tasks: new TaskService(config), storage: createObjectReader(config) });
const server = createServer(app);
let vite: import('vite').ViteDevServer | undefined;

if (process.argv.includes('--dev')) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    envDir: false,
    // Regression tests must not replace the running developer's dependency cache.
    cacheDir: process.env.NODE_ENV === 'test' ? resolve('node_modules/.vite-test', String(process.pid)) : undefined,
    appType: 'spa',
    server: {
      host: config.host,
      port: config.port,
      middlewareMode: true,
      // Share the HTTP listener for hot reload too; no extra WebSocket port.
      ws: { server },
    },
  });
  app.use(vite.middlewares);
} else {
  const dist = resolve('dist');
  if (!existsSync(resolve(dist, 'index.html'))) {
    throw new Error('请先运行 npm run build，或使用 npm run dev 启动开发模式。');
  }
  app.use(express.static(dist, { index: false }));
  app.get('/', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 5000).unref();
  await vite?.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown(); });
}
server.once('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，请停止旧客户端或修改 PORT。` : error.message);
  process.exitCode = 1;
  void shutdown();
});
server.listen(config.port, config.host, () => {
  console.log(`忍者日常客户端 http://${config.host}:${config.port} · 前端/API 共用端口 · ${config.storageDriver} 存储 · 模拟登录`);
});
