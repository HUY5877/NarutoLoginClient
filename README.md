# NarutoLoginClient · 忍者日常登录中心

React / TSX 前端和 TypeScript 客户端后端放在同一个仓库。客户端后端生成唯一任务 ID，将任务直接投放到 Redis，Python 工作进程通过 Redis 取任务并上传二维码到阿里云 OSS；客户端后端检查 OSS，页面读取并显示二维码。

**用户注册后需等待管理员审批，通过后才能登录并申请游戏二维码。** 同一个账号同时只能有一条有效登录申请；页面按需查询二维码，刷新、新开页面或重新登录后，点击「生成登录二维码」才检查并复用已有有效申请。Python 的 `mock` 驱动生成模拟二维码；`ldplayer` 驱动支持真实取码、确认扫码登录和继续执行日常。任务执行面板从 Redis 读取该任务的进度与日志，二维码过期后仍可查看。

## 本地启动

需要 Node.js 22.12+（推荐 Node.js 24）和 npm。在仓库根目录执行，`npm ci` 会自动安装前后端各自的依赖：

```powershell
cd E:\code\NarutoLoginClient
npm ci
npm run dev
```

打开 <http://127.0.0.1:4300>。页面、API 和开发热更新共用一个端口；不需要单独启动 Vite，也不需要 Python HTTP 服务。页面可在没有 `.env` 的情况下打开，注册需要 PostgreSQL，登录还需 `JWT_SECRET`，投递登录任务需要 Redis。

需要配置时，将根目录 `.env.example` 复制为 `.env` 并填写已有服务的信息，不要覆盖原有配置或提交密钥。客户端和 Python 工作进程必须连接同一个 Redis，并使用一致的队列键、OSS Bucket 和对象前缀。

`npm run dev` 和 `npm start` 会自动清理占用客户端 `PORT` 的进程，再使用原端口启动。在 Windows 上，同项目旧的 `tsx watch` 进程会一起停止，避免旧实例重新占用端口。Linux/macOS 在端口占用时需要系统提供 `lsof` 命令。

本地生产构建预览：

```powershell
npm run build
npm start
```

仍打开 <http://127.0.0.1:4300>。前端产物在 `src/frontend/dist/`，后端产物在 `src/server/dist/`；这些目录自动生成，不提交到 Git。

## 执行路径

```text
TSX 页面注册 → PostgreSQL 待审核账号与申请 → 管理员审批
TSX 页面登录 → 校验账号启用状态 → 后端签发 JWT → 浏览器 HttpOnly Cookie
TSX 页面点击「生成登录二维码」
  → 用户点击生成后保存本次 requestId，先查询已有有效申请
  → 有申请则继续查询；没有时才 POST，刷新后再次点击可复用原编号
  → TS 后端校验网站账号，在 PostgreSQL 事件表保存 UUID、状态和过期时间
  → Redis 原子检查账号当前任务、保存会话，并 LPUSH 登录任务
  → Python 工作进程 BRPOP 同一个队列
  → Python 启动独立任务进程，按所配置驱动生成二维码
  → Python 上传 login/{id}/qr.png 到 OSS

TSX 页面每秒 GET /api/login-sessions/{id}
  → TS 后端校验网站账号与事件归属，读取 Redis 进度并同步事件状态
  → HEAD OSS 对象，存在即返回 qr_ready
  → 页面 GET /api/login-sessions/{id}/qr
  → TS 后端 GET OSS 对象并转发 PNG
```

浏览器只访问客户端 API。数据库、Redis 连接信息、JWT 签名密钥和 OSS 密钥由 TS 后端读取；登录 JWT 通过 HttpOnly Cookie 保存，有效期为 7 天，前端 JavaScript 无法读取。二维码申请默认有效期为 120 秒，获取成功后仍占用该账号名额，失败或过期才允许重新申请。

## 网站账号

配置 `DATABASE_URL`（例如 `postgresql://username:password@host:5432/naruto_login`）和 `JWT_SECRET`。本项目使用独立数据库 `naruto_login`，不使用 `hackathon`。首次访问认证功能时自动在目标库创建或迁移 `naruto_login.users`、`naruto_login.login_events` 和 `naruto_login.registration_applications`，不会改动其他业务表。用户名为 3–24 个汉字、英文字母、数字、下划线或短横线，英文字母不区分大小写，数据库唯一约束防止并发重复注册；密码为 6–128 个字符，按当前项目要求以明文保存在 `users.password` 中，API 不返回该字段。

后端使用 `jose` 签发和验证 HS256 JWT，包含用户 ID、签发时间、7 天过期时间及随机编号，固定校验签发者和受众。JWT 不保存密码或管理员角色；每次请求验签后查询 `users` 的实时启用状态与权限。后端不再创建或读写 `sessions` 表。退出只清除当前浏览器的 Cookie，不维护令牌撤销表；未过期 JWT 本身仍有效，停用账号会阻止其继续使用。

`JWT_SECRET` 至少为 32 字节，随机生成一次后保存在根目录 `.env`，所有同环境后端实例使用同一值，不能每次启动重新生成。可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成。修改密钥会使原 JWT 全部失效，用户需重新登录。此配置不使用 `VITE_` 前缀，不进入前端构建产物。

旧版本升级顺序：先配置线上 `JWT_SECRET` 并发布 JWT 版本，确认旧版本不再承接流量，再连接 `naruto_login` 数据库执行 `DROP TABLE IF EXISTS naruto_login.sessions;`。新版本不会自动删表，避免本地调试时影响仍依赖旧表的线上实例；新库只会创建上述三张业务表。旧版 Cookie 在升级后需要重新登录。

新注册的用户固定为 `is_invalid=true`、`is_admin=false`，同时创建一条待审批申请，不签发登录 Cookie。`is_invalid=true` 表示账号尚未获准登录或已停用；审批通过后改为 `false`。`is_admin=true` 表示管理员，页面右上角显示「管理员」菜单，可打开注册申请审核面板，按状态筛选申请并批准或拒绝。审批表保存状态、申请时间、审核人、审核时间和可选备注；同一申请只能审核一次，重复审核返回 `409`。

数据库迁移保留旧用户原有登录资格，旧账号不会自动变成管理员。初始管理员必须由数据库管理员显式指定；公开注册及审核接口都不能设置 `is_admin`。现有数据库已按用户要求设置首个管理员 `HUY1`，密码不写入仓库。每次接口请求都重新检查账号启用状态与角色，禁用账号或撤销管理员角色后，已有 Cookie 也不能绕过权限检查。

未配置数据库时，注册登录返回 `503 / DATABASE_NOT_CONFIGURED`；缺少 JWT 签名密钥时无法签发或验证 JWT，返回 `503 / JWT_NOT_CONFIGURED`；未登录申请二维码返回 `401 / AUTH_REQUIRED`。同账号并发申请通过数据库账号行锁和唯一约束复用当前事件；Redis Lua 负责同任务重试不重复入队。不能通过修改请求中的用户 ID 访问其他账号的二维码。

## 刷新与事件恢复

`naruto_login.login_events` 保存 `id`、`user_id`、`request_id`、`status`、`created_at`、`expires_at`、`dispatched_at` 和 `finished_at`。内部 `access_token` 仅用于重试相同任务的投递，不返回浏览器。每个账号只允许一条未结束事件；同账号、同 `request_id` 永远对应原事件，即使已过期也不会创建新任务。

首次打开、刷新、新开页面和切回窗口时，二维码区域保持空闲并显示「生成登录二维码」，不请求登录申请状态，也不因其他页面的本地存储事件自动查询。用户点击后才查 `GET /api/login-sessions/active`：有有效申请则继续轮询并显示原二维码，没有才提交保存的请求编号。查询失败不会当作没有事件，不会据此创建重复任务。网站账号身份读取和独立任务日志查询不受此按需加载策略影响。

生成二维码前可以选择「装备栏体力刷取」，默认开启。用户附加参数统一保存在 `userOptions` JSON 对象中，目前支持布尔字段 `equipmentStamina`；关闭后，配套 Python worker 跳过装备材料扫荡、合成和进阶任务组，其他日常照常执行。提交后选项随申请固定；刷新、网络重试和复用已有有效申请都保留原选择，下一次新申请才能修改。

浏览器待确认申请保存完整的 `{requestId, userOptions, createdAt, expiresAt}`，数据库 `naruto_login.login_events.user_options` 使用单个 JSONB 字段保存所有用户附加参数，投递恢复时读取原记录。已有数据库在初始化时幂等补充该字段；历史请求或记录未提供选项时默认开启。API 对非布尔值及未知选项返回 `400 / INVALID_USER_OPTIONS`，后续扩展选项时统一在 `src/shared/user-options.ts` 与 worker 协议中添加，不拆分为独立数据库列、Redis key 或队列顶层字段。

点击时先同步保存本账号的 `requestId`，再发送请求。刷新发生在请求返回之前时，页面不主动补交；用户再次点击后查询已有申请，如果尚未落库，则用有效期内保存的同一个 `requestId` 补交。点击后的准备进度继续自动轮询，获取二维码后停止；失败或到期在本地结束显示并恢复按钮，不自动重新查询或创建任务。再次点击时仍由服务端确认已有申请。

数据库先保存事件，再投递 Redis；若入队成功但响应丢失，恢复时重发相同 ID 和凭据，Lua 确认已有任务后直接返回成功。已确认投递的事件不会因 Redis 记录丢失而重新入队，原事件在有效期内继续占用账号名额。

工作进程在领取阶段校验失败时，二维码区域和登录准备步骤显示明确失败原因，执行记录同时显示 ERROR 日志。`worker_clock_skew` 表示执行服务器时间不同步，`invalid_task_payload` 表示任务格式异常，`invalid_task_timestamps` 表示任务时间信息异常。客户端按安全错误码生成固定中文提示，不直接展示 Redis 中未知的错误文本。已收到的失败原因不会被二维码倒计时覆盖；刷新后二维码仍按需加载，独立执行记录会恢复失败原因和日志。

## Redis 与 Python 接入协议

设置 `REDIS_URL` 为已有 Redis 的连接地址，支持 `redis://` 和 `rediss://`。云端和 Python 所在机器都必须能访问该实例；暂时没有 Redis 时保持未配置，不要填写伪地址。

默认队列键为 `naruto:login:tasks`。TS 后端使用 `LPUSH` 投递 JSON 字符串，Python 使用 `BRPOP` 按先后顺序消费。消息示例：

```json
{
  "version": 1,
  "id": "123e4567-e89b-42d3-a456-426614174000",
  "createdAt": "2026-09-23T06:00:00.000Z",
  "expiresAt": "2026-09-23T06:02:00.000Z",
  "objectKey": "login/123e4567-e89b-42d3-a456-426614174000/qr.png",
  "userOptions": {
    "equipmentStamina": true
  }
}
```

Python 消费端需要校验消息版本、UUID 和过期时间，直接丢弃已过期任务，再按 `objectKey` 上传 PNG。开始处理和上传前都应检查过期时间，避免继续处理已失效申请。Redis 会话有 TTL，但列表中的过期任务不会自动消失，必须由消费端丢弃。

会话保存在 `<REDIS_QUEUE_KEY>:sessions:<id>`，默认例如 `naruto:login:tasks:sessions:123e4567-e89b-42d3-a456-426614174000`。值为 JSON，包含 `id`、`userId`、`status`、`createdAt`、`expiresAt`、`userOptions`、`simulation: true` 和协议兼容字段 `tokenHash`。账号当前申请保存在 `<REDIS_QUEUE_KEY>:users:<userId>:active`，与申请同时过期。队列消息不含账号密码或网站登录凭证。

工作进程可以选择回写 `starting_emulator`、`opening_game`、`preparing_qr` 或 `failed` 等状态。回写时必须保留 `tokenHash`、时间字段和其他会话字段，并保留原 TTL；例如更新既有 JSON 后使用 `SET ... XX KEEPTTL`，不要新建已过期会话或延长申请有效期。不回写中间状态也可以，客户端会继续检查 OSS，文件到达后显示二维码。

Python 项目位于 `E:\code\NarutoDailyADB` 的 `naruto_daily/login_service/`，通过 Redis 消费上述协议。客户端不调用 Python HTTP 接口；队列协议保持 `version: 1` 并增加可选的 `userOptions` 对象。配套 worker 将整个对象传入日常执行子进程，旧消息省略时默认开启装备栏体力刷取。工作进程回写状态时需继续保留 `userId`、`userOptions` 等额外字段。

## 日常执行进度与日志

右侧按「提交登录申请 → 获取二维码 → 执行脚本」三个固定阶段展示总进度。二维码生成后等待扫码，确认登录后才进入日常脚本；二维码到期不会把正在执行的日常标成失败。下方日志记录提交、启动模拟器、打开游戏、生成二维码、等待扫码、开始日常、动作进度及最终结果，省略反复截图和坐标识别等细节。

登录后页面独立查询最近任务的执行记录。Python 将快照写入 `${REDIS_QUEUE_KEY}:runs:<任务ID>`（String JSON），将日志追加到 `${REDIS_QUEUE_KEY}:logs:<任务ID>`（Redis Stream）。每条 Stream 的 `json` 字段是 `{time, level, message, actionIndex?, actionTotal?}`；运行状态使用独立的 `starting_emulator`、`opening_game`、`preparing_qr`、`waiting_scan`、`running_daily`、`completed`、`failed`、`interrupted`、`expired`，不会写入原登录事件的状态白名单。

提交日志在客户端后端的入队 Lua 中写入，先于工作进程的日志；重复投递同一申请不会重复追加。工作进程尚未领取或校验失败时，用户也能看到申请已提交。该初始日志保留 24 小时，后续日志写入采用 Python 的保留配置；日志写入故障不会将已接收的任务误报为提交失败。

`GET /api/task-runs/latest` 按当前网站账号查询 PostgreSQL 中最近的任务，包含已过期的登录申请；仅查询，不重新派发任务。`GET /api/task-runs/:id/events?after=0-0` 先校验登录与任务归属，再原子读取运行快照和最多 100 条日志，返回 `{task, run, logs, nextCursor, hasMore, truncated}`。每条 `logs` 含 Stream `id`；下次使用 `nextCursor`，有剩余分页时继续读取。访问其他用户任务返回 404，内部 worker 标识与协议序号不返回网页。

前端每 1.5 秒增量轮询，拿到二维码、登录会话到期都不会停止已存在的日常运行记录。任务终态的日志读取完毕后停止；刷新恢复最近任务，退出和切换账号立即清空记录并取消旧请求。页面最多保留最新 2000 条，历史裁剪时提示；用户向上翻阅日志时暂停自动滚底，网络错误可点击“重试更新”继续原游标。

保留策略由 Python 配置：默认 Redis 保留最近 2000 条日志，最终写入后保留 24 小时，运行中额外预留日常总超时预算。保留期与二维码 TTL 独立。旧 worker 未上报运行记录时显示等待或无记录，不把二维码过期误判成日常完成。实时日志为尽力投递，强杀或长期断网可能缺少部分记录；它不改变原队列的任务恢复语义。

## 对象存储

本地 `STORAGE_DRIVER=local` 时，TS 后端直接读取仓库 `.data/login-objects/<OSS_KEY_PREFIX>/<id>/qr.png`。这是文件系统模拟存储，无独立 HTTP 服务；以后本地工作进程需把文件写到同一目录。可通过 `LOCAL_OBJECTS_DIR` 指定共享目录。

部署 Vercel 时使用 OSS：

```dotenv
STORAGE_DRIVER=oss
OSS_REGION=oss-cn-shanghai
OSS_BUCKET=your-private-bucket
OSS_ACCESS_KEY_ID=your-access-key-id
OSS_ACCESS_KEY_SECRET=your-access-key-secret
```

`OSS_KEY_PREFIX` 默认 `login`，通常不需要配置。使用临时凭证时另外设置 `OSS_STS_TOKEN`。Python 写入端使用相同地域、Bucket 和对象前缀；它的凭据可以与客户端读取凭据不同。

客户端后端只用 OSS `HEAD` / `GET` 检查和读取二维码；对象保持私有，浏览器不接触 OSS 密钥，也不需要配置浏览器 OSS CORS。对象过期清理由工作进程或 Bucket 生命周期负责，客户端不会删除对象。

## Vercel 部署与自动更新

Vercel 项目以本仓库根目录为 Root Directory，构建命令为 `npm run build`，静态输出目录为 `src/frontend/dist`；`api` 下的函数承接 `/api` 请求。网页和接口共用一个域名，不需要对外开放本地的 `4300` 端口。

已关联 [sust-acmer/naruto-login-client](https://vercel.com/sust-acmer/naruto-login-client) 与本仓库，生产分支为 `main`。每次推送 `main` 都会自动构建并更新生产网站，无需 `.github` 工作流。

生产网站：[登录中心](https://naruto-login-client.vercel.app)。本地 `.env` 和 Vercel 的 Production、Preview 已分别配置 `REDIS_URL`，使用同一个 Redis 的 DB 0；凭据不写入代码或文档。

提交作者邮箱必须能关联到当前 GitHub 账号；本仓库已使用该账号的 GitHub noreply 邮箱。若换电脑后 Vercel 提示无法识别提交作者，请检查该仓库的 `git config user.email`。

在 Vercel 项目的 Environment Variables 中设置：

| 变量 | 内容 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接地址，用于账号、审批和二维码事件 |
| `JWT_SECRET` | 至少 32 字节的随机后端签名密钥，同环境所有实例保持一致 |
| `REDIS_URL` | 云端和 Python 均可访问的 Redis 地址；暂缺时可不填，申请接口会返回明确的 503 |
| `STORAGE_DRIVER` | `oss` |
| `OSS_REGION` | `oss-cn-shanghai` |
| `OSS_BUCKET` | 私有 Bucket 名称 |
| `OSS_ACCESS_KEY_ID` | 后端读取 OSS 的 AccessKey ID |
| `OSS_ACCESS_KEY_SECRET` | 对应密钥 |

本地 `.env` 不随 Git 上传；环境变量应在 Vercel 单独配置，修改后重新部署生效。若需要预览部署也能调用接口，为 Preview 环境配置相应变量。Vercel 的本地文件系统不用于共享二维码，云端应使用 OSS。

## 可选配置

除实际服务连接和凭据外，其余设置通常保持默认即可：

| 变量 | 默认值与用途 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4300`，本地页面、API 和开发热更新地址 |
| `REDIS_QUEUE_KEY` | `naruto:login:tasks`，客户端与 Python 共用的队列键 |
| `SESSION_TTL_MS` | `120000`，申请有效期，支持 5 秒至 10 分钟 |
| `REQUEST_TIMEOUT_MS` | `5000`，Redis 和 OSS 请求超时 |
| `OSS_KEY_PREFIX` | `login`，二维码对象路径前缀 |
| `LOCAL_OBJECTS_DIR` | 本仓库 `.data/login-objects`，本地模拟对象目录 |
| `ALLOWED_ORIGINS` | 空，额外允许的跨域来源，逗号分隔；同源使用无需设置 |

## HTTP 接口

| 接口 | 结果 |
| --- | --- |
| `GET /api/auth/me` | 当前网站账号，未登录返回 `{ user: null }` |
| `POST /api/auth/register` | 提交用户名、密码，返回 `201` 和待审批申请，不自动登录 |
| `POST /api/auth/login` | 审批通过且启用的账号可登录，设置 HttpOnly Cookie；待审核/拒绝/禁用返回 `403` |
| `POST /api/auth/logout` | 清除当前浏览器的 JWT Cookie，无需访问数据库 |
| `GET /api/admin/registration-applications?status=pending` | 管理员查看最近 100 条申请，支持 `pending`、`approved`、`rejected`、`all` |
| `POST /api/admin/registration-applications/:id/review` | 管理员提交 `{decision: "approved" 或 "rejected", reason?: string}`，审核人与时间由后端确定 |
| `POST /api/login-sessions` | `{requestId, userOptions: {equipmentStamina: boolean}}` 创建或恢复同一事件，返回 `202` 和 `id`、状态、有效时间、`userOptions`、`showGetButton`；省略选项默认开启 |
| `GET /api/login-sessions/active` | `{session, showGetButton}`，用户主动点击后查询当前账号未过期事件 |
| `GET /api/login-sessions/:id` | 当前账号的事件进度及 `showGetButton`，使用登录 Cookie |
| `GET /api/login-sessions/:id/qr` | 当前账号的二维码 `image/png`；过期或 Redis 会话失效后不可读取 |
| `GET /api/task-runs/latest` | 当前账号最近的任务，供执行日志恢复，独立于二维码有效期 |
| `GET /api/task-runs/:id/events?after=0-0` | 该账号任务的执行快照和最多 100 条增量日志，包含下一页游标和历史裁剪提示 |
| `GET /api/health` | 客户端后端状态与配置情况，不保证 Redis 或 OSS 实时连通 |

状态包括 `queued`、`starting_emulator`、`opening_game`、`preparing_qr`、`qr_ready`、`failed` 和 `expired`。`qr_ready` 仅表示二维码可读取，不表示账号已登录。OSS 404 表示尚未上传；其他存储错误返回可重试错误。

## 目录与验证

前端采用 **shadcn/ui（Radix Nova）+ Tailwind CSS v4**，基础控件由官方 CLI 安装；图标使用 Lucide，Geist 字体本地打包。主题位于 `src/frontend/styles.css`，组件配置位于 `src/frontend/components.json`。

在根目录执行 `npm run ui -- <组件名>` 可通过官方 `shadcn add` 新增组件，组件及依赖归前端包管理。`@/` 指向 `src/frontend/`；登录申请、轮询和过期逻辑位于 `hooks/use-login-session.ts`。

前后端各自维护 `package.json`、`package-lock.json`、`node_modules/` 和 `dist/`。根目录 `package.json` 只编排统一命令；前端、后端和测试共用一份 `tsconfig.json`。

```text
src/frontend/       TSX 登录页、前端依赖、Vite 和 shadcn 配置
  components/ui/    官方 shadcn/ui 组件
  hooks/            登录申请与二维码轮询
  dist/             前端构建产物（自动生成）
src/server/         TypeScript API、Redis 队列、OSS 读适配器
  dist/             后端构建产物（自动生成）
api/                Vercel 函数入口
tests/              API、Redis 协议、存储与单端口测试
package.json        统一安装、开发、构建和测试命令
tsconfig.json       共用 TypeScript 配置
vercel.json         Vercel 构建、输出和 API 路由
```

```powershell
npm test
npm run build
```

所有写接口使用 `Content-Type: application/json`，并校验请求来源。

测试使用模拟数据库、Redis 驱动、OSS 方法和临时目录，不需要真实云端凭据。覆盖注册唯一性、JWT 签发/验签/过期、退出清除 Cookie、实时权限、任务归属、同账号互斥、失败处理、存储就绪判定、过期与 PNG 响应，并检查单端口开发启动。

二维码懒加载的浏览器回归可单独执行 `node --test tests/frontend-login-lazy.integration.mjs`。测试使用真实前端和模拟 API，覆盖刷新、新页面、点击恢复、请求编号复用、过期和账号切换。可用 `PLAYWRIGHT_MODULE` 与 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定现有 Playwright 模块和 Chromium 路径；依赖不可用时明确跳过，不会自动安装。


todo:
1.二维码刷新，增加扫码超时时间
