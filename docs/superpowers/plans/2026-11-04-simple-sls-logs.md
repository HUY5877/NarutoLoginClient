# 简化 SLS 日志读取与上传实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按用户方案删除日志上传检查点和完整性核对，一次 SLS 查询即返回可读内容，滚动到底继续追加。

**Architecture:** ADB 仅批量上传普通日志；网站按任务、环境和最后已读编号直接查询正文。保留身份校验、日志脱敏和编号去重，删除检查点、固定结束快照、总条数核对；Ctrl+C 排空待传日志。

**Tech Stack:** Python/asyncio、TypeScript/Express/React、阿里云 SLS。

**Spec:** 用户本轮请求及补充的分支要求：ADB 功能分支开发后合并 main；client 直接 main 开发。用户已明确指定实现方向，按该方案直接执行。

## Global Constraints

- 不新建 worktree。ADB 使用 `codex/simplify-sls-logs`；client 使用 `main`。
- 不读取或输出用户日志正文、凭据；只用测试数据验证新逻辑。
- 每次请求最多一次 SLS 查询，不再查询 checkpoint、count、firstId、throughId 或上传完整性。
- 保留任务归属、管理员权限、环境隔离、公开日志过滤；不更改游戏执行与任务并发控制。
- 底部滚动/继续下滑时读取新内容；空响应不是永久结束，后续仍可读取；已有内容保留并按 ID 去重。
- 操作限于代码与测试；不自动重启生产 ADB worker。
- 本地相关检查通过并审查 diff 后使用中文提交。client 按授权推送 origin/main；ADB 合并 main。

## Interfaces

- SLS `TaskLogArchive.read(taskId, after, tail?)` 只查正文，返回 `{ logs, nextCursor, hasMore, truncated }`；`hasMore` 仅可由批量上限推导，不再另查数量。
- 管理员接口请求只带 `after`；返回 `DailyTaskLogPage = { taskId, status, logs, nextCursor }`。不返回 snapshotCursor、页数或上传等待标记。
- 普通任务进度接口保留原有状态结构以免影响游戏进度；日志可部分返回，不等 logCursor。
- 保留普通日志 id、streamMs、streamSeq 和 kind:event 以兼容历史日志、支持排序和去重。
- Redis 的状态 sequence、战斗 executionCheckpoint 属于执行控制，不是 SLS 上传检查点，不删除。
- Redis logCursor 可用于重启后生成不重复的日志编号，不再作为客户端读取的完整性门槛。

## Review Focus

- SLS 部分可用/空响应时立即展示可用数据，下次用户滚动仍能刷新。
- 全页隐藏或坏日志不能造成游标卡死或泄露内部内容。
- 连续 wheel/touch/scroll 不能并发重复请求，也不能在打开时自动循环把全部日志拉完。
- 关闭弹窗/切账号/权限失效后停止旧请求并清除对应数据。
- Ctrl+C、多次取消、上传失败重试不丢失已接受的缓冲日志。

### Task 1: 网站后端单次查询

**Files:** `src/server/sls-logs.ts`、`src/server/task-runs.ts`、`src/server/app.ts`、`src/server/admin.ts`、`src/shared/admin.ts` 与对应后端测试。

- [ ] 先将旧完整性测试改为一次查询、无检查点/部分数据直接展示、真实超时明确报读取失败的断言，并确认测试失败。
- [ ] 删除多阶段查询及水位比较，接入简单游标读取，管理员采用上面的最小返回结构。
- [ ] 更新受影响接口测试和服务端打包测试；运行后端定向测试和类型检查。

### Task 2: 网页底部继续读取

**Files:** `src/frontend/lib/admin-task-logs.ts`、`hooks/use-admin-task-logs.ts`、`components/admin-task-log-details.tsx`、`lib/task-run.ts`、`components/task-run-panel.tsx` 与前端/浏览器测试。

- [ ] 先补空页后再取到日志、追加去重、关闭取消、向下滚动触发的失败测试。
- [ ] 移除快照和 hasMore 对管理员读取的限制，用户滚动到底继续刷新；保留手动读取入口和错误重试。
- [ ] 普通任务日志保留执行中进度更新，结束后用户仍能向下刷新迟到日志；不因缺少上传水位而等待。
- [ ] 更新浏览器假接口和交互测试，覆盖鼠标、触屏、键盘、空结果和失败保留旧日志。

### Task 3: ADB 只上传正文并排空退出

**Files:** `E:/code/NarutoDailyADB/naruto_daily/login_service/sls_logs.py` 及调用方、上传/关闭测试和 README。

- [ ] 先写无 checkpoint/firstId/throughId/entryCount、重试不改 ID、Ctrl+C 排空的测试并确认旧代码失败。
- [ ] 删除 checkpoint、累计上传计数和关联状态，简化有界日志队列，保留稳定 ID 与后台上传。
- [ ] 保留退出排空与取消处理；不要删除战斗状态刷新或并发控制的 checkpoint。
- [ ] 运行定向测试和可用的全量检查；不连接真实服务。

### Task 4: 联合验证与提交

- [ ] 运行 client `npm test`、`npm run build` 和相关浏览器测试。
- [ ] 运行 ADB 项目既有测试，记录无法执行或原有失败。
- [ ] 独立审查两个仓库的最终 diff，修复与本次需求相关的问题。
- [ ] 两端中文提交；ADB 功能分支合并 main；client 推送 origin/main；核对最终状态并报告是否部署。
