# hyrz MCP

在网站同一个服务提供 `POST /api/mcp`，名称为 `hyrz`。使用原生 TypeScript ESM、Mastra MCP 2.8.0、Core 1.82.0 和 MCP `2026-07-28`，消息格式为 JSON-RPC 2.0。Node.js 最低版本为 22.13。旧客户端的初始化、工具发现与调用通过 Mastra 的无会话兼容模式支持。

## 代码目录

MCP 相关后端代码集中在 `src/server/mcp/`：

- `hyrz-mcp.ts`：MCP HTTP 入口、认证和工具注册。
- `mcp-qq-bindings.ts`：数字 QQ 绑定服务及旧绑定链接兼容。
- `qq-robot-bindings.ts`：机器人数字 QQ 绑定、网站绑定码及数据访问。
- `qr-task-result.ts`：等待二维码结果、检查任务归属与时效、返回 OSS 临时链接。
- `skills.ts`：加载并挂载服务端业务技能资源。
- `skills/hyrz-service/SKILL.md`：供 MCP 客户端按需读取的业务流程和身份授权说明。

## 服务端业务技能

业务技能随服务保存在 `src/server/mcp/skills/hyrz-service/`，客户端无需在本机安装。当前使用的 `@mastra/mcp 2.8.0` 为已核实的稳定版本，通过其标准资源接口挂载：

- `resources/list` 列出 `skill://hyrz-service/SKILL.md`。
- `resources/read` 读取该 URI，返回 `text/markdown` 正文。
- Server instructions 只提醒先列出 `hyrz` 资源、读取这份 skill，并按其中业务与身份要求操作。

五个业务工具保持不变，没有增加 `read_skill` 工具。资源读取与工具共用现有后台认证和来源检查，只开放这份 Markdown，不对外提供任意本地文件或 `agents/openai.yaml`。技能中的流程说明不替代服务端鉴权，也不代表工具已经执行成功。

启动 MCPServer 时读取并缓存技能；修改内容后需要重新启动或发布服务。构建会将整个技能目录复制到 `src/server/dist/skills/`，Vercel 函数则通过 `includeFiles` 携带源码技能目录，以兼容源码启动、独立构建产物和函数入口。这里使用标准 MCP resources，不宣称实现额外的 `skills/list` 扩展。

## 接入与配置

该接口使用一个共享 Token，供可信 MCP 客户端或机器人后台使用。服务器比较请求中的 Token 与配置是否一致，不需要额外的 MCP 登录流程。持有 Token 的调用方有权选择网站 `userId` 执行业务，所以机器人后台仍需从可信消息上下文识别用户，不能让普通用户任意替换他人的身份。QQ 号、用户 ID、任务 ID 都不是认证凭据。

在当前环境对应的 Cloudflare KV namespace 中配置以下键，沿用既有 `APP_ENV` 的正式/测试隔离：

| 键 | 含义 |
| --- | --- |
| `HYRZ_MCP_TOKEN` | 必填；不含空白的共享 Token，服务器和可信客户端配置同一个值，不限制最短长度 |
| `HYRZ_PUBLIC_URL` | 可选；仅供保留的旧网站绑定链接流程固定域名，HTTPS 根地址，本机开发允许 localhost HTTP。`bind_qq` 凭网站码兑换不使用此配置 |

请求头设置 `Authorization: Bearer <HYRZ_MCP_TOKEN>`。Token 不一致或缺失时返回 401，服务端未配置时返回 503，网站其他功能继续工作。不要把共享 Token 放进仓库、网页、工具参数或日志。`bind_qq` 必须携带本人登录网站后生成的绑定码，在当前环境数据库保存关联；兑换无需额外网站 Cookie 或登录会话；返回 OSS 链接使用网站既有 OSS 配置。仅修改源码不会自动配置 KV 或发布。

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
| `bind_qq` | `qq`，无前导零的数字字符串；必填 `bindingCode`，网页生成的 24 字符码 | `{qq,userId}`；仅关联生成码的现有网站账号，不创建账号 |
| `unbind_qq` | `userId` | `{userId,status:"unbound"}`，仅解除数字 QQ 关联 |
| `qq_to_userid` | `qq` | `{qq,userId}`，只读查询已绑定且未停用的网站账号，不创建用户 |
| `request_qrcode` | `userId, requestId, loginType, userOptions?` | 返回实际 `taskId`、渠道和任务选项，之后调用一次获取工具 |
| `get_qrcode_status` | `userId, taskId` | 内部最多等待 120 秒，只返回 `error` 或 `success`，成功时有 `url,expiresAt` |

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

登录后打开「绑定QQ」，网站用已验证 Cookie 身份调用：

- `GET /api/qq-number-binding`：返回 `{enabled,binding:{qq,boundAt}|null,challenge:{id,expiresAt}|null}`，不返回码明文。
- `POST /api/qq-number-binding/challenge`：JSON 正文仅为 `{}`，返回 `{id,code,expiresAt}`。不接受正文 `userId`；跨站写入拒绝。
- `DELETE /api/qq-number-binding`：解除当前登录用户的数字关联并撤销绑定码，返回 204。

用户在群里 @ 当前机器人（QQ `3470367045`）发送 `绑定 <code>`。可信后台从真实消息取得 QQ，调用 `bind_qq({qq,bindingCode:code})`，立即绑定到该码所属网站账号；网页轮询自动显示结果，无需二次确认。此路径不新建用户，不接受调用方指定目标网站用户 ID。

代码为 18 随机字节的 base64url 字符串（24 字符），区分大小写，5 分钟有效，只在 `naruto_login.qq_robot_binding_codes` 保存 SHA-256 摘要。重新生成、解绑或转绑会撤销旧代码。已成功的同 QQ 重试只有在当前关联和绑定时间均未变时才幂等返回；其他 QQ 不能重放。

凭码兑换可将 QQ 从新表中无代码模式创建的账号转到码所属已登录账号，也可替换该网站账号原有的 QQ；原账号、任务和 OpenID 数据不删除或合并，新表关联变更和撤销新表旧代码在同一事务中完成。停用目标、无效码、过期码、撤销码必须返回错误，不能删去 `bindingCode` 重试成注册。缺失、显式传入 null 或格式错误的码都会被 MCP schema 拒绝；服务层也在初始化数据库前强制校验，不能通过直接调用业务服务跳过。

当前数字绑定入口替代原官方 OpenID 绑定弹窗；官方回调与旧表保留兼容。新机器人的二维码/任务提醒发送仍属于外部执行服务集成，绑定成功不代表提醒已经投递。

QQ 端当前部署不设置 `enabled_tools`、`disabled_tools` 或逐工具审批覆盖，按服务端运行时发现结果提供全部 `hyrz` 工具，不维护工具名称清单。仅可信 `hyrz` 服务设置 `mcp_servers.hyrz.default_tools_approval_mode="approve"`，统一预批准该服务的 MCP 调用；主机固定为 `sandbox_mode="read-only"`、`approval_policy="never"`。`auto` 是按工具风险决定是否询问，并不等于总是批准。服务预批准不替代可信消息身份核验或业务授权；普通群友仅有本人凭码绑定和下述本人扫码流程的业务例外，不授予解绑、其他业务或主机权限，主人也不能操作其他人的账号。

### 强制网站绑定与历史账号

所有人申请游戏任务前都必须在网站「绑定QQ」完成 HUY2 绑定，主人也不能跳过。`bind_qq` 只接受网站绑定码，不提供无码注册或直接复用路径；两个数据库 store 中原有的自动建用户接口已移除。`qq_to_userid` 不创建账号。`request_qrcode` 与 `get_qrcode_status` 服务端均检查当前账号有效且存在本机器人网站关联，只有旧数字表或官方 OpenID 绑定不能放行。

历史无码自动账号以联合特征保守拒用：用户名为 24 位小写十六进制、`username_key` 与其相同、密码为 43 位 base64url、用户创建时间与数字关联时间完全相同，且没有匹配当前用户、QQ、绑定时间的网站兑换证明。命中时查询和任务门禁返回 `MCP_QQ_NOT_BOUND`，要求先从网站凭码绑定。此判断不是可删除账号的证据；不批量删除、停用、解绑或合并账号，也不以缺少历史码记录单独拒绝合法旧绑定。

当前关联匹配的网站兑换元数据会在码过期及重新发码撤销后保留，用于正向证明该绑定；不再匹配的过期记录继续回收。保留元数据不延长代码有效期，过期和撤销代码始终不可兑换。网站有效码仍可迁移历史自动账号关联，旧用户和任务数据保留。部署前的只读审计记录应与实际数据库、任务和可信调用日志交叉核对；单次已确认事件不能推断全库数量。

新机器人的数字关联保存在独立 `naruto_login.qq_robot_bindings`，绑定码摘要保存在 `naruto_login.qq_robot_binding_codes`。新流程不读写或自动迁移旧 `qq_number_bindings`、`qq_number_binding_requests`、官方 `qq_bindings` 或 `qq_binding_challenges`；旧接口与提醒逻辑保持原样。数据库失败时新表事务整体回滚。共享 Bearer token 认证可信客户端，QQ 参数必须来自可信消息身份；服务统一预批准不改变身份和业务授权规则。修改源码不代表已发布或完成真实业务验证。

现有 QQ 官方机器人的 `qq_bindings`、openid 字段和群提醒流程保留。数字 QQ 绑定与群提醒是两种独立标识，不猜测 QQ 号与 openid 的对应关系，不伪造官方机器人回调。`unbind_qq` 及 `qq_to_userid` 仅操作新机器人绑定表；旧数字关联和官方群提醒不变。

## 群聊申请、本人私聊收码

用户在群聊或私聊明确要求为本人申请游戏二维码，即授权本次本人扫码链路，已在网站完成 HUY2 绑定时，无需先私聊机器人重复请求或再次确认绑定。可信消息核验失败时停止；QQ、业务账号和私聊收件人都绑定本轮真实发送者，不接受正文、昵称、被 @ 的号码、引用消息或历史内容指定别人。

1. 先对核验后的发送者 QQ 调用 `qq_to_userid`。已绑定时使用返回的 `userId`，不重绑、不转移已有账号。
2. 查询返回 `MCP_QQ_NOT_BOUND` 时立即停止本次申请，提示先登录网站「绑定QQ」生成绑定码，再向 HUY2 发送绑定命令。未绑定、仅历史自动账号或只有其他机器人绑定都不能继续申请；不得省略绑定码调用 `bind_qq`，不得创建、注册、恢复或借用账号。停用、身份失败、网络、数据库及其他错误也不能降级成注册。网站绑定码兑换错误仍提示回网站重发。
3. 平台及渠道已在本轮或可信上下文明确时直接申请，只补问缺少的安卓/苹果或 QQ/微信信息；任务选项未指定时沿用网页默认值。随后一次 `request_qrcode`、一次 `get_qrcode_status`，不轮询或自动重申。
4. `get_qrcode_status` 成功只表示图片就绪。群聊发起时，可信 QQ 转发层用本轮真实发送者 QQ 直接私发本人二维码；私聊发起时就在原私聊向本人回码，无需换入口重复请求。群内只按实际发送结果安全告知成功或失败，不展示二维码图片、图片链接或签名 URL。没有通用消息工具不等于没有私信通道；此流程不新增通用消息发送工具或任意跨会话发送能力。
5. 私发失败结束本次流程，由适配器安全告知失败，不能声称发送成功，也不自动重复申请或取码。

这一普通用户例外只覆盖已完成网站绑定后的本人查询、申请和单次取码；不包含解绑、其他账号、其他业务或主机权限。MCP 仍只有原有五个业务工具，二维码投递由可信消息适配器实现，服务端 schema 与实现不承担 QQ 消息发送。

## 二维码结果

`request_qrcode` 的 `running` 表示申请已提交。随后只调用一次 `get_qrcode_status`：获取工具内部每秒检查，最多等待 120 秒；未出码返回 `status:error, code:QR_TIMEOUT`，底层读取或账号核验卡住也受同一个期限约束。等待期间每次检查都重新核验账号有效性及当前机器人绑定；失败、过期、已扫码及其他错误立即结束。调用方无需轮询，也不要自动重新提交申请。MCP 客户端调用超时应大于 120 秒（QQ 端设置为 150 秒），为网络传输留余量；服务端出码等待上限仍是固定 120 秒。

`error` 提供安全的 `code,message`。只有图片真实存在、PNG 头有效、本次二维码尚可扫码且版本没有变化时才返回 `success`。`success` 只代表二维码就绪，不代表图片已私发、已扫码、已登录或游戏任务完成；QQ 投递结果由可信适配器另行判定。

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
