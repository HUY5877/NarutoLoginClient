# NarutoLoginClient · 忍者日常登录中心

React / TSX 前端和 TypeScript 客户端后端放在同一个仓库。客户端后端生成唯一任务 ID，将任务直接投放到 Redis，Python 工作进程通过 Redis 取任务并上传二维码到阿里云 OSS；客户端后端检查 OSS，页面读取并显示二维码。

**当前已接入 Redis 与 OSS 的客户端协议，Redis 实例尚未配置，Python 项目仍需适配新队列协议。** 网站可以独立启动和部署；未配置 `REDIS_URL` 时，申请接口明确返回 `503 / REDIS_NOT_CONFIGURED`，不会假装投递成功。当前无法运行完整二维码流程，也尚未实现雷电点击、真实扫码确认或登录成功回调。

## 本地启动

需要 Node.js 22.12+（推荐 Node.js 24）和 npm。在仓库根目录执行，`npm ci` 会自动安装前后端各自的依赖：

```powershell
cd E:\code\NarutoLoginClient
npm ci
npm run dev
```

打开 <http://127.0.0.1:4300>。页面、API 和开发热更新共用一个端口；不需要单独启动 Vite，也不需要 Python HTTP 服务。页面可在没有 `.env` 的情况下打开，投递登录任务仍需可连接的 Redis。

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
TSX 页面 POST /api/login-sessions
  → TS 后端生成 UUID、随机访问凭证、过期时间
  → Redis 原子保存会话及凭证哈希，并 LPUSH 登录任务
  → Python 工作进程 BRPOP 同一个队列
  → Python 启动模拟器、获取二维码（待适配实现）
  → Python 上传 login/{id}/qr.png 到 OSS

TSX 页面每秒 GET /api/login-sessions/{id}
  → TS 后端从 Redis 读取会话并校验访问凭证
  → HEAD OSS 对象，存在即返回 qr_ready
  → 页面 GET /api/login-sessions/{id}/qr
  → TS 后端 GET OSS 对象并转发 PNG
```

浏览器只访问客户端 API。Redis 连接信息和 OSS 密钥由 TS 后端读取；访问凭证只保存在页面内存，刷新页面需重新申请。申请默认有效期为 120 秒。

## Redis 与 Python 接入协议

设置 `REDIS_URL` 为已有 Redis 的连接地址，支持 `redis://` 和 `rediss://`。云端和 Python 所在机器都必须能访问该实例；暂时没有 Redis 时保持未配置，不要填写伪地址。

默认队列键为 `naruto:login:tasks`。TS 后端使用 `LPUSH` 投递 JSON 字符串，Python 使用 `BRPOP` 按先后顺序消费。消息示例：

```json
{
  "version": 1,
  "id": "123e4567-e89b-42d3-a456-426614174000",
  "createdAt": "2026-09-23T06:00:00.000Z",
  "expiresAt": "2026-09-23T06:02:00.000Z",
  "objectKey": "login/123e4567-e89b-42d3-a456-426614174000/qr.png"
}
```

Python 消费端需要校验消息版本、UUID 和过期时间，直接丢弃已过期任务，再按 `objectKey` 上传 PNG。开始处理和上传前都应检查过期时间，避免继续处理已失效申请。Redis 会话有 TTL，但列表中的过期任务不会自动消失，必须由消费端丢弃。

会话保存在 `<REDIS_QUEUE_KEY>:sessions:<id>`，默认例如 `naruto:login:tasks:sessions:123e4567-e89b-42d3-a456-426614174000`。值为 JSON，包含 `id`、`status`、`createdAt`、`expiresAt`、`simulation: true` 和 `tokenHash`。队列消息不含浏览器原始访问凭证。

工作进程可以选择回写 `starting_emulator`、`opening_game`、`preparing_qr` 或 `failed` 等状态。回写时必须保留 `tokenHash`、时间字段和其他会话字段，并保留原 TTL；例如更新既有 JSON 后使用 `SET ... XX KEEPTTL`，不要新建已过期会话或延长申请有效期。不回写中间状态也可以，客户端会继续检查 OSS，文件到达后显示二维码。

现有 Python 项目位于 `E:\code\NarutoDailyADB` 的 `naruto_daily/login_service/`。其中旧的模拟 HTTP 队列尚未改为消费上述 Redis 消息，不能直接当作新协议工作进程使用；接入需在该项目中另行实现。客户端已不再调用它的 HTTP 接口。

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

将 Vercel 项目关联此 Git 仓库，生产分支设为 `main`。关联完成后，每次推送 `main` 都会自动构建并更新生产网站，无需 `.github` 工作流。

在 Vercel 项目的 Environment Variables 中设置：

| 变量 | 内容 |
| --- | --- |
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
| `POST /api/login-sessions` | 成功投递后返回 `202`，包含 `id`、`accessToken`、状态和有效时间；未配置 Redis 返回 `503` |
| `GET /api/login-sessions/:id` | 申请进度，必须携带 `Authorization: Bearer <accessToken>` |
| `GET /api/login-sessions/:id/qr` | `image/png`，同样需要申请凭证；过期或 Redis 会话失效后不可读取 |
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

测试使用模拟 Redis 驱动、模拟 OSS 方法和临时目录，不需要真实云端凭据。覆盖投递与凭证隔离、失败处理、存储就绪判定、过期与 PNG 响应，并检查单端口开发启动。测试通过不代表尚未接入的 Redis 实例和 Python 工作进程已完成联调。
