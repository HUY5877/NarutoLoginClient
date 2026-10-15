import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';

export function SiteEnvironmentBadge() {
  const [isTestSite, setIsTestSite] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    void fetch('/api/health', { credentials: 'omit', signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!controller.signal.aborted && body !== null && typeof body === 'object'
          && 'environment' in body && body.environment === 'test') {
          setIsTestSite(true);
        }
      })
      .catch(() => { /* Keep the main page usable when the status endpoint is unavailable. */ })
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);

  if (!isTestSite) return null;
  return (
    <Badge variant="outline" className="mt-0.5 flex h-4 border-amber-300/60 bg-amber-200/10 px-1.5 text-[10px] leading-none font-semibold tracking-normal text-amber-100 sm:ml-2 sm:mt-0 sm:inline-flex sm:h-5 sm:text-xs">
      测试站
    </Badge>
  );
}
