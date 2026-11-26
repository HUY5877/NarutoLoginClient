import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight, ListChecks, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { MainTask } from '../../shared/user-options';
import './task-sheet.css';

export function MobileTaskSheet({ open, onOpenChange, children, mainTask = 'daily' }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  mainTask?: MainTask;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const gesture = useRef<{ y: number; time: number; distance: number } | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) { gesture.current = null; setDrag(0); setDragging(false); }
  }, [open]);

  const resetGesture = () => { gesture.current = null; setDrag(0); setDragging(false); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="mobile-task-toggle task-sheet-toggle w-full gap-2" aria-label="任务进度与记录">
          <ListChecks aria-hidden="true" /><span>任务进度与记录</span><ChevronRight aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="mobile-task-sheet task-drawer" showCloseButton={false} data-dragging={dragging}
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
        }}
        onCloseAutoFocus={event => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus({ preventScroll: true });
          }
          opener.current = null;
        }}
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
          <DialogDescription>登录进度、{mainTask === 'arena_weekly' ? '周胜' : '日常'}状态和执行记录</DialogDescription>
        </DialogHeader>
        <DialogClose asChild><Button variant="ghost" size="icon" className="task-sheet-close" aria-label="关闭任务进度"><X aria-hidden="true" /></Button></DialogClose>
        <div className="task-sheet-body">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
