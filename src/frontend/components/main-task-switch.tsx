import { ListChecks, LockKeyhole, Swords } from 'lucide-react';
import type { MainTask } from '../../shared/user-options';

const choices = [
  { value: 'daily', title: '日常任务', caption: '每天的事，一次搞定', Icon: ListChecks },
  { value: 'arena_weekly', title: '决斗场周胜', caption: '这次，专注拿周胜', Icon: Swords },
] as const;

export function MainTaskSwitch({ value, disabled, locked = false, onChange }: {
  value: MainTask;
  disabled: boolean;
  locked?: boolean;
  onChange: (value: MainTask) => void;
}) {
  return <fieldset className="main-task-selector" disabled={disabled}>
    <legend className="sr-only">主任务</legend>
    <div className="main-task-selector-heading">
      <span>这次做什么</span>
      {locked && <span className="main-task-locked"><LockKeyhole aria-hidden="true" />本次任务已锁定</span>}
    </div>
    <div className="main-task-track" role="radiogroup" aria-label="主任务">
      {choices.map(({ value: task, title, caption, Icon }) => <label key={task} className="main-task-choice" data-selected={value === task}>
        <input type="radio" name="main-task" value={task} aria-label={title}
          checked={value === task} onChange={() => onChange(task)} />
        <Icon aria-hidden="true" className="main-task-icon" />
        <span className="main-task-choice-copy"><strong>{title}</strong><span>{caption}</span></span>
        <span className="main-task-indicator" aria-hidden="true" />
      </label>)}
    </div>
    {locked && <p className="main-task-lock-hint">任务结束后可切换，刷新二维码会沿用本次选择。</p>}
  </fieldset>;
}

export function ArenaWeeklyBrief() {
  return <section className="arena-weekly-brief" aria-label="决斗场周胜任务">
    <div className="arena-weekly-mark" aria-hidden="true"><Swords /></div>
    <div className="arena-weekly-copy">
      <div className="arena-weekly-eyebrow"><span>本次任务</span><span className="arena-preview-label">测试中</span></div>
      <h2>决斗场周胜</h2>
      <p>专注本周胜场，日常项目不参与本次任务。</p>
      <p className="arena-weekly-notice">周胜执行正在接入，当前为客户端测试入口。</p>
    </div>
    <span className="arena-weekly-wordmark" aria-hidden="true">决</span>
  </section>;
}
