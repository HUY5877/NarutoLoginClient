import { ChevronRight, UsersRound, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import './registration-bubble.css';

const registrationGroup = '993904975';

export function RegistrationNotice({ className, surface = 'page' }: {
  className?: string;
  surface?: 'page' | 'dialog';
}) {
  return <Alert role="note" aria-label="注册审核提醒" className={cn('registration-notice', className)} data-surface={surface}>
    <span className="registration-notice-icon"><UsersRound aria-hidden="true" /></span>
    <div className="registration-notice-copy">
      <div className="registration-notice-heading">
        <AlertTitle>注册后请加</AlertTitle>
        <Badge variant="outline" className="registration-group-badge" aria-label={`QQ 群 ${registrationGroup}`}>
          <span className="registration-group-label">QQ 群</span>
          <strong className="registration-group-number">{registrationGroup}</strong>
        </Badge>
      </div>
      <AlertDescription>
        <span className="registration-notice-description-full">进群找群主审核，陌生账号不予通过。</span>
        <span className="registration-notice-description-compact">陌生申请不批</span>
      </AlertDescription>
    </div>
  </Alert>;
}

export function RegistrationBubble() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="registration-bubble">
          <span className="bubble-heading">注册须知<ChevronRight aria-hidden="true" /></span>
          <span className="bubble-message">注册后请加群，联系群主审核。</span>
          <span className="bubble-group">QQ 群 <strong>{registrationGroup}</strong></span>
        </button>
      </DialogTrigger>
      <DialogContent className="registration-dialog" showCloseButton={false} aria-describedby={undefined}>
        <div className="registration-dialog-heading">
          <DialogTitle>注册须知</DialogTitle>
          <DialogClose asChild>
            <Button type="button" size="icon" variant="ghost" aria-label="关闭"><X aria-hidden="true" /></Button>
          </DialogClose>
        </div>
        <RegistrationNotice surface="dialog" />
      </DialogContent>
    </Dialog>
  );
}
