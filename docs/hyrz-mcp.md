# hyrz MCP

在网站同一个服务提供 `POST /api/mcp`，名称为 `hyrz`。使用原生 TypeScript ESM、Mastra MCP 2.8.0、Core 1.82.0 和 MCP `2026-07-28`，消息格式为 JSON-RPC 2.0。Node.js 最低版本为 22.13。旧客户端的初始化、工具发现与调用通过 Mastra 的无会话兼容模式支持。

## 接入与配置

该接口使用一个共享 Token，供可信 MCP 客户端或机器人后台使用。服务器比较请求中的 Token 与配置是否一致，不需要额外的 MCP 登录流程。持有 Token 的调用方有权选择网站 `userId` 执行业务，所以机器人后台仍需从可信消息上下文识别用户，不能让普通用户任意替换他人的身份。QQ 号、用户 ID、任务 ID 都不是认证凭据。

在当前环境对应的 Cloudflare KV namespace 中配置以下键，沿用既有 `APP_ENV` 的正式/测试隔离：

| 键 | 含义 |
| --- | --- |
| `HYRZ_MCP_TOKEN` | 必填；不含空白的共享 Token，服务器和可信客户端配置同一个值，不限制最短长度 |
| `HYRZ_PUBLIC_URL` | 可选；仅需固定绑定域名时填写 HTTPS 根地址，本机开发允许 localhost HTTP。默认使用本次 MCP 连接的网站地址 |

请求头设置 `Authorization: Bearer <HYRZ_MCP_TOKEN>`。Token 不一致或缺失时返回 401，服务端未配置时返回 503，网站其他功能继续工作。不要把共享 Token 放进仓库、网页、工具参数或日志。绑定链接使用本次连接的地址、数据库和已有网站登录；返回 OSS 链接使用网站既有 OSS 配置。仅修改源码不会自动配置 KV 或发布。

Codex 客户端在 `~/.codex/config.toml`（Windows 为 `%USERPROFILE%\.codex\config.toml`）中加入以下内容，把网址和 Token 替换成实际值即可：

```toml
[mcp_servers.hyrz]
url = "https://你的网站域名/api/mcp"
http_headers = { Authorization = "Bearer 与服务器一致的Token" }
```

这里的 `http_headers` 会随每次 MCP HTTP 请求发送，写法见 [OpenAI 官方配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。只需地址和 Token，无需 OAuth 或单独配置站点根地址。修改后在客户端重新连接该 MCP。

绑定链接默认按当前请求的站点域名生成，不直接采用 `X-Forwarded-Host`。Vercel 入口已信任平台的一层反代，能识别 HTTPS；自行部署反代时应正确传递站点 Host 并在受信任入口启用反代协议识别，或使用可选的 `HYRZ_PUBLIC_URL` 固定 HTTPS 域名。每次调用的地址通过独立请求上下文传递，并发连接不会互相覆盖。

使用支持 Streamable HTTP 的客户端连接本站 `/api/mcp`。当前协议每个请求的元信息和方法头由原生 MCP SDK 填写，建议使用 SDK，不手写不完整的 JSON-RPC 请求。旧协议下 Mastra 可能把联合结果放在 `structuredContent.result`，以其工具发现返回的输出结构为准。

## 工具

| 名称 | 参数 | 结果 |
| --- | --- | --- |
| `bind_qq` | `qq`，数字字符串 | `qq, bindingUrl, expiresAt`，只创建待确认链接 |
| `unbind_qq` | `userId` | `{userId,status:"unbound"}`，仅解除数字 QQ 关联 |
| `qq_to_userid` | `qq` | `{qq,userId}`，只返回已确认且未停用的网站账号 |
| `request_qrcode` | `userId, requestId, loginType, userOptions?` | 返回实际 `taskId`、渠道、任务选项及建议查询间隔 |
| `get_qrcode_status` | `userId, taskId` | `running`、`error` 或 `success`，成功时有 `url,expiresAt` |

`userId`、`taskId`、`requestId` 使用 UUID v4。`requestId` 由调用方生成，同一次申请重试保持不变；新的申请才换 ID。网站已有活动任务时复用原任务，返回的是原任务实际设置。不会绕过网站服务直接创建 Redis 任务。

登录渠道为 `android_qq`、`ios_qq`、`android_wechat`、`ios_wechat`。`userOptions` 与网页共用：`mainTask` 为 `daily` 或 `arena_weekly`；`equipmentStamina` 为布尔值；`secretRealmMode` 为 `once`、`all` 或 `skip`。省略时沿用网页默认的日常任务、刷装备栏体力、用完秘境扫荡券。

申请示例（全部为示意数据）：

```json
{
  "userId": "10000000-0000-4000-8000-000000000001",
  "requestId": "20000000-0000-4000-8000-000000000001",
  "loginType": "android_qq",
  "userOptions": {
    "mainTask": "daily",
    "equipmentStamina": false,
    "secretRealmMode": "skip"
  }
}
```

## QQ 绑定

1. 可信机器人后台用真实消息中的数字 QQ 号调用 `bind_qq`，把一次性链接回复给该用户。
2. 用户打开链接，在网站登录自己的账号。页面明确显示 QQ 号与网站账号，点击「确认绑定」后才保存关联。
3. 后台用 `qq_to_userid` 查询用户 ID，之后申请和查询二维码都传这个 ID。

链接五分钟有效，只在数据库保存随机令牌的 SHA-256 摘要。令牌位于 URL fragment，页面仅在 POST 正文提交，不保存到浏览器持久存储。生成新链接使同 QQ 的旧待确认链接失效；解绑和更换 QQ 后，旧链接不能重新恢复绑定。同 QQ 已属于另一个网站账号时拒绝接管。

确认请求同时提交 `token` 与页面正在展示的 `expectedUserId`。后端只按已验证的网站 Cookie 身份绑定，并先比较两个账号是否一致；不一致返回 `409 / MCP_BINDING_ACCOUNT_CHANGED`，不写入、不消费链接，页面要求重新核对账号后再次明确确认。生成新链接时会清理已过期请求，保留仍有效的重试记录和当前 QQ 绑定。

新增数据仅在 `naruto_login.qq_number_bindings` 与 `naruto_login.qq_number_binding_requests`。首个请求在已有用户表初始化后，以事务建表；现有 QQ 官方机器人的 `qq_bindings`、openid 字段和群提醒流程都保留。两种标识通过同一网站用户关联，不调用猜测 QQ 号与 openid 对应关系的接口，也不伪造官方机器人回调。

## 二维码结果

`running` 表示二维码仍在准备或刷新，可以按返回间隔查询；`error` 提供安全的 `code,message`。只有图片真实存在、PNG 头有效、本次二维码尚可扫码且版本没有变化时才返回 `success`。`success` 只代表二维码就绪，不代表扫码或游戏任务完成。

签名前后的查询都必须取得 Redis 中的实时任务状态。记录丢失或不可读时返回查询不可用，不使用网页恢复时的数据库副本签发图片链接；网页原有的任务恢复行为不变。

OSS URL 为私有对象的临时 GET 签名，不修改 Bucket 权限。有效期最长 60 秒，并且不超过当前二维码剩余期限。已签发 URL 在到期前具有访问能力；刷新可能替换同一路径的图片，应重新查询，不能依赖旧链接。已扫码、授权、任务结束或二维码过期时不再签发链接。本地存储模式明确返回不支持 OSS URL。

## 验证

```powershell
npm run typecheck
node src/server/node_modules/tsx/dist/cli.mjs --test --test-concurrency=2 tests/*.test.ts
npm run build
```

独立确认页面的浏览器测试为 `node --test tests/frontend-mcp-binding.integration.mjs`。可用 `PLAYWRIGHT_MODULE` 指定已有 Playwright 的模块路径，用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器程序。所有测试使用虚构账号、临时数据库和受控网络，不发送真实 QQ 消息，不连接真实 Cloudflare/Redis/OSS 或生产数据库。

协议与框架参考：[Mastra MCPServer](https://mastra.ai/reference/tools/mcp-server)、[MCP 规范](https://modelcontextprotocol.io/specification/2026-07-28)。
