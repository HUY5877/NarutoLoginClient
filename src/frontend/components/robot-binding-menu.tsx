import { useRef, useState } from 'react';
import { ChevronDown, MessageCircle } from 'lucide-react';
import { OfficialQqBindingDialog } from '@/components/official-qq-binding-dialog';
import { QqBindingDialog } from '@/components/qq-binding-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Props {
  userId: string;
  busy: boolean;
  onUnauthorized: () => void;
}

export function RobotBindingMenu({ userId, busy, onUnauthorized }: Props) {
  const [robot, setRobot] = useState<'huy2' | 'daily' | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingDialogRef = useRef(false);
  const returnFocus = () => { triggerRef.current?.focus(); };

  function openBinding(next: 'huy2' | 'daily') {
    openingDialogRef.current = true;
    setRobot(next);
  }

  return <>
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} type="button" variant="outline" size="sm" disabled={busy} className="gap-1.5 bg-white/50">
          <MessageCircle aria-hidden="true" />QQ 机器人绑定<ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="village-account-menu min-w-56" onCloseAutoFocus={event => {
        if (openingDialogRef.current) { event.preventDefault(); openingDialogRef.current = false; }
      }}>
        <DropdownMenuItem className="py-2" disabled={busy} onSelect={() => openBinding('huy2')}>
          <MessageCircle aria-hidden="true" />绑定HUY2
        </DropdownMenuItem>
        <DropdownMenuItem className="py-2" disabled={busy} onSelect={() => openBinding('daily')}>
          <MessageCircle aria-hidden="true" />绑定HUY的日常小助手
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <QqBindingDialog userId={userId} open={robot === 'huy2'}
      onOpenChange={open => setRobot(open ? 'huy2' : null)} onUnauthorized={onUnauthorized} onReturnFocus={returnFocus} />
    <OfficialQqBindingDialog userId={userId} open={robot === 'daily'}
      onOpenChange={open => setRobot(open ? 'daily' : null)} onUnauthorized={onUnauthorized} onReturnFocus={returnFocus} />
  </>;
}
