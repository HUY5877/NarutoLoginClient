# 管理员任务列表一次读取与本地翻页

用户方案：按当前日期、任务类型一次读取全部申请记录；网页本地分页，翻页只读取当前页 Redis runs。管理员权限检查保持。client 直接 main 开发、验证后中文提交并推送。

## 接口约定

- `AdminStore.listDailyEvents(start, end, mainTask?)` 用一条参数化 SELECT 返回全部匹配记录，按 created_at DESC、id DESC 排序；保留 `{items,total}` 返回，total 为 rows.length。不再使用 COUNT、LIMIT/OFFSET 或显式只读事务。
- `GET /api/admin/daily-tasks?date=...&mainTask=...` 返回全部 `DailyTaskPage.items`，保留现有元数据、page=1、pageSize=20。不读取 Redis runs；每项包含已校验的 `userOptions`，以及依据数据库记录产生的基础显示状态。不发送内部凭据。
- `GET /api/admin/daily-tasks/runs?ids=UUID,...` 受同一管理员检查保护。1～20 个不重复 UUID，单次 `getSummaries` 读取 Redis，不访问申请表、不读日志。
- 新 shared 类型 `DailyTaskRun`：taskId、status、startedAt、finishedAt、authorizedAt?、secretRealmCompletedAt?、errorCode?。仅这些字段对外返回，不能发送 workerId、tokenHash、username、内部错误文字。
- 新 shared 类型 `DailyTaskRunPage = {items: Array<{id: string; run: DailyTaskRun | null}>}`。服务端按请求 ID 的顺序返回，run 非空时 taskId 必须匹配 id。
- `DailyTask.userOptions?: UserOptions`。新增 shared `withDailyTaskRun(task: DailyTask, run: DailyTaskRun | null): DailyTask`，复用原有日常完成标记、完成时间、错误提示规则，返回新对象；null 保留已知数据。刷新为非失败状态时清除旧 errorCode/errorMessage。

## 实现与验证

1. 后端：改 Store 单次全量读取、简化 AdminService.dailyTasks、增加只读 runs 路由与参数校验、将现有状态合并逻辑移至 withDailyTaskRun。先补失败测试，再完成实现；原有日常完成规则测试迁移到共享合并函数，不删除覆盖。
2. 前端：申请列表请求路径不随 page 变化；本地 slice 分页，当前页 ID 变更时单独请求 runs；关闭窗口清除本次缓存，日期和任务类型切换重新读取。刷新更新列表与状态，中断提交后只刷新状态。匹配当前页 ID 后才应用状态，取消迟到请求。
3. 验证：使用真实内存 PostgreSQL/PGlite 执行列表 SQL，覆盖多页、同时间排序、筛选、旧选项、空列表和没有额外事务/COUNT；浏览器确认翻页不再次读取申请接口、只读取当前页 runs，筛选/刷新/重开/中断保持正确；运行完整测试和构建，独立审查后提交推送并验证自动发布。

前端不要显示“只查Redis”等实现说明；保留当前布局与分页控件。翻页请求仍验证管理员身份，但不再读取申请表。

## 完成情况

- 已实现单次全量读取和本地分页，当前页状态单独批量更新。相同筛选刷新时保留最后已知的执行结果，同时采用最新账号和备注；关闭或切换筛选清除状态缓存。刷新导致末页消失时同步实际页码。
- 完整 Node 测试 428 项通过，包括真实 PostgreSQL 查询验证；类型检查和前后端构建通过。
- 完整管理员与中断浏览器回归 37 项通过，覆盖桌面和手机、45 条本地翻页、迟到请求取消、筛选切换、刷新与权限失效。
- 独立审查提出的状态缓存、页码同步两项问题已修复，并补充浏览器回归。
