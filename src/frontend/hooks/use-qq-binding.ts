import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Binding { qq: string; boundAt: string }
interface Challenge { id: string; expiresAt: string }
export interface QqBindingStatus { enabled: boolean; binding: Binding | null; challenge: Challenge | null }
type Scope = { userId: string | null; open: boolean };
interface View {
  scope: Scope;
  status: QqBindingStatus | null;
  code: string | null;
  error: string;
  message: string;
  loading: boolean;
  busy: boolean;
}
const emptyView = (scope: Scope): View => ({ scope, status: null, code: null, error: '', message: '', loading: true, busy: false });
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function parseStatus(value: unknown): QqBindingStatus {
  const status = value as QqBindingStatus;
  if (!status || typeof status.enabled !== 'boolean'
    || status.binding !== null && (!validDate(status.binding?.boundAt) || typeof status.binding.qq !== 'string' || !/^[1-9][0-9]*$/.test(status.binding.qq))
    || status.challenge !== null && (!validDate(status.challenge?.expiresAt)
      || typeof status.challenge.id !== 'string' || !status.challenge.id)) {
    throw new Error('QQ 绑定状态暂时无法读取，请重试。');
  }
  return status;
}

export function useQqBinding(userId: string | null, open: boolean, onUnauthorized: () => void) {
  const scope = useMemo(() => ({ userId, open }), [userId, open]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const [view, setView] = useState(() => emptyView(scope));
  const [now, setNow] = useState(Date.now);
  const requestRef = useRef<{ scope: Scope; controller: AbortController; mutation: boolean } | null>(null);

  const update = useCallback((change: Partial<View> | ((current: View) => Partial<View>)) => {
    if (scopeRef.current !== scope) return;
    setView(current => {
      const base = current.scope === scope ? current : emptyView(scope);
      return { ...base, ...(typeof change === 'function' ? change(base) : change) };
    });
  }, [scope]);

  const request = useCallback(async (method: string, suffix: string,
    accept: (body: unknown) => void, silent = false, input: Record<string, string> = {}) => {
    if (!scope.open || !scope.userId || scopeRef.current !== scope) return;
    const mutation = method !== 'GET';
    if (requestRef.current) {
      if (!mutation || requestRef.current.mutation) return;
      // A user action takes precedence over a background status read.
      requestRef.current.controller.abort();
    }
    const active = { scope, controller: new AbortController(), mutation };
    requestRef.current = active;
    if (!silent) update({ error: '', message: '', busy: mutation });
    const isCurrent = () => scopeRef.current === scope && requestRef.current === active;
    const timeout = window.setTimeout(() => active.controller.abort(), 10_000);
    try {
      const response = await fetch(`/api/qq-number-binding${suffix}`, {
        method, credentials: 'same-origin', cache: 'no-store', signal: active.controller.signal,
        ...(mutation ? { headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) } : {}),
      });
      if (!isCurrent()) return;
      if (response.status === 401) { unauthorizedRef.current(); return; }
      const body: unknown = response.status === 204 ? null : await response.json();
      if (!isCurrent()) return;
      if (!response.ok) {
        const error = (body as { error?: unknown })?.error;
        throw new Error(typeof error === 'string' ? error : 'QQ 绑定操作未完成，请重试。');
      }
      accept(body);
      update({ error: '' });
    } catch (caught) {
      if (!isCurrent()) return;
      update({ error: caught instanceof Error && caught.name !== 'AbortError'
        ? caught.message : 'QQ 绑定服务连接超时，请重试。' });
    } finally {
      clearTimeout(timeout);
      if (isCurrent()) {
        requestRef.current = null;
        update({ loading: false, busy: false });
      }
    }
  }, [scope, update]);

  const refresh = useCallback((silent = false) => request('GET', '', body => {
    const status = parseStatus(body);
    update(current => ({ status,
      code: current.status?.challenge?.id === status.challenge?.id ? current.code : null,
      ...(current.status?.challenge && !status.challenge && status.binding
        && (!current.status.binding || current.status.binding.qq !== status.binding.qq
          || current.status.binding.boundAt !== status.binding.boundAt) ? { message: '绑定成功' } : {}),
    }));
  }, silent), [request, update]);

  useEffect(() => {
    setView(emptyView(scope));
    setNow(Date.now());
    if (scope.open && scope.userId) void refresh();
    return () => {
      if (requestRef.current?.scope === scope) {
        const active = requestRef.current;
        requestRef.current = null;
        active.controller.abort();
      }
    };
  }, [scope, refresh]);

  const current = view.scope === scope ? view : emptyView(scope);
  const expiresAt = current.status?.challenge?.expiresAt;
  useEffect(() => {
    if (!scope.open || !scope.userId || !expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [scope, expiresAt]);
  useEffect(() => {
    if (!scope.open || !scope.userId || !current.status?.enabled || !expiresAt) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (disposed) return;
      // A code redeemed just before expiry may commit after the last live poll.
      // Read once at the boundary so that success is visible, then stop.
      const terminal = Date.now() >= Date.parse(expiresAt);
      await refresh(true);
      if (!disposed && !terminal) timer = setTimeout(() => { void poll(); }, 2_500);
    };
    timer = setTimeout(() => { void poll(); }, 2_500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [scope, expiresAt, current.status?.enabled, refresh]);

  const generate = () => request('POST', '/challenge', body => {
    const result = body as { id?: unknown; code?: unknown; expiresAt?: unknown };
    if (typeof result?.id !== 'string' || !result.id || typeof result.code !== 'string'
      || !/^[A-Za-z0-9_-]{24}$/.test(result.code) || !validDate(result.expiresAt)) {
      throw new Error('绑定码暂时无法生成，请重试。');
    }
    const expiresAt = result.expiresAt;
    update(current => ({ code: result.code as string, status: { enabled: true,
      binding: current.status?.binding ?? null, challenge: { id: result.id as string, expiresAt } } }));
    setNow(Date.now());
  });

  const unbind = () => request('DELETE', '', () => {
    update(current => ({ code: null, status: { enabled: current.status?.enabled ?? true, binding: null, challenge: null }, message: '已解除绑定' }));
  });

  const remainingSeconds = expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000)) : 0;
  return { ...current, remainingSeconds, expired: Boolean(expiresAt && remainingSeconds <= 0),
    refresh, generate, unbind };
}
