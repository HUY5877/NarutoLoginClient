import { UsersRound } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export function RegistrationNotice({ className, surface = 'page' }: {
  className?: string;
  surface?: 'page' | 'dialog';
}) {
  return <Alert role="note" aria-label="注册审核提醒" className={cn('registration-notice', className)} data-surface={surface}>
    <UsersRound aria-hidden="true" />
    <AlertTitle>注册后请加入 QQ 群 <strong className="registration-group-number">993904975</strong></AlertTitle>
    <AlertDescription>方便群主核对身份，陌生账号的注册申请不会通过。</AlertDescription>
  </Alert>;
}
