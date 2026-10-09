import { useEffect, useId, useRef, useState } from 'react';

const portraitSrc = '/images/konan-cel.webp';

export function KonanPortrait({ className, decorative = false }: {
  className: string;
  decorative?: boolean;
}) {
  const portrait = useRef<HTMLDivElement>(null);
  const [animated, setAnimated] = useState(false);
  const id = `konan-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useEffect(() => {
    const node = portrait.current;
    if (!node) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let onScreen = false;
    const update = () => setAnimated(onScreen && !document.hidden && !reducedMotion.matches);
    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      update();
    });
    observer.observe(node);
    document.addEventListener('visibilitychange', update);
    reducedMotion.addEventListener('change', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      reducedMotion.removeEventListener('change', update);
    };
  }, []);

  return (
    <div ref={portrait} className={`konan-portrait ${className}`} data-animated={animated}
      role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : '小南戴着纸花，身穿晓袍，纸蝶在指尖轻轻扇动'}>
      <div className="konan-portrait-motion">
        <img className="konan-portrait-base" src={portraitSrc} alt="" width="1024" height="1536" fetchPriority="high" aria-hidden="true" />
        <svg className="konan-portrait-art" viewBox="0 0 1024 1536" preserveAspectRatio="xMaxYMax meet" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={`${id}-cloth-fade`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="620" y2="850">
              <stop offset="0" stopColor="black" /><stop offset="1" stopColor="white" />
            </linearGradient>
            <mask id={`${id}-cloth-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1536">
              <rect width="1024" height="1536" fill={`url(#${id}-cloth-fade)`} />
              {/* Keep exposed skin still while the fabric moves around it. */}
              <path d="M651 362H804L850 707H703Z M505 962H665L694 1260H540Z M438 1220H546V1420H420Z" fill="black" />
            </mask>
            <filter id={`${id}-cloth-wave`} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
              <feTurbulence type="fractalNoise" baseFrequency="0.007 0.025" numOctaves="1" seed="4" result="cloth-noise" />
              <feDisplacementMap in="SourceGraphic" in2="cloth-noise" scale="0" xChannelSelector="R" yChannelSelector="G">
                {animated && <animate attributeName="scale" values="0;12;0" dur="7s" repeatCount="indefinite" />}
              </feDisplacementMap>
            </filter>
          </defs>
          <g mask={`url(#${id}-cloth-mask)`}>
            <image href={portraitSrc} width="1024" height="1536" filter={`url(#${id}-cloth-wave)`} />
          </g>
          <g transform="translate(747 363) rotate(-18)">
            <g className="konan-butterfly-float">
              <g className="konan-butterfly-wing konan-butterfly-wing-left">
                <path d="M0 0L-54-62-47-7-23 12Z" fill="#faf5ef" stroke="#978aa4" strokeWidth="2" />
                <path d="M0 0L-54-62-23 12Z" fill="#d9d0df" />
                <path d="M0 0L-31 22-10 34Z" fill="#eee6f2" stroke="#978aa4" strokeWidth="2" />
              </g>
              <g className="konan-butterfly-wing konan-butterfly-wing-right">
                <path d="M0 0L54-62 47-7 23 12Z" fill="#fffaf4" stroke="#978aa4" strokeWidth="2" />
                <path d="M0 0L54-62 23 12Z" fill="#e2d9e7" />
                <path d="M0 0L31 22 10 34Z" fill="#f6eef7" stroke="#978aa4" strokeWidth="2" />
              </g>
              <path d="M0-8 3 4 0 18-3 4Z" fill="#88778f" />
            </g>
          </g>
          <g transform="translate(882 220)">
            <g className="konan-paper-piece konan-paper-piece-one">
              <path d="M0 0L37-17 27 30Z" fill="#faf5ef" /><path d="M0 0L27 30 15 7Z" fill="#c9bcd5" />
            </g>
          </g>
          <g transform="translate(158 941) rotate(-20)">
            <g className="konan-paper-piece konan-paper-piece-two">
              <path d="M0 0L43 21 8 55Z" fill="#faf5ef" /><path d="M0 0L8 55 18 23Z" fill="#d4c6dc" />
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}
