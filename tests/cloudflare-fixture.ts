export const cloudflareTestEnv = {
  APP_ENV: 'prod',
  CLOUDFLARE_API_TOKEN: 'fixture-token',
  CLOUDFLARE_ACCOUNT_ID: 'fixture-account',
  CLOUDFLARE_KV_NAMESPACE_ID: 'fixture-namespace',
  CLOUDFLARE_KV_NAMESPACE_ID_PROD: 'fixture-prod',
  CLOUDFLARE_KV_NAMESPACE_ID_TEST: 'fixture-test',
};
export const cloudflarePreload = new URL('./fixtures/cloudflare-fetch.mjs', import.meta.url).href;
