import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createObjectReader } from './storage.js';
import { TaskService } from './upstream.js';

const config = loadConfig();
const app = createApp(config, { tasks: new TaskService(config), storage: createObjectReader(config) });
const dist = resolve('dist');
if (existsSync(resolve(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false }));
  app.get('/', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}
const server = app.listen(config.port, config.host, () => {
  console.log(`忍者日常客户端 http://${config.host}:${config.port} · ${config.storageDriver} 存储 · 模拟登录`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 5000).unref();
  });
}
