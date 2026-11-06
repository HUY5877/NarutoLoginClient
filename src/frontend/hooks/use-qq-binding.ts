import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Binding { boundAt: string }
interface Challenge { id: string; expiresAt: string; received: boolean; senderName: string | null }
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
    || status.binding !== null && !validDate(status.binding?.boundAt)
    || status.challenge !== null && (!validDate(status.challenge?.expiresAt)
      || typeof status.challenge.id !== 'string' || !status.challenge.id
      || typeof status.challenge.received !== 'boolean'
      || status.challenge.senderName !== null && typeof status.challenge.senderName !== 'string')) {
    throw new Error('群提醒状态暂时无法读取，请重试。');
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
  const viewRef = useRef(view);
  viewRef.current = view;
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
      const response = await fetch(`/api/qq-binding${suffix}`, {
        method, credentials: 'same-origin', cache: 'no-store', signal: active.controller.signal,
        ...(mutation ? { headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) } : {}),
      });
      if (!isCurrent()) return;
      if (response.status === 401) { unauthorizedRef.current(); return; }
      const body: unknown = response.status === 204 ? null : await response.json();
      if (!isCurrent()) return;
      if (!response.ok) {
        const error = (body as { error?: unknown })?.error;
        throw new Error(typeof error === 'string' ? error : '群提醒操作未完成，请重试。');
      }
      accept(body);
      update({ error: '' });
    } catch (caught) {
      if (!isCurrent()) return;
      update({ error: caught instanceof Error && caught.name !== 'AbortError'
        ? caught.message : '群提醒服务连接超时，请重试。' });
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
      code: current.status?.challenge?.id === status.challenge?.id ? current.code : null }));
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
      if (disposed || Date.now() >= Date.parse(expiresAt)) return;
      await refresh(true);
      if (!disposed) timer = setTimeout(() => { void poll(); }, 2_500);
    };
    timer = setTimeout(() => { void poll(); }, 2_500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [scope, expiresAt, current.status?.enabled, refresh]);

  const generate = () => request('POST', '/challenge', body => {
    const result = body as { id?: unknown; code?: unknown; expiresAt?: unknown };
    if (typeof result?.id !== 'string' || !result.id || typeof result.code !== 'string'
      || !/^[A-Z0-9]{8}$/i.test(result.code) || !validDate(result.expiresAt)) {
      throw new Error('绑定码暂时无法生成，请重试。');
    }
    const expiresAt = result.expiresAt;
    update(current => ({ code: result.code as string, status: { enabled: true,
      binding: current.status?.binding ?? null, challenge: { id: result.id as string, expiresAt, received: false, senderName: null } } }));
    setNow(Date.now());
  });

  const confirm = async () => {
    const candidate = viewRef.current.scope === scope ? viewRef.current.status?.challenge : null;
    if (!candidate?.received || Date.now() >= Date.parse(candidate.expiresAt)) return;
    let confirmed = false;
    await request('POST', '/confirm', body => {
      const result = body as { binding?: Binding };
      if (!validDate(result?.binding?.boundAt)) throw new Error('绑定结果暂时无法读取，请重试查询。');
      confirmed = true;
      update(current => ({ code: null, message: '绑定成功', status: {
        enabled: current.status?.enabled ?? true, binding: result.binding!, challenge: null,
      } }));
    }, false, { challengeId: candidate.id });
    if (confirmed) await refresh(true);
  };

  const unbind = () => request('DELETE', '', () => {
    update(current => ({ code: null, status: { enabled: current.status?.enabled ?? true, binding: null, challenge: null }, message: '已解除绑定' }));
  });

  const remainingSeconds = expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000)) : 0;
  return { ...current, remainingSeconds, expired: Boolean(expiresAt && remainingSeconds <= 0),
    refresh, generate, confirm, unbind };
}
