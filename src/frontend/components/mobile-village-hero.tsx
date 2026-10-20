import { useEffect, useRef } from 'react';
import { KonanPortrait } from '@/components/konan-portrait';

export function MobileVillageHero() {
  const scene = useRef<HTMLElement>(null);

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 639px)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const update = () => {
      frame = 0;
      const shift = mobile.matches && !reducedMotion.matches ? Math.min(window.scrollY, 360) : 0;
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
    <section ref={scene} className="mobile-village-hero" aria-label="小南立绘">
      <div className="mobile-character-scene" aria-hidden="true">
        <KonanPortrait className="mobile-character" decorative />
      </div>
    </section>
  );
}
