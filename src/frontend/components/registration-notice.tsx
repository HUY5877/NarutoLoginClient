import { UsersRound } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function RegistrationNotice({ className, surface = 'page' }: {
  className?: string;
  surface?: 'page' | 'dialog';
}) {
  return <Alert role="note" aria-label="注册审核提醒" className={cn('registration-notice', className)} data-surface={surface}>
    <span className="registration-notice-icon"><UsersRound aria-hidden="true" /></span>
    <div className="registration-notice-copy">
      <div className="registration-notice-heading">
        <AlertTitle>注册后请加</AlertTitle>
        <Badge variant="outline" className="registration-group-badge" aria-label="QQ 群 993904975">
          <span className="registration-group-label">QQ 群</span>
          <strong className="registration-group-number">993904975</strong>
        </Badge>
      </div>
      <AlertDescription>
        <span className="registration-notice-description-full">进群找群主审核，陌生账号不予通过。</span>
        <span className="registration-notice-description-compact">陌生申请不批</span>
      </AlertDescription>
    </div>
  </Alert>;
}
