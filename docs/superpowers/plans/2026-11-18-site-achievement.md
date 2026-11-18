# 全站累计游戏成就实施计划

> 执行：在当前会话协调 worker 与前端并行实现，后端接口由主代理实现；完成后独立审查。

**目标：** `test` 同步 `main`，展示准确的日常加周胜累计成就。

**架构：** worker 复用完成状态 Lua 原子累计无 TTL Hash；网站复用 `TaskRunService` Redis 连接读取两个计数字段，公开接口只返回合计。

**技术：** Python / Redis Lua、TypeScript / Express / React / CSS。

**设计：** [设计说明](../specs/2026-11-18-site-achievement-design.md)

## 约束与审查重点

- 只修改两个项目的 `test`，所有提交信息中文。
- 重复完成、并发、旧 attempt 不双算；失败与出码不算。
- Redis 不可用或脏数据不能显示为零；零次是真实有效值。
- 成就 Hash 无 TTL；任务历史过期不清空累计。
- 桌面、手机、减少动画模式均可用，保持原任务操作正常。

## 任务

- [x] worker：先在 fake Redis 测试首次完成、重复并发、类型/环境隔离与 TTL，再修改 `queue.py`，补充 worker 文档。
- [x] API：先为 `TaskRunService.getAchievements()` 和匿名接口写失败测试，覆盖合计、零、非法计数、连接故障和仅返回总数，再实现服务与路由。
- [x] 前端：新增成就组件、独立 CSS 与浏览器行为测试，挂入 `App.tsx`，验证正常/零/错误/移动端和减少动画。
- [x] 验证：运行相关 Python 测试、网站测试和构建、浏览器检查；独立代码审查后处理问题。
- 交付：检查 diff，分别创建中文提交并推送两个 `origin/test`。

## 验证记录

- 网站 `npm run build`（含类型检查）通过。Vite 保留主包超过 500 kB 的大小提示。
- `tsx --test tests/api.test.ts tests/task-runs.test.ts`：71 项通过。
- 成就 Playwright：6 项通过，覆盖零、加载、失败保留、超时、前台轮询、1280/768/390/320 宽度、最大安全整数和减少动画。原主任务回归 9 个子例通过。
- 旧登录组首次 27 个子例中 `iOS 微信区 persists` 在秘境菜单点击时因元素动画/脱离 DOM 超时；保留原断言隔离复跑通过。
- 网站 `npm test` 首轮 560/562 通过。`port.test.ts` 的“只终止目标端口的监听进程，保留其他端口进程”和“Cloudflare 配置未就绪时启动失败，且不会先清理已有监听进程”超时；另一次单跑出现“Windows 重启开发服务释放配置端口，并退出旧 tsx watch 父进程”超时。最终当前树单跑 5/5，通过；干净基线 `cbbd715` 单跑 5/5，通过，并发运行两次均复现前述端口查询和 watch 退出超时，未改端口逻辑。
- worker 首版完整 `pytest -q`：4599 通过、12 失败。其中新增兼容性问题涉及 `test_failed_login_cleanup_releases_only_its_lock_and_preserves_history` 的 4 个参数及 `test_failed_login_cleanup_never_recreates_or_overwrites_unowned_sessions` 的 5 个参数；已修复旧配置缺少模拟器类型的问题，相关组合 162 项通过，之后补充负数计数覆盖。
- worker 全量另有三个非本次改动失败：`test_daily_transport.py::test_production_sync_request_wall_timeout_closes_real_slow_connection[headers_then_body]` 计时约 0.594 秒低于 0.6 秒断言；`test_navigation_agent.py::test_model_error_after_move_does_not_continue`、`test_navigation_agent.py::test_agent_sdk_does_not_add_retries_after_shared_limit` 分别抛出 HTTP 500/429 的 `MultimodalRequestError`。在未修改的 `main`、相同虚拟环境复查，两个导航失败均复现，计时用例通过。因此不将本次验证表述为全量全绿。
- 独立审查发现 Redis 负计数在递增时可能变为有效零，已增加增量前校验及回归；修复后独立复核 worker 11 项、网站成就接口 3 项通过。审查无剩余阻塞问题。
- worker 最终代码重新运行 `pytest -q tests/test_login_service_redis.py tests/test_login_service_run_logs.py tests/test_login_service_interrupt_completion.py --tb=short`：163 项通过。
