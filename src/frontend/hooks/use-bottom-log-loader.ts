import { useMemo, useRef } from 'react';
import { createBottomLogLoader } from '@/lib/log-scroll';

export function useBottomLogLoader(allowed: boolean, load: () => void, identity: string) {
  const latest = useRef({ allowed, load });
  latest.current = { allowed, load };
  return useMemo(() => createBottomLogLoader(() => latest.current.load(), () => latest.current.allowed), [identity]);
}
