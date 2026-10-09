import { useEffect, useState, type CSSProperties } from 'react';

// Fixed seeds keep the scene stable when login status re-renders the page.
const particles = Array.from({ length: 28 }, (_, index) => {
  const leaf = index < 10;
  const duration = leaf ? 23 + index % 7 * 2 : 17 + index % 9 * 2;
  return {
    kind: leaf ? 'leaf' : 'mote',
    style: {
      left: `${(index * 37 + 8) % 100}%`,
      '--particle-size': `${leaf ? 10 + index % 4 * 2 : 2 + index % 3}px`,
      '--particle-duration': `${duration}s`,
      '--particle-delay': `${-((index * 13 + 5) % duration)}s`,
      '--particle-drift': `${leaf ? 65 + index % 5 * 24 : -35 + index % 5 * 18}px`,
      '--particle-sway': `${5 + index % 4}s`,
      '--particle-turn': `${index * 43 % 180}deg`,
      '--particle-opacity': leaf ? 0.58 : 0.72,
    } as CSSProperties,
  };
});

export function VillageParticles() {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const updateVisibility = () => setPaused(document.hidden);
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  return (
    <div className="village-particles" aria-hidden="true" data-paused={paused ? 'true' : undefined}>
      {particles.map(({ kind, style }, index) => (
        <span key={index} className={`village-particle village-particle--${kind}`} style={style}>
          <span className="village-particle-shape" />
        </span>
      ))}
    </div>
  );
}
