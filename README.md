# 忍者日常登录中心

React 前端与 TypeScript API 共用一个站点。用户扫码登录后，由配套的 NarutoDailyADB 执行端完成日常任务。

## 启动

需要 Node.js 22.12+、npm，以及 PostgreSQL、Redis。首次安装后，将 `.env.example` 复制为 `.env` 并填写配置；已有 `.env` 请保留。

```powershell
npm ci
npm run dev
```

访问 http://127.0.0.1:4300。开发、页面和 API 共用此端口；启动命令会清理占用该端口的旧进程。

## 配置

| 配置 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL，保存账号、审批与申请记录 |
| `JWT_SECRET` | 至少 32 字节的随机签名密钥，同环境保持一致 |
| `REDIS_URL` | 与 ADB 执行端连接同一实例、同一 DB |
| `STORAGE_DRIVER` | 线上使用 `oss`；本地模拟可用 `local` |
| `OSS_REGION`、`OSS_BUCKET` | 二维码所在区域与私有 Bucket |
| `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` | 后端读取 OSS 的凭据 |

客户端与执行端的 `REDIS_QUEUE_KEY`、Bucket 和 `OSS_KEY_PREFIX` 必须一致。默认队列为 `naruto:login:tasks`，对象前缀为 `login`。其他配置见 [.env.example](.env.example)，密钥不要提交到 Git。

数据库使用独立的 `naruto_login` 库，首次使用时自动初始化表。注册需管理员审核，首个管理员需在数据库中指定。当前密码按项目既有约定明文存储，API 不返回密码。

## 使用

- 选择安卓 QQ、iOS QQ、安卓微信或 iOS 微信渠道后，点击「启动模拟器获取二维码」，使用对应的手机 QQ 或微信扫码授权；同一账号复用有效申请，刷新沿用原渠道。
- 点击「刷新二维码」更新当前实例的二维码。排队默认等待 5 分钟，领取实例后有 10 分钟扫码时间，刷新不续期。
- 授权后自动进入游戏并执行日常。执行端负责失败后的实例清理和会话释放，网页可查看执行记录。
- 管理员可审批注册、管理用户、查看近七天刷日常情况和月度排行榜。
- 月榜按新申请统计次数，按北京时间去重统计日常天数；失败和过期也计入，刷新二维码和重复提交不重复计数。

登录渠道通过顶层 `loginType`（`android_qq`、`ios_qq`、`android_wechat`、`ios_wechat`）随申请、Redis 队列和刷新指令传给执行端，数据库与执行记录保留首次选择；旧申请默认安卓 QQ。需配套更新 NarutoDailyADB 执行端。

近七天列表显示每次申请的登录渠道，可按日期筛选今天及之前六天，也可查看全部七天；月榜读取数据库中的历史申请，不受执行日志过期影响。执行记录默认保留七天，需要配套更新并重启 ADB 服务；已经过期的旧日志无法补回。

## 构建与部署

```powershell
npm test
npm run build
npm start
```

生产预览仍使用 4300 端口。构建产物位于 `src/frontend/dist` 和 `src/server/dist`，不提交到 Git。

仓库已关联 Vercel 项目 `sust-acmer/naruto-login-client`，生产分支为 `main`，推送后由 Vercel 自动构建。线上环境变量需在 Vercel 配置；修改后重新部署才生效。ADB 执行端独立运行，更新执行端代码后需重启对应服务。

接口和依赖异常会写入结构化错误日志，可在 Vercel Logs 中用响应头 `X-Request-Id` 关联同一次请求。日志保留失败阶段、错误码及必要耗时，不记录请求正文、Cookie、SQL 参数或连接凭证；正常请求不新增日志。

## 代码位置

- `src/frontend/`：页面、交互和 shadcn/ui 组件。
- `src/server/`：账号、管理接口、PostgreSQL、Redis 和 OSS。
- `src/shared/`：前后端共用类型与统计口径。
- `api/`、`vercel.json`：Vercel 入口与路由。
- `tests/`：回归测试，使用模拟服务，无需生产凭据。
