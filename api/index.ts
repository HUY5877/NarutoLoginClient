import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { TaskService } from '../src/server/queue.js';
import { createObjectReader } from '../src/server/storage.js';

const config = loadConfig();
const app = createApp(config, { tasks: new TaskService(config), storage: createObjectReader(config) });
// Vercel terminates HTTPS before forwarding the request to this function.
app.set('trust proxy', 1);

export default app;
