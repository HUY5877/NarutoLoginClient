export interface McpBindingPreview { qq: string; expiresAt: string }
export interface McpBindingResult { qq: string; userId: string; boundAt: string }

export class McpBindingUnauthorized extends Error {}

async function postBinding(action: 'preview' | 'confirm', token: string, signal: AbortSignal, expectedUserId?: string): Promise<unknown> {
  const response = await fetch(`/api/mcp-bindings/${action}`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'confirm' ? { token, expectedUserId } : { token }),
  });
  if (response.status === 401) throw new McpBindingUnauthorized('请重新登录网站账号。');
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error('绑定服务返回异常，请重试。'); }
  if (response.status === 409 && (body as { code?: unknown })?.code === 'MCP_BINDING_ACCOUNT_CHANGED') {
    throw new McpBindingUnauthorized('登录账号已变化，请重新登录并核对。');
  }
  if (!response.ok) {
    const message = (body as { error?: unknown })?.error;
    // A server error must never echo a secret into the page.
    throw new Error(typeof message === 'string' && message && !message.includes(token)
      ? message : '绑定暂未完成，请稍后重试。');
  }
  return body;
}

const validQq = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export async function previewMcpBinding(token: string, signal: AbortSignal): Promise<McpBindingPreview> {
  const body = await postBinding('preview', token, signal) as McpBindingPreview;
  if (!body || !validQq(body.qq) || !validDate(body.expiresAt)) throw new Error('绑定信息暂时无法读取，请重试。');
  return body;
}

export async function confirmMcpBinding(token: string, expectedUserId: string, signal: AbortSignal): Promise<McpBindingResult> {
  const body = await postBinding('confirm', token, signal, expectedUserId) as McpBindingResult;
  if (!body || !validQq(body.qq) || typeof body.userId !== 'string' || !body.userId || !validDate(body.boundAt)) {
    throw new Error('绑定结果暂时无法确认，请稍后重试。');
  }
  return body;
}
