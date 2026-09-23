import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type SessionStatus =
  | 'queued'
  | 'starting_emulator'
  | 'opening_game'
  | 'preparing_qr'
  | 'qr_ready'
  | 'failed'
  | 'expired';
type Phase = 'idle' | 'submitting' | SessionStatus;

interface Session {
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

function Icon({ name, className = '' }: {
  name: 'leaf' | 'arrow' | 'scan' | 'check' | 'refresh' | 'shield' | 'phone' | 'clock';
  className?: string;
}) {
  const paths: Record<string, ReactNode> = {
    leaf: <><path d="M18.6 5.4c-6.4-1.7-13.4 2.1-13.4 8.2 0 3.4 3 5.7 5.8 4.3 3.5-1.8 3.5-6.8.1-7.2-2.1-.2-3.2 2.4-1.5 3.6" /><path d="m5 19 5-4M18.6 5.4l-1.1 8.2" /></>,
    arrow: <><path d="M4 12h15M13 6l6 6-6 6" /></>,
    scan: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 12h18" /><path d="M8 8h2v2H8zm6 6h2v2h-2z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6z" /><path d="m8 12 3 3 5-6" /></>,
    phone: <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 5h4m-3 14h2" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function ScrollArt() {
  return (
    <div className="scroll-art" aria-hidden="true">
      <span className="art-coordinate">木ノ葉 · 修行手帖</span>
      <svg viewBox="0 0 560 280" className="landscape">
        <defs>
          <linearGradient id="mountain-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#a3b4b7" stopOpacity=".35" />
            <stop offset="1" stopColor="#a3b4b7" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx="336" cy="126" r="84" fill="none" stroke="#bac7c8" strokeWidth=".8" />
        <circle cx="336" cy="126" r="102" fill="none" stroke="#bac7c8" strokeWidth=".6" strokeDasharray="2 8" />
        <circle cx="336" cy="126" r="66" fill="#e2e8e8" />
        <path d="M337 83c-36-10-75 11-75 45 0 19 17 32 33 24 19-10 19-38 0-40-12-1-18 13-8 20m-26 48 27-29m49-68-6 45" fill="none" stroke="#607a7e" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M0 213 77 159l53 29 67-80 97 114 79-45 61 31 61-63 65 73v62H0Z" fill="url(#mountain-fade)" />
        <path d="M0 245c109-42 151 22 262-8s179-44 298-3M32 258c109-17 202 21 312-7" fill="none" stroke="#a4b9bb" strokeWidth="1" opacity=".55" />
        <path d="m93 115 18-9-8 19-10-10m10 10 20 1m-20-1-1 19" fill="none" stroke="#cf7445" strokeWidth="1.5" />
        <path d="m463 81 10-4-5 11-5-7m5 7 11 2" fill="none" stroke="#cf7445" strokeWidth="1.2" />
        <path d="M56 226h24m-12-12v24M461 156h14m-7-7v14" stroke="#8da1a4" strokeWidth="1" />
      </svg>
      <span className="art-stamp">日<br />常</span>
      <span className="art-caption">每一次出发，都是新的修行。</span>
    </div>
  );
}

export default function App() {
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

  const pending = ['submitting', 'queued', 'starting_emulator', 'opening_game', 'preparing_qr'].includes(phase);
  const remainingSeconds = session ? Math.max(0, Math.ceil((Date.parse(session.expiresAt) - now) / 1_000)) : 0;
  const countdown = `${Math.floor(remainingSeconds / 60).toString().padStart(2, '0')}:${(remainingSeconds % 60).toString().padStart(2, '0')}`;
  const step = phase === 'qr_ready' ? 3 : ['opening_game', 'preparing_qr'].includes(phase) ? 2 : pending ? 1 : 0;
  const isError = phase === 'failed' || phase === 'expired';

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand" aria-label="忍者日常">
          <span className="brand-mark"><Icon name="leaf" /></span>
          <span>忍者日常<span className="brand-en">NINJA DAILY</span></span>
        </div>
        <span className="header-divider" />
        <span className="page-label">登录中心</span>
        <span className="environment-tag"><span />本地模拟模式</span>
      </header>

      <main className="login-layout">
        <section className="intro" aria-labelledby="intro-title">
          <div className="eyebrow"><span className="short-rule" />今天，也要向前一步</div>
          <h1 id="intro-title">日常修行，<br />从这里<span className="title-accent">开始。</span></h1>
          <p className="intro-copy">为熟悉的忍者世界，留一点时间。<br />准备你的登录二维码，让今天的冒险就位。</p>
          <ScrollArt />
          <div className="intro-note"><Icon name="shield" /><span>无需输入账号密码<span className="note-divider">/</span>每次申请独立准备</span></div>
        </section>

        <section className="login-card" aria-labelledby="login-title">
          <div className="card-topline"><span>ACCOUNT ACCESS</span><span className="card-seal">登 录</span></div>
          <div className="card-heading">
            <h2 id="login-title">扫码登录</h2>
            <p>火影忍者手游 · 与安卓好友玩</p>
          </div>
          <div className="login-channel"><span className="channel-icon"><Icon name="phone" /></span><span>安卓 QQ 区</span><span className="channel-fixed">当前登录方式</span></div>

          <div className={`qr-stage ${qrUrl ? 'has-qr' : ''} ${isError ? 'has-error' : ''}`} aria-busy={pending}>
            <span className="corner corner-tl" /><span className="corner corner-tr" /><span className="corner corner-bl" /><span className="corner corner-br" />
            {qrUrl && phase === 'qr_ready' ? (
              <img className="qr-image" src={qrUrl} alt="本地模拟登录二维码，仅用于流程演示，不能登录真实账号" onError={() => {
                replaceQr(null);
                setPhase('failed');
                setError('二维码图片加载失败，请重新生成。');
              }} />
            ) : (
              <div className="qr-placeholder">
                <div className={`scan-symbol ${pending ? 'is-preparing' : ''}`}>
                  <Icon name={isError ? 'refresh' : 'scan'} />
                  {pending && <span className="scan-line" />}
                </div>
                <span className="placeholder-title">{isError ? (phase === 'expired' ? '已超过有效时间' : '准备遇到了一点问题') : pending ? '正在为你准备' : '你的冒险，即将开启'}</span>
                <span className="placeholder-hint">{isError ? '点击下方按钮重新生成' : pending ? '首次准备可能需要一点时间' : '点击下方按钮生成二维码'}</span>
              </div>
            )}
          </div>

          <div className={`status-message ${isError ? 'status-error' : ''}`} role="status" aria-live="polite" aria-atomic="true">
            {pending ? <span className="status-spinner" aria-hidden="true" /> : phase === 'qr_ready' ? <Icon name="check" /> : <span className="status-dot" />}
            <span>{retrying ? '连接暂时中断，正在重试…' : statusLabels[phase]}</span>
            {phase === 'qr_ready' && <span className="countdown" aria-label={`剩余 ${remainingSeconds} 秒`}><Icon name="clock" />{countdown}</span>}
          </div>
          {error && phase === 'failed' && <p className="error-detail" role="alert">{error}</p>}
          <button className="generate-button" type="button" onClick={() => { void startLogin(); }} disabled={pending}>
            <span>{pending ? '正在生成二维码…' : phase === 'idle' ? '生成登录二维码' : '重新生成二维码'}</span>
            <Icon name={phase === 'idle' ? 'arrow' : 'refresh'} />
          </button>
          <p className="simulation-note"><span className="simulation-label">模拟演示</span>当前二维码仅用于验证流程，不能授权真实账号。</p>

          <ol className="progress-steps" aria-label="二维码准备进度">
            {['提交申请', '准备游戏', '获取二维码'].map((label, index) => (
              <li key={label} className={step > index + 1 || phase === 'qr_ready' ? 'is-complete' : step === index + 1 ? 'is-current' : ''} aria-current={step === index + 1 && pending ? 'step' : undefined}>
                <span className="step-marker">{step > index + 1 || phase === 'qr_ready' ? <Icon name="check" /> : index + 1}</span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
          {session && <details className="session-details"><summary>查看本次申请</summary><div><span>申请编号</span><code>{session.id}</code></div><p>关闭页面后，可重新生成新的登录二维码。</p></details>}
        </section>
      </main>

      <footer className="site-footer"><span>忍者日常 · 每天一点，慢慢变强。</span><span className="footer-mode">当前为开发预览 · 登录流程模拟中</span></footer>
    </div>
  );
}
