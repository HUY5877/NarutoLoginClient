import { ChevronLeft, ChevronRight, CircleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export function AdminError({ message }: { message: string }) {
  return message ? <Alert variant="destructive" role="alert" className="bg-white/45">
    <CircleAlert aria-hidden="true" /><AlertDescription>{message}</AlertDescription>
  </Alert> : null;
}
export function AdminLoading({ label }: { label: string }) {
  return <div role="status" className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
    <Spinner aria-hidden="true" />{label}
  </div>;
}
export function AdminPagination({ page, pageSize, total, disabled, onPageChange }: {
  page: number; pageSize: number; total: number; disabled: boolean; onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
    <span>共 {total} 条 · 第 {page} 页{page <= pages ? ` / ${pages} 页` : ''}</span>
    <div className="flex gap-2">
      <Button type="button" size="sm" variant="outline" className="min-h-11 px-3 md:min-h-0" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
        <ChevronLeft aria-hidden="true" />上一页
      </Button>
      <Button type="button" size="sm" variant="outline" className="min-h-11 px-3 md:min-h-0" disabled={disabled || page >= pages} onClick={() => onPageChange(page + 1)}>
        下一页<ChevronRight aria-hidden="true" />
      </Button>
    </div>
  </div>;
}
