import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronUp, ListChecks, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useMediaQuery } from '@/hooks/use-media-query';

export function MobileTaskSheet({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const mobile = useMediaQuery('(max-width: 639px)');
  const gesture = useRef<{ y: number; time: number; distance: number } | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!mobile && open) onOpenChange(false);
  }, [mobile, open, onOpenChange]);
  useEffect(() => {
    if (!open) { gesture.current = null; setDrag(0); setDragging(false); }
  }, [open]);

  const resetGesture = () => { gesture.current = null; setDrag(0); setDragging(false); };

  return (
    <Dialog open={mobile && open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="mobile-task-toggle mt-3 w-full gap-2 sm:hidden">
          <ListChecks aria-hidden="true" /><span>任务进度与记录</span><ChevronUp aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="mobile-task-sheet" showCloseButton={false} data-dragging={dragging}
        style={{ '--sheet-drag': `${drag}px` } as CSSProperties}>
        <button type="button" className="task-sheet-grip" aria-label="关闭任务进度，可下滑关闭" onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          onOpenChange(false);
        }}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            suppressClick.current = false;
            gesture.current = { y: event.clientY, time: performance.now(), distance: 0 };
            setDragging(true);
          }}
          onPointerMove={event => {
            if (!gesture.current) return;
            const distance = Math.max(0, event.clientY - gesture.current.y);
            gesture.current.distance = distance;
            if (distance > 6) suppressClick.current = true;
            setDrag(distance);
          }}
          onPointerUp={event => {
            if (!gesture.current) return;
            const { distance, time } = gesture.current;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            if (distance > 100 || distance > 36 && distance / Math.max(1, performance.now() - time) > 0.5) onOpenChange(false);
            resetGesture();
          }}
          onPointerCancel={() => { suppressClick.current = false; resetGesture(); }}
          onLostPointerCapture={resetGesture}>
          <span aria-hidden="true" />
        </button>
        <DialogHeader className="task-sheet-heading">
          <DialogTitle>本次任务</DialogTitle>
          <DialogDescription>登录进度、日常状态和执行记录</DialogDescription>
        </DialogHeader>
        <DialogClose asChild><Button variant="ghost" size="icon" className="task-sheet-close" aria-label="关闭任务进度"><X aria-hidden="true" /></Button></DialogClose>
        <div className="task-sheet-body">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
