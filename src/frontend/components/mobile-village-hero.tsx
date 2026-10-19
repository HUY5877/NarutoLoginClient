import { useEffect, useRef } from 'react';
import { ChakraSeal } from '@/components/chakra-seal';
import { KonanPortrait } from '@/components/konan-portrait';
import { DEFAULT_LOGIN_TYPE, loginScanApp, loginTypeLabels, type LoginType } from '../../shared/login-types';
import type { MainTask } from '../../shared/user-options';

export function MobileVillageHero({ loginType = DEFAULT_LOGIN_TYPE, mainTask = 'daily' }: { loginType?: LoginType; mainTask?: MainTask }) {
  const scene = useRef<HTMLElement>(null);
  const arena = mainTask === 'arena_weekly';

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 639px)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const update = () => {
      frame = 0;
      const shift = mobile.matches && !reducedMotion.matches ? Math.min(window.scrollY, 360) : 0;
      scene.current?.style.setProperty('--scene-shift', `${shift * 0.13}px`);
      scene.current?.style.setProperty('--portrait-shift', `${shift * 0.07}px`);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const configure = () => {
      window.removeEventListener('scroll', schedule);
      window.cancelAnimationFrame(frame);
      frame = 0;
      if (mobile.matches && !reducedMotion.matches) window.addEventListener('scroll', schedule, { passive: true });
      update();
    };
    mobile.addEventListener('change', configure);
    reducedMotion.addEventListener('change', configure);
    configure();
    return () => {
      window.removeEventListener('scroll', schedule);
      mobile.removeEventListener('change', configure);
      reducedMotion.removeEventListener('change', configure);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section ref={scene} className="mobile-village-hero" aria-labelledby="mobile-welcome-title">
      <div className="mobile-hero-wordmark" aria-hidden="true">忍</div>
      <div className="mobile-hero-copy">
        <p className="mobile-game-label">火影忍者手游</p>
        <h1 id="mobile-welcome-title">{arena ? '上场，' : '上号，'}<br /><em>{arena ? '拿下周胜。' : '清日常。'}</em></h1>
        <p className="mobile-hero-caption">手机{loginScanApp(loginType)}扫码<br />{arena ? '这次只为决斗场周胜' : '登录后自动接着跑'}</p>
      </div>
      <div className="mobile-character-scene" aria-hidden="true">
        <ChakraSeal active className="hero-chakra-seal" />
        <div className="mobile-chakra-light" />
        <KonanPortrait className="mobile-character" decorative />
      </div>
      <div className="mobile-scene-footer">
        <span className="mobile-region"><i />{loginTypeLabels[loginType]}</span>
        <img src="/icons/shuriken.svg" alt="" width="18" height="18" aria-hidden="true" />
      </div>
    </section>
  );
}
