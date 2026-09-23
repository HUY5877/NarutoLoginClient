# NarutoLoginClient · 忍者日常登录中心

React / TSX 前端与 TypeScript 客户端后端放在同一个仓库。用户申请登录后，由客户端后端生成唯一任务 ID 和独立访问凭证，将任务投到 `NarutoDailyADB/naruto_daily/login_service` 的模拟 Redis 队列。任务服务使用 Python，为每个申请启动独立 Python 工作进程，生成模拟二维码并上传对象存储；客户端后端轮询存储，前端拿到 PNG 后显示。

**当前是可运行的本地模拟流程。** 二维码包含模拟会话数据，无法登录真实游戏；雷电进程启动、游戏打开、选择“与安卓好友玩”、切换账号及进入二维码页面均为模拟步骤。没有实现扫码确认、登录成功回调或游戏会话接管。

## 本地启动

客户端需要 Node.js 22.12+（推荐 Node.js 24）和 npm；当前项目中的任务服务需要 Python 3.11+。两个仓库分别安装依赖；无需 Redis、雷电模拟器或阿里云账号。

终端一，在现有 Python 项目根目录安装并启动任务服务：

```powershell
cd E:\code\NarutoDailyADB
python -m pip install -e ".[login-service]"
python -m naruto_daily.login_service
```

本机也已准备独立 Python 环境，可直接在该目录执行 `.\.venv-login-service\Scripts\python.exe -m naruto_daily.login_service`。

终端二，在本仓库根目录安装并启动客户端。根目录的 `npm ci` 会自动安装前端和后端各自的依赖：

```powershell
cd E:\code\NarutoLoginClient
npm ci
npm run dev
```

打开 <http://127.0.0.1:4300>，点击“生成登录二维码”。默认约几秒后可见二维码，申请有效期为 120 秒，过期后可以重新生成。

`npm run dev` 和 `npm start` 启动时会自动清理占用客户端 `PORT` 的进程，再使用原端口启动。在 Windows 上，同项目旧的 `tsx watch` 进程会一起停止，避免旧实例在修改代码后重新占用端口。无需增加配置；Linux/macOS 在端口占用时需要系统提供 `lsof` 命令。

默认配置可直接运行，不必创建 `.env`。需要修改时，客户端将项目根目录 `.env.example` 复制为 `.env`；Python 任务服务将 `naruto_daily/login_service/.env.example` 复制为同目录的 `.env`。不要覆盖已有配置。

| 进程 | 默认地址 | 职责 |
| --- | --- | --- |
| TS 客户端 | `127.0.0.1:4300` | 提供页面与 API，生成 ID、投递任务、验证申请凭证、轮询对象存储、传送二维码 |
| Python 任务服务 | `127.0.0.1:4320` | 模拟 Redis 队列、进程调度、二维码生成、存储写入与清理 |

开发时 Vite 作为客户端后端的中间件运行，页面、API 和热更新共用一个端口。只需修改 `PORT` 即可一起调整，无需配置前端代理或单独启动 Vite。

生产构建预览（仍需单独启动任务服务）：

```powershell
npm run build
npm start
```

同样打开 <http://127.0.0.1:4300>，由 TS 后端提供构建后的页面和 API。前端产物位于 `src/frontend/dist/`，后端产物位于 `src/server/dist/`；这些目录由构建命令生成，不提交到 Git。

## 执行路径

```text
TSX 页面
  POST /api/login-sessions
    → TS 客户端后端生成 UUID + 随机凭证 + expiresAt
    → POST 任务服务 /internal/tasks
    → 模拟 Redis LPUSH / BRPOP 队列
    → 独立 Python 子进程模拟雷电和游戏登录步骤
    → 写入 login/{id}/qr.png

TSX 页面每秒 GET /api/login-sessions/{id}
    → TS 客户端后端验证申请凭证并读取进度
    → HEAD 对象存储，确认 PNG 是否存在
    → 返回 qr_ready 后 GET /api/login-sessions/{id}/qr
    → TSX 显示 PNG，停止轮询，保留过期倒计时
```

默认 `STORAGE_DRIVER=local` 时，任务服务把对象写到 Python 项目根目录的 `.data/login-service/objects/login/{id}/qr.png`，提供受保护的模拟 OSS HEAD/GET 接口；客户端后端通过 HTTP 读取，不要求两个仓库共用文件路径。

队列是任务服务进程内的 Redis 列表语义模拟，通过内部 HTTP 接口访问，并不连接真实 Redis。服务重启会丢失队列和会话，页面会提示重新申请。每次申请对应独立子进程，并发数和队列容量在任务服务配置；模拟进程生成二维码后退出。真实雷电未来需要保留进程直到扫码完成或会话过期。

## 配置真实阿里云 OSS

两个项目都设置以下环境变量，使用相同地域和 Bucket：

```dotenv
STORAGE_DRIVER=oss
OSS_REGION=oss-cn-shanghai
OSS_BUCKET=your-private-bucket
OSS_ACCESS_KEY_ID=your-access-key-id
OSS_ACCESS_KEY_SECRET=your-access-key-secret
# 临时凭证可选
# OSS_STS_TOKEN=your-temporary-token
```

`OSS_KEY_PREFIX` 默认是 `login`，表示 Bucket 内对象键的目录前缀，例如 `login/{id}/qr.png`，无需重复配置；自定义时两边必须一致。

任务服务写入并删除二维码；客户端后端使用 `head` / `get` 检查并读取。可以为双方配置不同的最小权限 RAM 凭证：任务服务需要该前缀的 PutObject/GetObject/DeleteObject，客户端仅需 GetObject。二维码对象保持私有，浏览器不会拿到 OSS 密钥；图片由客户端后端转发，因此无需为浏览器配置 OSS CORS。

任务服务会按会话过期时间清理对象。真实 OSS 还应为此前缀配置合适的 Bucket 生命周期，以兜底进程异常退出后遗留的对象。设置 OSS 不会自动启用真实雷电，游戏步骤依旧模拟。已完成真实 OSS 上传、客户端读取和页面显示的在线联调。

## 可选配置

这些设置都有默认值，仅在需要调整时加入客户端 `.env`：

| 变量 | 默认值与用途 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4300`，客户端页面、API 和开发热更新的监听地址 |
| `LOGIN_SERVICE_URL` | `http://127.0.0.1:4320`，独立 Python 任务服务地址 |
| `SESSION_TTL_MS` | `120000`，申请有效期，支持 5 秒至 10 分钟 |
| `UPSTREAM_TIMEOUT_MS` | `5000`，访问任务服务的超时 |
| `ALLOWED_ORIGINS` | 默认空，额外允许的跨域来源，逗号分隔；同源使用无需设置 |

`SERVICE_TOKEN` 是客户端后端访问任务服务的共享凭证，与每次申请的独立访问凭证不同。两边默认使用 `local-development-token`，只允许回环地址本地开发，无需写入 `.env`；改为非回环监听时，必须为两边配置相同的强随机值。

## HTTP 接口

| 接口 | 结果 |
| --- | --- |
| `POST /api/login-sessions` | `202`，包含 `id`、`accessToken`、`status`、`createdAt`、`expiresAt`、`pollAfterMs`、`simulation` |
| `GET /api/login-sessions/:id` | 申请进度，必须携带 `Authorization: Bearer <accessToken>` |
| `GET /api/login-sessions/:id/qr` | `image/png`，同样需要申请凭证；过期返回 `410` |
| `GET /api/health` | 客户端后端自身状态，不代表任务服务或 OSS 已连接 |

状态：`queued → starting_emulator → opening_game → preparing_qr → qr_ready`；失败为 `failed`，过期为 `expired`。`qr_ready` 仅表示二维码可读取，不表示账号已登录。OSS 404 视为尚未生成；其他存储错误返回可重试错误，不伪装为“等待”。

## 目录与验证

前端采用 **shadcn/ui（Radix Nova）+ Tailwind CSS v4**，按钮、卡片、提示、进度、帮助弹窗、折叠面板和空状态均由官方 CLI 安装的组件组成；图标使用 Lucide，Geist 字体本地打包。主题通过 `src/frontend/styles.css` 的 shadcn CSS 变量配置，不再维护手写基础控件和装饰插画。

组件配置位于 `src/frontend/components.json`，在项目根目录新增组件可执行 `npm run ui -- <组件名>`，支持一次传入多个组件名。这会在前端包中运行官方 `shadcn add`，组件和新增依赖都归前端包管理。`@/` 指向 `src/frontend/`。扫码申请、轮询、过期与取消逻辑独立在 `hooks/use-login-session.ts`，更换界面不改变 API 协议。

前端和后端是两个独立 npm 包，各自维护 `package.json`、`package-lock.json`、`node_modules/` 和 `dist/`。根目录的 `package.json` 只编排安装、启动、构建和测试命令，不安装业务依赖。前端、后端和测试共用根目录的一份 `tsconfig.json`，路径别名也只在这里定义。前端的入口、Vite 配置和 shadcn 配置都放在 `src/frontend/`；后端通过 Vite 默认配置构建，无需额外构建配置文件。

```text
src/frontend/       TSX 登录页、shadcn 主题
  package.json      前端依赖与命令
  package-lock.json 前端依赖版本锁
  node_modules/     前端依赖（自动生成）
  dist/             前端构建产物（自动生成）
  index.html        页面入口
  vite.config.ts    前端构建与开发中间件配置
  components.json   shadcn CLI 配置
  components/ui/    官方 shadcn/ui 组件
  hooks/            登录申请与二维码轮询
src/server/         TypeScript HTTP 后端、任务网关、OSS 读适配器
  package.json      后端依赖与命令
  package-lock.json 后端依赖版本锁
  node_modules/     后端依赖（自动生成）
  dist/             后端构建产物（自动生成）
tests/              HTTP 接口、请求失败及存储轮询测试
package.json        统一执行命令
tsconfig.json       前端、后端和测试共用的 TypeScript 配置
```

```powershell
npm test
npm run build
```

测试覆盖 ID 隔离、队列失败、跨站申请拒绝、存储就绪判定、凭证拦截、过期竞态、PNG 返回、上游超时及相同 ID 重试。后端凭证仅在服务器环境变量中读取；浏览器申请凭证只保存在内存，关闭或刷新页面需重新申请。

Python 任务服务代码位于独立的现有仓库 [NarutoDailyADB](https://github.com/HUY5877/NarutoDailyADB) 的 `naruto_daily/login_service/`；详细队列、并发和模拟器扩展说明见该目录 README。客户端业务代码不依赖任务服务的实现语言，HTTP 协议保持一致。
