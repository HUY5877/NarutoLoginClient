interface ScrollArea { scrollHeight: number; scrollTop: number; clientHeight: number }
interface AreaEvent { currentTarget: ScrollArea }
/** A request consumes its gesture; content changes alone cannot start another read. */
export function createBottomLogLoader(load: () => void, allowed: () => boolean, now = () => performance.now()) {
  let lastRead = -Infinity;
  let gestureUntil = -Infinity;
  let previousTop = 0;
  let touchY: number | undefined;
  const bottom = (area: ScrollArea) => area.scrollHeight - area.scrollTop - area.clientHeight <= 24;
  const request = (area: ScrollArea) => {
    if (!bottom(area)) return;
    gestureUntil = -Infinity;
    if (!allowed() || now() - lastRead < 750) return;
    lastRead = now();
    load();
  };
  const downward = (area: ScrollArea) => {
    previousTop = area.scrollTop;
    gestureUntil = now() + 1500;
    request(area);
  };
  return {
    onScroll({ currentTarget: area }: AreaEvent) {
      if (gestureUntil >= now() && area.scrollTop > previousTop) request(area);
      previousTop = area.scrollTop;
    },
    onWheel(event: AreaEvent & { deltaY: number }) {
      if (event.deltaY > 0) downward(event.currentTarget);
      else gestureUntil = -Infinity;
    },
    onPointerDown(event: AreaEvent & { target?: unknown }) {
      if (event.target && event.target !== event.currentTarget) return;
      previousTop = event.currentTarget.scrollTop; gestureUntil = now() + 1500;
    },
    onTouchStart(event: { touches: ArrayLike<{ clientY: number }> }) { touchY = event.touches[0]?.clientY; },
    onTouchMove(event: AreaEvent & { touches: ArrayLike<{ clientY: number }> }) {
      const y = event.touches[0]?.clientY;
      if (y !== undefined && touchY !== undefined && y < touchY) downward(event.currentTarget);
      else gestureUntil = -Infinity;
      touchY = y;
    },
    onKeyDown(event: AreaEvent & { key: string; shiftKey: boolean; target?: unknown }) {
      if (event.target && event.target !== event.currentTarget) return;
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || event.key === ' ' && !event.shiftKey) downward(event.currentTarget);
      else gestureUntil = -Infinity;
    },
  };
}
