# 忍者日常登录中心

React 前端与 TypeScript API 共用一个站点。用户扫码登录后，由配套的 NarutoDailyADB 执行端完成日常任务。

## 启动

需要 Node.js 22.12+、npm，以及 PostgreSQL、Redis 和 Cloudflare KV。首次安装后，将 `.env.example` 复制为 `.env`，填写环境选择和 Cloudflare 引导配置；已有 `.env` 请保留。

```powershell
npm ci
npm run dev
```

页面与 API 共用一个端口，由选定 Cloudflare namespace 的 `PORT` 决定。启动命令在完整加载、验证云配置后，才清理占用此端口的旧进程。

## 环境与 Cloudflare 配置

本地 `.env` 和 Vercel 环境变量仅保存环境选择和 Cloudflare 引导信息。`APP_ENV` 只能为 `prod` 或 `test`，缺省 `prod`；两套配置共用 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，分别设置 `CLOUDFLARE_KV_NAMESPACE_ID_PROD` 和 `CLOUDFLARE_KV_NAMESPACE_ID_TEST`。API Token 需具备选定 namespace 的 KV 读取权限。凭据只由后端读取，不使用 `VITE_` 变量。

正式与测试使用两个独立 namespace，各自保存普通字符串键，键名保持一致，例如 `REDIS_QUEUE_KEY`、`DATABASE_URL`。`APP_ENV=test` 只读取测试 namespace；缺少测试 namespace ID 或配置时，不会读取正式 namespace，也不会回退本地已有的业务环境变量。正式环境优先使用 `CLOUDFLARE_KV_NAMESPACE_ID_PROD`，也兼容旧的 `CLOUDFLARE_KV_NAMESPACE_ID`。环境选择、账号、Token 和 namespace ID 始终只来自本地引导信息，不能被远端业务键覆盖。

`main` 与 `codex/jev-multimodal-test` 使用同一套启动和配置代码，运行时通过 `APP_ENV=prod` / `APP_ENV=test` 选择对应 namespace。分支名不决定运行环境，资源值的差异保存在各自 namespace 中；本地测试需将未提交的 `.env` 中 `APP_ENV` 设为 `test`。

本地和 Vercel 入口都先加载所选 namespace 的完整配置，再创建 Redis、数据库与 OSS 依赖。每个进程只加载一次；KV 更新后需重启或重新部署。缺少引导信息、读取失败、配置无效或缺少 `REDIS_QUEUE_KEY`、`OSS_KEY_PREFIX`、`PORT`、`SESSION_COOKIE_NAME`、`STORAGE_DRIVER` 时，启动失败；`local` 模式还必须提供 `LOCAL_OBJECTS_DIR`。缺少数据库、Redis 或 JWT 时，相应接口继续返回未配置错误。

下表列出各 namespace 内的普通业务键名。

| 配置 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL，保存账号、审批与申请记录 |
| `JWT_SECRET` | 至少 32 字节的随机签名密钥，同环境保持一致 |
| `REDIS_URL` | 与 ADB 执行端连接同一实例、同一 DB |
| `STORAGE_DRIVER` | 必填；线上使用 `oss`，本地模拟可用 `local` |
| `OSS_REGION`、`OSS_BUCKET` | 二维码所在区域与私有 Bucket |
| `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` | 后端读取 OSS 的凭据 |
| `REDIS_QUEUE_KEY` | 环境独立的任务队列；会话、锁、刷新指令、执行状态与日志均由此派生 |
| `OSS_KEY_PREFIX` | 环境独立的二维码对象前缀，必须显式配置 |
| `SESSION_COOKIE_NAME` | 必填；正式配置 `naruto_session`，同域测试站配置独立名称 |
| `HOST`、`PORT` | 本地监听地址及端口；`HOST` 缺省 `127.0.0.1`，`PORT` 必填 |
| `LOCAL_OBJECTS_DIR` | `local` 模式必填的存储根目录，最终路径仍包含 `OSS_KEY_PREFIX` |
| `REQUEST_TIMEOUT_MS`、`SESSION_TTL_MS` | 依赖请求超时与排队有效期，缺省 5000 / 300000 毫秒 |
| `OSS_STS_TOKEN`、`ALLOWED_ORIGINS` | 可选的 OSS 临时凭证、逗号分隔的额外允许来源 |

客户端与同环境 ADB 执行端的 Redis 实例、Redis DB、`REDIS_QUEUE_KEY`、Bucket 和 `OSS_KEY_PREFIX` 必须一致。PostgreSQL 使用同服务器、同账号上的独立数据库；Redis 可共用 DB 并用配置前缀隔离，或配置独立 DB，两端必须一致。前缀与端口的具体值由 Cloudflare 配置决定，业务代码不拼接测试后缀。测试 Cookie 也应在测试 namespace 中设置独立名称，避免同域不同端口覆盖登录状态。引导示例见 [.env.example](.env.example)，密钥不要提交到 Git。

当前测试 namespace 的 `OSS_BUCKET` 配置为 `huy1-hyrz-test`，测试客户端与执行端均读取该配置。

正式账号库为 `naruto_login`，测试使用独立的 `naruto_login_test`。数据库由运维预先创建；应用首次使用时自动初始化所选库中的表，不复制正式账号与记录。注册需管理员审核，首个管理员需在对应数据库中指定。当前密码按项目既有约定明文存储，API 不返回密码。

## 使用

- 选择安卓 QQ、iOS QQ、安卓微信或 iOS 微信渠道后，点击「启动模拟器获取二维码」，使用对应的手机 QQ 或微信扫码授权；同一账号复用有效申请，刷新沿用原渠道。
- 点击「刷新二维码」更新当前实例的二维码。排队默认等待 5 分钟，领取实例后有 10 分钟扫码时间，刷新不续期。
- 授权后自动进入游戏并执行日常。执行端负责失败后的实例清理和会话释放，网页可查看执行记录。
- 秘境刷取方式提供三个互斥选项：只刷一次后结束本次日常、刷完所有扫荡券、不刷秘境。默认刷完所有扫荡券；提交后保存首次选择，刷新或复用申请不会改变。
- 管理员可审批注册、管理用户、查看近七天刷日常情况和月度排行榜。
- 月榜按新申请统计次数，按北京时间去重统计日常天数；失败和过期也计入，刷新二维码和重复提交不重复计数。

登录渠道通过顶层 `loginType`（`android_qq`、`ios_qq`、`android_wechat`、`ios_wechat`）随申请、Redis 队列和刷新指令传给执行端，数据库与执行记录保留首次选择；旧申请默认安卓 QQ。需配套更新 NarutoDailyADB 执行端。

任务设置统一放在 `userOptions` JSON 中，例如 `{ "mainTask": "arena_weekly", "equipmentStamina": true, "secretRealmMode": "all" }`。`mainTask` 可取 `daily`（刷日常）或 `arena_weekly`（决斗场周胜），缺省继续执行原来的刷日常；旧请求和旧记录不会被补写此字段。主任务只随现有 `userOptions` JSON 传递，沿用原队列和所有 Redis key，也不增加 SQL 列。提交后，复用申请、重试投递、刷新二维码和执行记录恢复都保留首次主任务选择。当前已实现客户端选择和协议透传，周胜执行逻辑需由后续 worker 实现。

日常设置中的 `secretRealmMode` 可取 `once`、`all`、`skip`，分别对应只刷一次、刷完所有扫荡券、不刷秘境，缺省为 `all`。兼容旧 `secretRealmOnce` 布尔参数：`true` 映射为 `once`，`false` 映射为 `all`；服务响应及新入队数据统一使用模式字段。新旧字段同时提供时必须一致，否则拒绝申请。切换主任务不会清空装备体力和秘境设置，这些选项仍随 `userOptions` 保存，但只对日常任务生效；周胜 worker 接入时应按 `mainTask` 分流，忽略日常专属设置。

近七天日常列表和月榜仅统计日常申请，缺省主任务的历史记录仍计入日常，周胜申请不计入。列表显示每次申请的登录渠道，可按日期筛选今天及之前六天，也可查看全部七天；月榜读取数据库中的历史申请，不受执行日志过期影响。执行记录默认保留七天，需要配套更新并重启 ADB 服务；已经过期的旧日志无法补回。

管理员列表的「日志详情」列对所有任务状态开放。打开列表只读取任务摘要；点击「查看日志」才读取首批 100 条，后续点击「加载更多」继续读取，直到显示全部保留的日志，不限制为最近 10 条。详情按打开时的日志快照分页，重新打开详情可读取新增日志；已过期或被裁剪的记录会提示缺失。

### SLS 日志归档

管理员日志详情及失败详情支持优先读取阿里云 SLS，普通用户的实时进度和日志仍从 Redis 读取。执行状态、队列、会话与账号锁仍由 Redis 管理；本次接入不缩短现有 Redis 七天保留时间。必须配套启动 NarutoDailyADB 的 SLS 日志同步器，它通过 Python SDK 批量同步 Redis Stream，并上报覆盖范围 checkpoint。

以下键放入对应环境的 Cloudflare KV namespace；正式和测试分别使用各自 Project/Logstore 和最小权限凭据，不能把正式凭据填入测试 namespace。目前同一环境的客户端和执行端共用这组配置，因此凭据须具备指定 Logstore 的 `log:GetLogStoreLogs` 读取和 `log:PostLogStoreLogs` 写入权限。若以后需要分别分配读写凭据，须先拆分配置键。不要复用浏览器变量或向前端传递密钥。

| 配置键 | 说明 |
| --- | --- |
| `SLS_ENABLED` | `true` 启用；未配置或 `false` 保持原 Redis 行为 |
| `SLS_ENDPOINT` | 区域域名，例如 `cn-hangzhou.log.aliyuncs.com`，可带 `https://`；只使用 HTTPS |
| `SLS_PROJECT`、`SLS_LOGSTORE` | 当前环境的日志目标 |
| `SLS_ACCESS_KEY_ID`、`SLS_ACCESS_KEY_SECRET` | 当前环境的服务端 RAM 凭据 |
| `SLS_STS_TOKEN` | 可选 STS Token；采用临时凭据时到期前需更新配置并重新部署 |

启用后缺配置或配置无效会拒绝启动；不回退其他环境或本地旧业务变量。Cloudflare 配置仍只在进程初始化时读取，更新后须重新部署。使用官方 Node SDK `@alicloud/sls20201230` 的 GetLogsV2，保持现有 Redis Stream ID 游标及固定快照协议。

日志契约为 `kind=event`、`taskId`、`environment`（`test` / `prod`）、`id`（原 Stream ID）、`streamMs`、`streamSeq`、`time`、`level`、`message`，可选 `actionIndex`、`actionTotal`。`kind=checkpoint` 记录 `firstId`、`throughId`、`entryCount`、`truncated`，其中 `streamMs` / `streamSeq` 对应 `throughId`。重复上传按任务、环境及 `id` 去重后分页。

Logstore 使用支持 SQL 的 Standard 类型；关闭全文索引，给上述投影及过滤字段建立字段索引并启用统计。`streamMs`、`streamSeq`、`entryCount`、`actionIndex`、`actionTotal` 使用 `long`，其余使用 `text`；文本统计长度至少设为 8192 字节，避免最多 1000 个 Unicode 字符的正文被默认长度截断。标识字段无需分词。保留天数由 Logstore 配置控制；客户端查询最近八天的索引窗口，覆盖管理页面的七天范围。

每次详情先只读取 Redis 执行状态和 Stream 首尾 ID，再验证 SLS checkpoint 覆盖范围与 `count(distinct id)`。SLS 三次查询共用最多三秒预算，且不超过 `REQUEST_TIMEOUT_MS`。SLS 不可用、无归档、返回 `Incomplete`、正文缺失、计数不匹配或末尾尚未同步时，整页回退 Redis，不拼接不完整归档。Redis 日志过期后，只有能验证完整的 checkpoint 才使用 SLS；同步器发现原记录已裁剪时，详情仍显示缺失提示。普通用户每 1.5 秒轮询的实时接口不经过 SLS，避免索引延迟丢失终态尾日志。

## 构建与部署

```powershell
npm test
npm run build
npm start
```

预览端口遵循选定 namespace 的配置。构建产物位于 `src/frontend/dist` 和 `src/server/dist`，不提交到 Git。测试使用模拟 Cloudflare、数据库和 Redis，不访问真实业务服务。

仓库已关联 Vercel 项目 `sust-acmer/naruto-login-client`，生产分支为 `main`，推送后由 Vercel 自动构建。正式部署设置 `APP_ENV=prod`，`codex/jev-multimodal-test` 的测试部署设置 `APP_ENV=test`，并提供 Cloudflare Token、账号及对应环境的 namespace ID。Cloudflare 凭据只配置在 Vercel 服务端，不能传入前端；旧的业务环境变量不再被读取。修改 KV 或部署变量后重新部署才生效。ADB 执行端独立运行，选择相同环境并重启对应服务。

接口和依赖异常会写入结构化错误日志，可在 Vercel Logs 中用响应头 `X-Request-Id` 关联同一次请求。日志保留失败阶段、错误码及必要耗时，不记录请求正文、Cookie、SQL 参数或连接凭证；正常请求不新增日志。

## 代码位置

- `src/frontend/`：页面、交互和 shadcn/ui 组件。
- `src/server/`：账号、管理接口、PostgreSQL、Redis 和 OSS。
- `src/shared/`：前后端共用类型与统计口径。
- `api/`、`vercel.json`：Vercel 入口与路由。
- `tests/`：回归测试，使用模拟服务，无需生产凭据。
