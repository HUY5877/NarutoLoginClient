// Startup tests preload this module in child processes. No Cloudflare traffic leaves the machine.
const originalFetch = globalThis.fetch;
const values = {
  REDIS_QUEUE_KEY: 'fixture:login:tasks',
  OSS_KEY_PREFIX: 'fixture-login',
  STORAGE_DRIVER: 'local',
  HOST: process.env.HOST ?? '127.0.0.1',
  PORT: process.env.PORT ?? '4300',
  SESSION_COOKIE_NAME: 'naruto_session',
  LOCAL_OBJECTS_DIR: 'fixture-objects',
};
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'api.cloudflare.com') {
    if (url.pathname.endsWith('/keys') && url.pathname.includes('/fixture-prod/') && !url.searchParams.has('prefix')) {
      return Response.json({ success: true, result: Object.keys(values).map(name => ({ name })), result_info: { cursor: '' } });
    }
    if (url.pathname.endsWith('/bulk/get') && init?.method === 'POST') {
      const { keys } = JSON.parse(init.body);
      return Response.json({ success: true, result: { values: Object.fromEntries(keys.map(key => [key, values[key]])) } });
    }
    throw new Error('Unexpected Cloudflare fixture request');
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return originalFetch(input, init);
  throw new Error('External traffic is disabled in startup tests');
};
