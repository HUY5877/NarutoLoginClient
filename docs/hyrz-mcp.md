# hyrz MCP

在网站同一个服务提供 `POST /api/mcp`，名称为 `hyrz`。使用原生 TypeScript ESM、Mastra MCP 2.8.0、Core 1.82.0 和 MCP `2026-07-28`，消息格式为 JSON-RPC 2.0。Node.js 最低版本为 22.13。旧客户端的初始化、工具发现与调用通过 Mastra 的无会话兼容模式支持。

## 接入与配置

该接口使用一个共享 Token，供可信 MCP 客户端或机器人后台使用。服务器比较请求中的 Token 与配置是否一致，不需要额外的 MCP 登录流程。持有 Token 的调用方有权选择网站 `userId` 执行业务，所以机器人后台仍需从可信消息上下文识别用户，不能让普通用户任意替换他人的身份。QQ 号、用户 ID、任务 ID 都不是认证凭据。

在当前环境对应的 Cloudflare KV namespace 中配置以下键，沿用既有 `APP_ENV` 的正式/测试隔离：

| 键 | 含义 |
| --- | --- |
| `HYRZ_MCP_TOKEN` | 必填；不含空白的共享 Token，服务器和可信客户端配置同一个值，不限制最短长度 |
| `HYRZ_PUBLIC_URL` | 可选；仅供保留的旧网站绑定链接流程固定域名，HTTPS 根地址，本机开发允许 localhost HTTP。`bind_qq` 直接绑定不使用此配置 |

请求头设置 `Authorization: Bearer <HYRZ_MCP_TOKEN>`。Token 不一致或缺失时返回 401，服务端未配置时返回 503，网站其他功能继续工作。不要把共享 Token 放进仓库、网页、工具参数或日志。`bind_qq` 使用当前环境的数据库直接保存关联，无需网站 Cookie 或登录会话；返回 OSS 链接使用网站既有 OSS 配置。仅修改源码不会自动配置 KV 或发布。

Codex 客户端在 `~/.codex/config.toml`（Windows 为 `%USERPROFILE%\.codex\config.toml`）中加入以下内容，把网址和 Token 替换成实际值即可：

```toml
[mcp_servers.hyrz]
url = "https://你的网站域名/api/mcp"
http_headers = { Authorization = "Bearer 与服务器一致的Token" }
```

这里的 `http_headers` 会随每次 MCP HTTP 请求发送，写法见 [OpenAI 官方配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。只需地址和 Token，无需 OAuth 或单独配置站点根地址。修改后在客户端重新连接该 MCP。

使用支持 Streamable HTTP 的客户端连接本站 `/api/mcp`。当前协议每个请求的元信息和方法头由原生 MCP SDK 填写，建议使用 SDK，不手写不完整的 JSON-RPC 请求。旧协议下 Mastra 可能把联合结果放在 `structuredContent.result`，以其工具发现返回的输出结构为准。

## 工具

| 名称 | 参数 | 结果 |
| --- | --- | --- |
| `bind_qq` | `qq`，无前导零的数字字符串；可选 `bindingCode`，网页生成的 24 字符码 | `{qq,userId}`；有码关联生成码的现有账号，无码创建或复用账号 |
| `unbind_qq` | `userId` | `{userId,status:"unbound"}`，仅解除数字 QQ 关联 |
| `qq_to_userid` | `qq` | `{qq,userId}`，只读查询已绑定且未停用的网站账号，不创建用户 |
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

### 从网站账号发码后绑定当前 QQ

登录后打开「QQ 机器人绑定」，网站用已验证 Cookie 身份调用：

- `GET /api/qq-number-binding`：返回 `{enabled,binding:{qq,boundAt}|null,challenge:{id,expiresAt}|null}`，不返回码明文。
- `POST /api/qq-number-binding/challenge`：JSON 正文仅为 `{}`，返回 `{id,code,expiresAt}`。不接受正文 `userId`；跨站写入拒绝。
- `DELETE /api/qq-number-binding`：解除当前登录用户的数字关联并撤销绑定码，返回 204。

用户在群里 @ 当前机器人（QQ `3470367045`）发送 `绑定 <code>`。可信后台从真实消息取得 QQ，调用 `bind_qq({qq,bindingCode:code})`，立即绑定到该码所属网站账号；网页轮询自动显示结果，无需二次确认。此路径不新建用户，不接受调用方指定目标网站用户 ID。

代码为 18 随机字节的 base64url 字符串（24 字符），区分大小写，5 分钟有效，只在 `naruto_login.qq_robot_binding_codes` 保存 SHA-256 摘要。重新生成、解绑或转绑会撤销旧代码。已成功的同 QQ 重试只有在当前关联和绑定时间均未变时才幂等返回；其他 QQ 不能重放。

凭码兑换可将 QQ 从新表中无代码模式创建的账号转到码所属已登录账号，也可替换该网站账号原有的 QQ；原账号、任务和 OpenID 数据不删除或合并，新表关联变更和撤销新表旧代码在同一事务中完成。停用目标、无效码、过期码、撤销码必须返回错误，不能删去 `bindingCode` 重试成注册。显式传入 null 也返回格式错误；实现保留 null 至执行层后拒绝，以避免框架把非法可选 null 删除后当作无代码调用。

当前数字绑定入口替代原官方 OpenID 绑定弹窗；官方回调与旧表保留兼容。新机器人的二维码/任务提醒发送仍属于外部执行服务集成，绑定成功不代表提醒已经投递。

QQ 端当前部署不设置 `enabled_tools`、`disabled_tools` 或逐工具审批覆盖，按服务端运行时发现结果提供全部 `hyrz` 工具，不维护工具名称清单。仅可信 `hyrz` 服务设置 `mcp_servers.hyrz.default_tools_approval_mode="approve"`，统一预批准该服务的 MCP 调用；保留 `suggest` / `on-request` / `read-only` 主机权限。`auto` 是按工具风险决定是否询问，并不等于总是批准。服务预批准不替代可信消息身份核验或业务授权；机器人项目提示词和业务技能只为普通群友增加本人凭码绑定的例外，其他业务和主机操作权限不变。

### 不传网站码的直接创建/复用（兼容）

1. 可信机器人后台从已核验的真实消息上下文取得数字 QQ 号，在已有授权范围内调用 `bind_qq({qq})`。
2. 未绑定时，服务器在同一事务内创建已启用的普通网站用户并保存新机器人数字 QQ 关联，成功直接返回 `{qq,userId}`。新账号密码为随机值，不返回给客户端或用户，不写入日志。
3. 已绑定且账号有效时，返回现有 `userId`。相同 QQ 的重复或并发调用保持幂等，不重复创建账号；已有账号停用时拒绝操作，不重新启用，不另建账号绕过停用，也不转移已有绑定。
4. 后续可用 `qq_to_userid({qq})` 只读查询有效关联。该查询不会注册用户；未找到有效关联时仍按实际错误返回。申请和查询二维码传网站 `userId`，不能把 QQ 号当作用户 ID。

`bind_qq` 不创建待确认链接，不返回 `bindingUrl` 或 `expiresAt`。无代码模式不要求网页登录；有代码模式由已登录网站用户发码，兑换时不再网页登录。共享 Bearer token 认证可信客户端；QQ 参数必须来自可信消息身份，普通用户只允许凭码绑定本人，不授予其他工具/主机权限。QQ 专用部署按服务端运行时发现结果提供全部工具，可信服务统一预批准不改变这些身份与业务授权规则。修改配置和源码不代表已发布或完成真实业务验证。

新机器人的数字关联保存在独立 `naruto_login.qq_robot_bindings`，新用户保存在已有 `naruto_login.users`，绑定码摘要保存在 `naruto_login.qq_robot_binding_codes`。新流程不读写或自动迁移旧 `qq_number_bindings`、`qq_number_binding_requests`、官方 `qq_bindings` 或 `qq_binding_challenges`；旧接口与提醒逻辑保持原样。数据库失败时新表事务整体回滚。

现有 QQ 官方机器人的 `qq_bindings`、openid 字段和群提醒流程保留。数字 QQ 绑定与群提醒是两种独立标识，不猜测 QQ 号与 openid 的对应关系，不伪造官方机器人回调。`unbind_qq` 及 `qq_to_userid` 仅操作新机器人绑定表；旧数字关联和官方群提醒不变。

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

保留的旧网站确认页面浏览器测试为 `node --test tests/frontend-mcp-binding.integration.mjs`。可用 `PLAYWRIGHT_MODULE` 指定已有 Playwright 的模块路径，用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器程序。所有测试使用虚构账号、临时数据库和受控网络，不发送真实 QQ 消息，不连接真实 Cloudflare/Redis/OSS 或生产数据库。

协议与框架参考：[Mastra MCPServer](https://mastra.ai/reference/tools/mcp-server)、[MCP 规范](https://modelcontextprotocol.io/specification/2026-07-28)。
