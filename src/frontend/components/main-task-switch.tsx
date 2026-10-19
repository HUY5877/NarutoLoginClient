import { ListChecks, LockKeyhole, Swords } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { MainTask } from '../../shared/user-options';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const choices = [
  { value: 'daily', title: '日常任务', Icon: ListChecks },
  { value: 'arena_weekly', title: '决斗场周胜', Icon: Swords },
] as const;

export function MainTaskSwitch({ value, disabled, locked = false, onChange, children }: {
  value: MainTask;
  disabled: boolean;
  locked?: boolean;
  onChange: (value: MainTask) => void;
  children?: ReactNode;
}) {
  const panelId = useId();

  return <Tabs value={value} onValueChange={task => onChange(task as MainTask)}
    activationMode="manual" className="main-task-tabs">
    <div className="main-task-navigation">
      <TabsList variant="line" aria-label="主任务" className="main-task-list">
        {choices.map(({ value: task, title, Icon }) => <TabsTrigger key={task} value={task}
          disabled={disabled || locked} aria-controls={panelId} className="main-task-trigger">
          <Icon aria-hidden="true" className="size-4" />
          {title}
        </TabsTrigger>)}
      </TabsList>
      {locked && <span className="main-task-locked"><LockKeyhole aria-hidden="true" />任务进行中</span>}
    </div>
    <TabsContent id={panelId} value={value} className="main-task-content">{children}</TabsContent>
  </Tabs>;
}

export function ArenaWeeklyBrief() {
  return <section className="arena-weekly-brief" aria-label="决斗场周胜任务">
    <Swords aria-hidden="true" className="size-4" />
    <span className="arena-preview-label">测试中</span>
    <p className="arena-weekly-notice">周胜执行正在接入，当前为客户端测试入口。</p>
  </section>;
}
