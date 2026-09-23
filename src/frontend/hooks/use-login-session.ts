import { useCallback, useEffect, useRef, useState } from 'react';

export type SessionStatus =
  | 'queued'
  | 'starting_emulator'
  | 'opening_game'
  | 'preparing_qr'
  | 'qr_ready'
  | 'failed'
  | 'expired';
export type Phase = 'idle' | 'submitting' | SessionStatus;

export interface Session {
  id: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  simulation: boolean;
  error?: string;
}

interface CreatedSession extends Session {
  accessToken: string;
  pollAfterMs: number;
}

const statusLabels: Record<Phase, string> = {
  idle: '等待生成二维码',
  submitting: '正在创建登录申请',
  queued: '申请已收到，正在排队',
  starting_emulator: '正在准备独立游戏环境',
  opening_game: '正在打开火影忍者',
  preparing_qr: '正在准备登录二维码',
  qr_ready: '模拟二维码已就绪',
  failed: '这次准备未能完成',
  expired: '二维码已过期',
};

class RequestError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function request(path: string, signal: AbortSignal, init?: RequestInit) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const timeoutController = new AbortController();
  const onAbort = () => timeoutController.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = window.setTimeout(() => timeoutController.abort(), 10_000);
  try {
    const response = await fetch(path, {
      ...init,
      cache: 'no-store',
      signal: timeoutController.signal,
    });
    if (!response.ok) {
      const message = response.status === 429
        ? '申请较多，请稍后重新生成。'
        : response.status === 401 || response.status === 403
          ? '登录申请已失效，请重新生成二维码。'
          : response.status === 404 || response.status === 410
            ? '登录申请已过期，请重新生成二维码。'
            : '暂时无法连接登录服务，请稍后重新生成。';
      throw new RequestError(message, response.status);
    }
    // Read the body while the timeout and cancellation signal still apply.
    const body = await response.arrayBuffer();
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (error instanceof RequestError) throw error;
    throw new RequestError('登录服务连接超时或网络中断，请稍后重新生成。');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

async function retryRead(path: string, token: string, signal: AbortSignal, onRetry: () => void) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(path, signal, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      const retryable = error instanceof RequestError &&
        (error.status === 0 || error.status === 429 || error.status >= 500);
      if (!retryable || attempt >= 2 || signal.aborted) throw error;
      onRetry();
      await delay(1_000 * (attempt + 1), signal);
    }
  }
}

function validSession(value: Session): boolean {
  return typeof value?.id === 'string' && value.id.length > 0 &&
    typeof value.status === 'string' && Object.hasOwn(statusLabels, value.status) &&
    !['idle', 'submitting'].includes(value.status) &&
    Number.isFinite(Date.parse(value.expiresAt));
}

export function useLoginSession() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<Session | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(Date.now());
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const qrUrlRef = useRef<string | null>(null);
  const submittingRef = useRef(false);

  const replaceQr = useCallback((next: string | null) => {
    if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
    qrUrlRef.current = next;
    setQrUrl(next);
  }, []);

  useEffect(() => () => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
  }, []);

  useEffect(() => {
    if (!session || phase === 'expired' || phase === 'failed') return;
    const generation = generationRef.current;
    const tick = () => {
      if (generationRef.current !== generation) return;
      const timestamp = Date.now();
      setNow(timestamp);
      if (timestamp >= Date.parse(session.expiresAt)) {
        generationRef.current += 1;
        controllerRef.current?.abort();
        submittingRef.current = false;
        replaceQr(null);
        setPhase('expired');
        setRetrying(false);
      }
    };
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => clearInterval(interval);
  }, [session, phase, replaceQr]);

  async function startLogin() {
    // Ref closes the gap before React renders the disabled button.
    if (submittingRef.current) return;
    submittingRef.current = true;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    const active = () => generationRef.current === generation && !controller.signal.aborted;
    setPhase('submitting');
    setSession(null);
    setError('');
    setRetrying(false);
    replaceQr(null);

    try {
      // Creation is deliberately not retried: a lost response must not enqueue duplicates.
      const response = await request('/api/login-sessions', controller.signal, { method: 'POST' });
      const created = await response.json() as CreatedSession;
      if (!validSession(created) || typeof created.accessToken !== 'string' || !created.accessToken) {
        throw new RequestError('登录服务返回了无效信息，请重新生成二维码。');
      }
      if (!active()) return;
      const { accessToken, pollAfterMs, ...publicSession } = created;
      setSession(publicSession);
      setPhase(publicSession.status);
      setNow(Date.now());
      const path = `/api/login-sessions/${encodeURIComponent(created.id)}`;
      const pollInterval = Number.isFinite(pollAfterMs) ? Math.min(5_000, Math.max(500, pollAfterMs)) : 1_000;
      let current: Session = publicSession;

      while (active()) {
        if (Date.now() >= Date.parse(current.expiresAt)) {
          setPhase('expired');
          break;
        }
        if (current.status === 'failed') {
          throw new RequestError('游戏环境暂时未能准备完成，请重新生成二维码。');
        }
        if (current.status === 'expired') {
          setPhase('expired');
          break;
        }
        if (current.status === 'qr_ready') {
          const qrResponse = await retryRead(`${path}/qr`, accessToken, controller.signal, () => {
            if (active()) setRetrying(true);
          });
          if (!(qrResponse.headers.get('content-type') ?? '').toLowerCase().startsWith('image/png')) {
            throw new RequestError('二维码格式异常，请重新生成二维码。');
          }
          const blob = await qrResponse.blob();
          if (!active()) return;
          if (Date.now() >= Date.parse(current.expiresAt)) {
            setPhase('expired');
            break;
          }
          if (!blob.size) throw new RequestError('二维码图片为空，请重新生成二维码。');
          replaceQr(URL.createObjectURL(blob));
          setPhase('qr_ready');
          setRetrying(false);
          break;
        }
        await delay(pollInterval, controller.signal);
        const next = await retryRead(path, accessToken, controller.signal, () => {
          if (active()) setRetrying(true);
        });
        current = await next.json() as Session;
        if (!validSession(current) || current.id !== created.id) {
          throw new RequestError('登录状态暂时不可用，请重新生成二维码。');
        }
        if (!active()) return;
        setSession(current);
        // Keep showing preparation until the actual image has been retrieved.
        setPhase(current.status === 'qr_ready' ? 'preparing_qr' : current.status);
        setRetrying(false);
      }
    } catch (caught) {
      if (!active()) return;
      replaceQr(null);
      setPhase(caught instanceof RequestError && [404, 410].includes(caught.status) ? 'expired' : 'failed');
      setError(caught instanceof RequestError ? caught.message : '登录状态读取失败，请重新生成二维码。');
      setRetrying(false);
    } finally {
      if (generationRef.current === generation) submittingRef.current = false;
    }
  }

  function handleQrError() {
    replaceQr(null);
    setPhase('failed');
    setError('二维码图片加载失败，请重新生成。');
  }

  const pending = ['submitting', 'queued', 'starting_emulator', 'opening_game', 'preparing_qr'].includes(phase);
  const remainingSeconds = session ? Math.max(0, Math.ceil((Date.parse(session.expiresAt) - now) / 1_000)) : 0;
  const countdown = `${Math.floor(remainingSeconds / 60).toString().padStart(2, '0')}:${(remainingSeconds % 60).toString().padStart(2, '0')}`;
  const step = phase === 'qr_ready' ? 3 : ['opening_game', 'preparing_qr'].includes(phase) ? 2 : pending ? 1 : 0;
  const isError = phase === 'failed' || phase === 'expired';

  return {
    phase,
    session,
    qrUrl,
    error,
    retrying,
    pending,
    remainingSeconds,
    countdown,
    step,
    isError,
    statusLabel: statusLabels[phase],
    startLogin,
    handleQrError,
  };
}
