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
- 管理员可审批注册、管理用户、查看近七天扫码情况和月度排行榜；扫码列表支持按日期筛选刷日常或刷周胜的申请。
- 管理员可在用户管理中添加、修改或清空备注，最多 100 个字符，并按用户名或备注搜索。备注显示在管理员的用户列表、扫码记录及月榜中；扫码列表优先显示备注，没有备注时显示原用户名。用户仍用原用户名登录，普通用户不可查看备注。备注单独保存到 `users.admin_note`，旧账号自动兼容空备注。
- 用户管理支持按全部、已启用、待审核、已拒绝、已停用筛选，可与用户名、备注搜索组合使用，列表数量和分页按筛选结果计算。已启用账号优先归为已启用；其他账号按最新注册申请区分待审核、已拒绝和已停用。
- 月榜按新申请统计次数，按北京时间去重统计日常天数；失败和过期也计入，刷新二维码和重复提交不重复计数。

登录渠道通过顶层 `loginType`（`android_qq`、`ios_qq`、`android_wechat`、`ios_wechat`）随申请、Redis 队列和刷新指令传给执行端，数据库与执行记录保留首次选择；旧申请默认安卓 QQ。需配套更新 NarutoDailyADB 执行端。

### QQ 抓号器自动登录

配套使用 NarutoDailyADB 的 `codex/qq-capture-login` 分支，以及抓号器 1.3.0（版本号 7）和上号器 4.0（版本号 9）或兼容自动化协议 1 的后续版本。执行端在安卓 QQ、iOS QQ 实例中同时发现两款 App 时使用新流程；缺少任意一款时继续原扫码流程。微信及登录后的日常、周胜逻辑保持原样。

抓号器由网站任务自动启动，无需登录网站账号。脚本传入当前任务所属用户和一次性扫码凭证，二维码仍通过原有网页展示。扫码成功后，`POST /api/qq-captures` 将完整 `callback_url` 明文保存到当前环境数据库，并固定账号名称为“自己账号”。脚本读取本轮结果后在上号器输入 URL，再等待游戏界面确认登录完成。上号器登录网站账号后，通过 `GET /api/qq-authorizations` 查看本人的扫码历史；该列表仅返回名称、尾号与时间，不返回授权 URL 或 token。

上传不会因模拟器抓取时间超前于云端而被拒绝，超前的抓取时间保存为云端接收时间。授权有效期沿用回调的 `auth_time` 和 `expires_in`；缺少 `auth_time` 时从校正后的抓取时间计算，旧授权不会因重新上传而统一续期两个月。

上线前需一起更新网站、执行端和两款 APK。在执行端选定的 Cloudflare KV namespace 配置 `QQ_CAPTURE_API_BASE`，值为可从模拟器访问的 HTTPS 网站根地址（例如 `https://login.example.com`，不含 `/api`）。网站和执行端的 `DATABASE_URL` 必须指向同一个环境数据库。不要依据 Git 分支推断环境；两端仍由 `APP_ENV` 选择 prod/test。网站收到 QQ 申请时会在入队前初始化新表，现有数据库账号需要建表权限；执行端需要对 `naruto_login.qq_capture_requests` 执行插入、查询和更新。

`qq_capture_requests` 按 `(task_id, attempt_id)` 隔离执行尝试，每次刷新更换 `capture_id` 和凭证，刷新不会延长原任务有效期。上传、读取和取消都绑定原用户及当前轮次，旧二维码结果不能作为新轮结果使用。上传需要完整任务凭证，单独提供公开 `userId` 无法写入账号。`captureToken`、数据库连接串与授权 URL 不写入任务日志或网页公开状态。

新环境自动创建明文 `qq_authorizations` 表，并兼容已有的明文账号表。更早仅包含 `ciphertext`、`nonce`、`auth_tag` 的加密表需先完成既有迁移；本分支不会丢弃或自动解密旧记录。自动化模式下，抓号器本机刷新按钮提示在网页刷新，以保持网页的刷新轮次和展示二维码一致。

任务设置统一放在 `userOptions` JSON 中，例如 `{ "mainTask": "arena_weekly", "equipmentStamina": true, "secretRealmMode": "all" }`。`mainTask` 可取 `daily`（刷日常）或 `arena_weekly`（决斗场周胜），缺省继续执行原来的刷日常；旧请求和旧记录不会被补写此字段。主任务只随现有 `userOptions` JSON 传递，沿用原队列和所有 Redis key，也不增加 SQL 列。提交后，复用申请、重试投递、刷新二维码和执行记录恢复都保留首次主任务选择。执行端通过 `mainTask` 区分日常和周胜任务。

日常设置中的 `secretRealmMode` 可取 `once`、`all`、`skip`，分别对应只刷一次、刷完所有扫荡券、不刷秘境，缺省为 `all`。兼容旧 `secretRealmOnce` 布尔参数：`true` 映射为 `once`，`false` 映射为 `all`；服务响应及新入队数据统一使用模式字段。新旧字段同时提供时必须一致，否则拒绝申请。切换主任务不会清空装备体力和秘境设置，这些选项仍随 `userOptions` 保存，但只对日常任务生效；周胜执行忽略日常专属设置。

近七天扫码列表支持选择查看日常或周胜申请，缺省主任务的历史记录仍计入日常。列表显示每次申请的登录渠道，可按日期筛选今天及之前六天，也可查看全部七天。月榜仅统计日常申请，不计入周胜申请；月榜读取数据库中的历史申请，不受执行日志过期影响。执行记录默认保留七天，需要配套更新并重启 ADB 服务；已经过期的旧日志无法补回。

管理员列表的「日志详情」列对所有任务状态开放。打开列表只读取任务摘要；点击「查看日志」才读取首批 100 条，后续点击「加载更多」继续读取，直到显示全部保留的日志，不限制为最近 10 条。详情按打开时的日志快照分页，重新打开详情可读取新增日志；已过期或被裁剪的记录会提示缺失。

管理员可在「近七天扫码情况」中对正在执行的日常或周胜任务点击「中断任务」，确认后刷新列表。排队中、已完成、失败、过期或记录不可用的任务不提供中断按钮。接口 `POST /api/admin/daily-tasks/:id/interrupt` 要求管理员登录及同源 JSON 请求；重复中断已中断的记录返回成功，其他终态返回冲突，缺失记录会被拒绝且不会被创建。

后端通过一次 Lua 原子修改 `${REDIS_QUEUE_KEY}:runs:<任务UUID>` 原始 JSON 的 `status`、`errorCode`、`updatedAt` 和 `finishedAt`，保留 `workerId`、`attemptId`、`sequence`、日志游标、其余字段及原有效期，不改登录会话、队列或账号锁。需要同时使用支持管理员中断回调的 NarutoDailyADB worker，并升级重启该 worker。中断请求提交后，执行端在下一次已有状态回写时发现标记，停止对应子进程并清理模拟器；没有新回写时不会立即停止，已经发出的游戏操作不会撤回。

### QQ 群提醒绑定

登录后点击页头「QQ 群提醒」，生成 5 分钟有效的一次性绑定码，在指定通知群中发送 `@机器人 绑定 CODE`。页面收到群内验证后显示发送者信息，确认本人发送后完成绑定；重新生成会废弃旧码，已绑定身份保留到新绑定确认。用户可在同一窗口解绑，解绑同时取消未完成的挑战。账号切换、退出及关闭窗口会停止轮询。

启用前将 `QQ_BOT_APP_ID`、`QQ_BOT_APP_SECRET`、`QQ_BOT_GROUP_OPENID` 放入当前 `APP_ENV` 的 Cloudflare namespace，并与同环境 NarutoDailyADB 保持一致。全空时窗口显示尚未配置；部分填写会拒绝启动。三项配置仅用于后端，不加 `VITE_` 前缀。测试分支联调须显式选择 `APP_ENV=test`，使用独立测试数据库和测试机器人。

在 QQ 机器人管理后台把回调地址设为 `https://测试网站域名/api/qq/events`，订阅 `GROUP_AT_MESSAGE_CREATE`。地址必须公网 HTTPS 可访问，反向代理需完整保留原始请求体及 `X-Bot-Appid`、`X-Signature-Ed25519`、`X-Signature-Timestamp` 请求头。接口支持 `op=13` 地址校验和 `op=0` 事件，正常事件确认返回 `{ "op": 12 }`。首次地址校验不连接数据库；正常绑定业务才初始化数据库表。

服务对事件原始字节验签，并检查机器人、群、时间戳和候选成员。地址校验的 `plain_token` 仅接受 1–1024 个 base64url 字符，防止公开签名接口被用于签署伪造 JSON 事件。绑定码仅以 SHA-256 哈希保存在 `naruto_login.qq_binding_challenges`，一次性消费；身份保存在 `naruto_login.qq_bindings`，限定网站账号、机器人和群，同一群成员不能同时绑定两个网站账号。用户删除会级联删除相关数据。

配套执行端每次发通知前只读查询绑定，使用 Markdown @ 指定成员；未绑定和查询失败沿用原用户名纯文本消息。解绑取消定向 @，保留原有任务及群内文字通知。群主需另外允许机器人主动发言；网站绑定不代替 QQ 平台权限配置。

### SLS 日志归档

管理员日志详情、失败详情和普通用户实时日志优先读取阿里云 SLS。NarutoDailyADB 的 logger 在 emit 时生成日志 ID，由进程内发布器通过 Python SDK 异步批量直传 SLS，并附带覆盖范围 checkpoint。新日志不再写 Redis；关闭 SLS 时也不会恢复 Redis 日志写入。执行状态、队列、会话与账号锁仍由 Redis 管理，已有 Redis 历史日志保留兼容读取并按原有 TTL 自然过期。

客户端提交申请只写入队列和已有 queued 会话状态，不上传日志。提交后的即时进度由排队状态展示；执行端领取或安全拒绝任务时补发提交/等待领取事件，再记录正式执行或拒绝原因。日志发布缓冲仅在执行端进程内存中保存，不使用 Redis Stream 或本地 SQLite；进程退出、缓冲溢出或长期无法上传可能导致日志缺失，不影响轻量执行状态读取。

以下键放入对应环境的 Cloudflare KV namespace；正式和测试分别使用各自 Project/Logstore 和最小权限凭据，不能把正式凭据填入测试 namespace。目前同一环境的客户端和执行端共用这组配置，因此凭据须具备指定 Logstore 的 `log:GetLogStoreLogs` 读取和 `log:PostLogStoreLogs` 写入权限。若以后需要分别分配读写凭据，须先拆分配置键。不要复用浏览器变量或向前端传递密钥。

| 配置键 | 说明 |
| --- | --- |
| `SLS_ENABLED` | `true` 启用 SLS；未配置或 `false` 时新任务不记录执行日志，历史 Redis 日志仍可读取 |
| `SLS_ENDPOINT` | 区域域名，例如 `cn-hangzhou.log.aliyuncs.com`，可带 `https://`；只使用 HTTPS |
| `SLS_PROJECT`、`SLS_LOGSTORE` | 当前环境的日志目标 |
| `SLS_ACCESS_KEY_ID`、`SLS_ACCESS_KEY_SECRET` | 当前环境的服务端 RAM 凭据 |
| `SLS_STS_TOKEN` | 可选 STS Token；采用临时凭据时到期前需更新配置并重新部署 |

启用后缺配置或配置无效会拒绝启动；不回退其他环境或本地旧业务变量。Cloudflare 配置仍只在进程初始化时读取，更新后须重新部署。使用官方 Node SDK `@alicloud/sls20201230` 的 GetLogsV2，保持现有 `毫秒-序号` 游标及固定快照协议。

日志契约为 `kind=event`、`taskId`、`environment`（`test` / `prod`）、`id`（logger 生成的 `ms-seq`）、`firstId`、`streamMs`、`streamSeq`、`time`、`level`、`message`，可选 `actionIndex`、`actionTotal`。ID 按毫秒和序号数值排序，不能按字符串排序。`kind=checkpoint` 记录当前 producer 的 `firstId`、`throughId`、`entryCount`、`truncated`，其中 `streamMs` / `streamSeq` 对应 `throughId`。事件的 `firstId` 用于隔离当前 producer 的计数，兼容缺少该字段的旧事件；日志页仍包含所有 producer 的历史。重复上传按任务、环境及 `id` 去重后分页。执行状态另保存 `logSource=sls|disabled` 与最新 emit 的 `logCursor`；不含这些字段的旧任务继续兼容 Redis。

Logstore 使用支持 SQL 的 Standard 类型；关闭全文索引，给上述投影及过滤字段建立字段索引并启用统计。`streamMs`、`streamSeq`、`entryCount`、`actionIndex`、`actionTotal` 使用 `long`，其余使用 `text`；文本统计长度至少设为 8192 字节，避免最多 1000 个 Unicode 字符的正文被默认长度截断。标识字段无需分词。保留天数由 Logstore 配置控制；客户端查询最近八天的索引窗口，覆盖管理页面的七天范围。

每次 SLS 读取先 GET Redis 的轻量执行状态，不读取 Stream 内容或边界；检查 checkpoint 的区间去重计数与执行状态的 `logCursor` 水位。重启后的 checkpoint 只证明自身区间，日志分页仍查询整个 `after..snapshot`，保留此前 producer 的历史日志。执行端继承旧游标但失去原内存发布状态时，后续 checkpoint 持续标记 `truncated=true`；客户端也保留已查询到的旧 checkpoint 缺失提示，不把新 producer 的完整区间当作整个任务无缺失。SLS 三次查询共用最多三秒预算，且不超过 `REQUEST_TIMEOUT_MS`；`Incomplete`、计数不匹配或正文缺失均不作为完整结果使用。

旧任务在 SLS 不可用或无归档时回退 Redis。标记为 `logSource=sls` 的新任务没有 Redis 日志可回退：无 checkpoint、索引未追上水位或查询失败时返回 `logsPending`，保留原游标，管理员可手动重试。运行中的实时界面每 1.5 秒读取已完整入索引的日志前缀，不要求先追上不断增长的水位；终态严格等待最终水位，最多再等待 90 秒，仍未就绪则提示稍后重试，避免提前停止而丢掉最后一批日志或零间隔忙刷。`logSource=sls` 暂无 `logCursor` 的拒绝事件发布间隙也按待入库处理。`truncated` 表示发布器明确报告的缺失；纯内存发布无法证明进程崩溃前尚未上传的日志完整性。

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
