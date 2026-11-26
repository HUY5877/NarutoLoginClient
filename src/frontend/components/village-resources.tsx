import type { ReactNode } from 'react';
import { ScrollText, Trophy, X, type LucideIcon } from 'lucide-react';
import { RegistrationNotice } from '@/components/registration-notice';
import { SiteAchievement } from '@/components/site-achievement';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import './village-resources.css';

function ResourceDialog({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="village-resource-trigger" aria-label={title} title={title}>
          <Icon aria-hidden="true" /><span>{title}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="village-resource-dialog" showCloseButton={false} aria-describedby={undefined}>
        <div className="village-resource-heading">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose asChild>
            <Button type="button" size="icon" variant="ghost" aria-label="关闭"><X aria-hidden="true" /></Button>
          </DialogClose>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function VillageResources() {
  return (
    <div className="village-resources" role="group" aria-label="站点信息">
      <ResourceDialog title="全站成就" icon={Trophy}><SiteAchievement /></ResourceDialog>
      <ResourceDialog title="注册须知" icon={ScrollText}><RegistrationNotice surface="dialog" /></ResourceDialog>
    </div>
  );
}
