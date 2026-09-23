import { useCallback, useEffect, useRef, useState } from 'react';

export interface User { id: string; username: string; isAdmin: boolean }
export type AuthMode = 'login' | 'register';
export type AuthResult = { kind: 'authenticated' } | { kind: 'application_submitted'; message: string } | null;
const authChangedKey = 'naruto-login:auth-changed';

function notifyOtherPages() {
  try { localStorage.setItem(authChangedKey, `${Date.now()}:${Math.random()}`); }
  catch { /* Focus synchronization also works without browser storage. */ }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logoutFailed, setLogoutFailed] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const pendingRefreshRef = useRef(false);

  const refresh = useCallback(async () => {
    if (busyRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    pendingRefreshRef.current = false;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('账户状态暂时无法读取，请稍后重试。');
      const body = await response.json() as { user: User | null };
      if (body.user !== null && (!body.user?.id || !body.user?.username || typeof body.user.isAdmin !== 'boolean')) {
        throw new Error('账户状态暂时无法读取，请稍后重试。');
      }
      if (requestRef.current !== controller) return;
      setUser(body.user);
      setError('');
    } catch (caught) {
      if (requestRef.current !== controller) return;
      setError(caught instanceof Error && caught.name !== 'AbortError'
        ? caught.message : '账户服务连接超时，请稍后重试。');
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key !== authChangedKey) return;
      setUser(null);
      setLoading(true);
      void refresh();
    };
    const onFocus = () => { void refresh(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  async function authenticate(mode: AuthMode, username: string, password: string): Promise<AuthResult> {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setLogoutFailed(false);
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }), signal: controller.signal,
      });
      const body = await response.json() as { user?: User; application?: { id: string }; message?: string; error?: string };
      if (!response.ok) throw new Error(body.error || '账户操作未完成，请重试。');
      if (mode === 'register') {
        if (!body.application?.id) throw new Error('注册申请返回信息异常，请稍后查询申请状态。');
        return { kind: 'application_submitted', message: body.message || '注册申请已提交，等待管理员审批。' };
      }
      if (!body.user?.id || !body.user.username || typeof body.user.isAdmin !== 'boolean') throw new Error('账户服务返回了无效信息，请重试。');
      setUser(body.user);
      setLoading(false);
      notifyOtherPages();
      return { kind: 'authenticated' };
    } catch (caught) {
      setError(caught instanceof Error && caught.name !== 'AbortError'
        ? caught.message : '账户服务连接超时，请稍后重试。');
      return null;
    } finally {
      clearTimeout(timeout);
      busyRef.current = false;
      setBusy(false);
      if (pendingRefreshRef.current) await refresh();
      else setLoading(false);
    }
  }

  async function logout() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setLogoutFailed(false);
    requestRef.current?.abort();
    requestRef.current = null;
    // Clear the account's QR immediately while the logout request is in flight.
    setUser(null);
    let failed = false;
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('退出未完成');
      notifyOtherPages();
    } catch {
      failed = true;
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (pendingRefreshRef.current && !failed) await refresh();
      else if (!failed) setLoading(false);
    }
    if (failed) {
      // The cookie may still be valid. Restore the account so logout can be retried.
      await refresh();
      setLogoutFailed(true);
      setError('退出未完成，请检查网络后重试退出。');
    }
  }

  const handleUnauthorized = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setUser(null);
    setLoading(false);
    setError('登录状态已失效，请重新登录。');
  }, []);

  return { user, loading, busy, error, logoutFailed, authenticate, logout, refresh, handleUnauthorized, clearError: () => setError('') };
}
