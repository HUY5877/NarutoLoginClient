import { createApp } from '../src/server/app.js';
import { AuthService } from '../src/server/auth.js';
import { PgAuthStore } from '../src/server/database.js';
import { LoginEventService } from '../src/server/login-events.js';
import { loadRuntimeConfig } from '../src/server/cloudflare.js';
import { TaskService } from '../src/server/queue.js';
import { TaskRunService } from '../src/server/task-runs.js';
import { createObjectReader } from '../src/server/storage.js';
import { AdminService } from '../src/server/admin.js';
import { QqCaptureService } from '../src/server/qq-captures.js';
import { QqBindingService } from '../src/server/qq-binding.js';

const config = await loadRuntimeConfig();
const store = config.databaseUrl ? new PgAuthStore(config.databaseUrl, config.timeoutMs) : undefined;
const tasks = new TaskService(config);
const runs = new TaskRunService(config, { store });
const auth = new AuthService(config, { store });
const app = createApp(config, {
  events: new LoginEventService(config, { store, tasks }),
  runs,
  admin: new AdminService({ store, runs }),
  qqCaptures: new QqCaptureService(config),
  qqBindings: new QqBindingService(config, { initializeUsers: () => auth.initialize() }),
  auth, storage: createObjectReader(config),
});
// Vercel terminates HTTPS before forwarding the request to this function.
app.set('trust proxy', 1);

export default app;
