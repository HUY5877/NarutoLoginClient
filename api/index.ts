import { createApp } from '../src/server/app.js';
import { AuthService } from '../src/server/auth.js';
import { PgAuthStore } from '../src/server/database.js';
import { LoginEventService } from '../src/server/login-events.js';
import { loadConfig } from '../src/server/config.js';
import { TaskService } from '../src/server/queue.js';
import { createObjectReader } from '../src/server/storage.js';

const config = loadConfig();
const store = config.databaseUrl ? new PgAuthStore(config.databaseUrl, config.timeoutMs) : undefined;
const tasks = new TaskService(config);
const app = createApp(config, {
  events: new LoginEventService(config, { store, tasks }),
  auth: new AuthService(config, { store }), storage: createObjectReader(config),
});
// Vercel terminates HTTPS before forwarding the request to this function.
app.set('trust proxy', 1);

export default app;
