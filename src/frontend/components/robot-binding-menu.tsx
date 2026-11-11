import { useRef, useState } from 'react';
import { ChevronDown, CircleHelp, MessageCircle } from 'lucide-react';
import { OfficialQqBindingDialog } from '@/components/official-qq-binding-dialog';
import { QqBindingDialog } from '@/components/qq-binding-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

type BindingRobot = 'huy2' | 'daily';

const choices: Array<{ id: BindingRobot; label: string; title: string; description: string; steps: string }> = [
  {
    id: 'huy2', label: '绑定HUY2', title: '聊天申请，二维码私发本人',
    description: '绑定 QQ 号后，可在群聊或私聊向 HUY2 申请本人的游戏二维码，二维码会私聊发给你。',
    steps: '绑定方式：发送绑定码后自动完成，无需回网页确认。',
  },
  {
    id: 'daily', label: '绑定HUY的日常小助手', title: '二维码就绪、任务结束时 @你',
    description: '绑定群内身份后，在二维码准备好和任务结束时，由 HUY的日常小助手在群里 @你。',
    steps: '绑定方式：在群内发送绑定码完成验证，再回网页点击“确认绑定”。',
  },
];

interface Props {
  userId: string;
  busy: boolean;
  onUnauthorized: () => void;
}

export function RobotBindingMenu({ userId, busy, onUnauthorized }: Props) {
  const [robot, setRobot] = useState<BindingRobot | null>(null);
  const [helpRobot, setHelpRobot] = useState<BindingRobot | null>(null);
  const [helpOffset, setHelpOffset] = useState(8);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Partial<Record<BindingRobot, HTMLDivElement | null>>>({});
  const openingDialogRef = useRef(false);
  const returnFocus = () => { triggerRef.current?.focus(); };

  function openBinding(next: BindingRobot) {
    openingDialogRef.current = true;
    setRobot(next);
  }

  function showHelp(next: BindingRobot) {
    const menu = menuRef.current?.getBoundingClientRect();
    const item = itemRefs.current[next]?.getBoundingClientRect();
    // Keep the explanation below the whole menu, leaving both options reachable.
    setHelpOffset(menu && item ? Math.max(8, menu.bottom - item.bottom + 8) : 8);
    setHelpRobot(next);
  }

  return <TooltipProvider delayDuration={180}>
    <DropdownMenu modal={false} onOpenChange={open => { if (!open) setHelpRobot(null); }}>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} type="button" variant="outline" size="sm" disabled={busy} className="gap-1.5 bg-white/50">
          <MessageCircle aria-hidden="true" />绑定QQ<ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={menuRef} align="end" className="village-account-menu w-72 max-w-[calc(100vw-2rem)] p-1.5" onCloseAutoFocus={event => {
        if (openingDialogRef.current) { event.preventDefault(); openingDialogRef.current = false; }
      }}>
        {choices.map(choice => <Tooltip key={choice.id} open={helpRobot === choice.id} onOpenChange={open => {
          if (open) showHelp(choice.id);
          else setHelpRobot(current => current === choice.id ? null : current);
        }}>
          <TooltipTrigger asChild>
            <DropdownMenuItem ref={element => { itemRefs.current[choice.id] = element; }}
              className="gap-2 rounded-lg py-1 pr-1 pl-2.5" disabled={busy} onSelect={() => openBinding(choice.id)}>
              <MessageCircle className="text-primary" aria-hidden="true" /><span className="font-medium">{choice.label}</span>
              <span data-binding-help={choice.id} aria-hidden="true"
                className="ml-auto inline-flex size-8 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                onPointerDown={event => { event.stopPropagation(); }}
                onPointerUp={event => { event.stopPropagation(); }}
                onClick={event => { event.preventDefault(); event.stopPropagation(); showHelp(choice.id); }}>
                <CircleHelp className="size-4" />
              </span>
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" sideOffset={helpOffset} collisionPadding={16}
            className="z-[60] block w-72 max-w-[calc(100vw-2rem)] space-y-2 rounded-xl p-4 text-left text-xs leading-relaxed shadow-xl">
            <p className="text-sm font-semibold">{choice.title}</p>
            <p>{choice.description}</p>
            <p className="border-t border-background/15 pt-2 text-background/80">{choice.steps}</p>
          </TooltipContent>
        </Tooltip>)}
      </DropdownMenuContent>
    </DropdownMenu>
    <QqBindingDialog userId={userId} open={robot === 'huy2'}
      onOpenChange={open => setRobot(open ? 'huy2' : null)} onUnauthorized={onUnauthorized} onReturnFocus={returnFocus} />
    <OfficialQqBindingDialog userId={userId} open={robot === 'daily'}
      onOpenChange={open => setRobot(open ? 'daily' : null)} onUnauthorized={onUnauthorized} onReturnFocus={returnFocus} />
  </TooltipProvider>;
}
