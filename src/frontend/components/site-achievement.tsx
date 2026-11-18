import { useEffect, useId, useState } from 'react';
import './site-achievement.css';

const refreshDelay = 60_000;
const requestTimeout = 5_000;
const achievementNumber = new Intl.NumberFormat('zh-CN');

type AchievementState = { status: 'loading' | 'unavailable' } | { status: 'ready'; total: number };

export function SiteAchievement() {
  const titleId = useId();
  const [achievement, setAchievement] = useState<AchievementState>({ status: 'loading' });

  useEffect(() => {
    let disposed = false;
    let inFlight: AbortController | undefined;
    let interval: number | undefined;
    let timeout: number | undefined;

    async function refresh() {
      if (disposed || inFlight || document.visibilityState !== 'visible') return;
      const controller = new AbortController();
      inFlight = controller;
      timeout = window.setTimeout(() => controller.abort(), requestTimeout);
      try {
        const response = await fetch('/api/achievements', {
          credentials: 'omit', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Achievement statistics unavailable');
        const body: unknown = await response.json();
        const total = body && typeof body === 'object' && 'totalRequests' in body ? body.totalRequests : null;
        if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
          throw new Error('Invalid achievement total');
        }
        if (!disposed) setAchievement({ status: 'ready', total });
      } catch {
        if (!disposed) setAchievement(current => current.status === 'ready' ? current : { status: 'unavailable' });
      } finally {
        window.clearTimeout(timeout);
        inFlight = undefined;
      }
    }

    function refreshWhenVisible() {
      window.clearInterval(interval);
      if (disposed || document.visibilityState !== 'visible') return;
      void refresh();
      interval = window.setInterval(refresh, refreshDelay);
    }

    // The first development StrictMode setup is cleaned up before the microtask runs.
    queueMicrotask(refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refresh);
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      inFlight?.abort();
    };
  }, []);

  const total = achievement.status === 'ready' ? achievementNumber.format(achievement.total) : null;
  return (
    <section className="site-achievement" aria-labelledby={titleId} data-status={achievement.status}>
      <span className="site-achievement-emblem" aria-hidden="true">
        <img src="/icons/leaf-village.svg" alt="" width="24" height="24" />
      </span>
      <div className="site-achievement-copy">
        <h2 id={titleId}>全站成就</h2>
        <p>日常与周胜</p>
      </div>
      <div className="site-achievement-counter" aria-live="polite" aria-atomic="true">
        {total !== null ? <>
          <span className="site-achievement-label">累计申请</span>
          <span className="site-achievement-value" data-long={total.length > 10 ? '' : undefined}>
            <strong>{total}</strong> <span>次</span>
          </span>
        </> : achievement.status === 'loading' ? <>
          <span className="site-achievement-label">正在读取成就统计</span>
          <span className="site-achievement-placeholder" aria-hidden="true" />
        </> : <span className="site-achievement-label">成就统计暂不可用</span>}
      </div>
    </section>
  );
}
