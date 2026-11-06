# hyrz MCP 设计

## 目标与边界

在现有网站的 `test` 分支提供 TypeScript / Mastra MCP server，名称 `hyrz`，地址 `/api/mcp`。保留现有 QQ 官方机器人 openid 绑定和任务流程。新增数字 QQ 绑定与 QQ → 网站用户 ID 查询；申请及查询二维码统一使用 `userId`。

## 方案

沿用 Express、PostgreSQL、Redis 和 OSS，不另建服务或任务队列。独立服务会重复网站的身份和任务规则，因此采用同站点接入。数字 QQ 无法通过公开机器人接口直接换取 openid；新增独立数字 QQ 关联，通过同一个网站用户间接关联原有 openid，既有表和字段保持原样。

MCP 仅供可信机器人后台接入。后台配置服务端 Bearer 密钥，不向普通用户分发；该后台负责传入可信 QQ 号及其解析出的用户 ID。`userId` 是业务选择参数，不是登录凭据，任意用户客户端不能凭它获得权限。网站用户不配置个人 Token。未配置密钥时 MCP 关闭，网站继续工作。每次操作核对账号存在且未停用。

用户后续确认采用共享 Token：从所选 Cloudflare KV 读取 `HYRZ_MCP_TOKEN`，可信客户端在 TOML 的 `Authorization: Bearer ...` 中传同一值，服务端比较一致性；不限制 Token 最短长度，不加 OAuth。`HYRZ_PUBLIC_URL` 改为可选覆盖，默认按每次连接的站点地址生成绑定链接，HTTPS 或本地 HTTP 根地址经严格校验，并发请求独立传递。

## 五个工具

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `bind_qq` | `qq` | 生成一次性确认链接，返回 QQ 号、链接及过期时间；不向 QQ 回调伪造消息 |
| `unbind_qq` | `userId` | 解除数字 QQ 关联，保留 openid 群提醒绑定 |
| `qq_to_userid` | `qq` | 查询已确认且有效的网站用户 ID |
| `request_qrcode` | `userId, requestId, loginType, userOptions` | 复用网站申请服务，保留重复提交、活动任务及数据库投递恢复规则，返回实际任务与参数 |
| `get_qrcode_status` | `userId, taskId` | 准备中 `running`；失败、过期或不可再扫码为 `error`；图片就绪为 `success` 并返回短期 OSS 签名 URL |

登录渠道与任务选项直接复用 `shared/login-types.ts` 和 `shared/user-options.ts`。重试同一次申请使用相同 `requestId`；只有新的申请才使用新 ID。不扩展注册、日志、刷新二维码或管理工具。

## 数字 QQ 确认

`bind_qq` 创建随机一次性令牌，只在数据库保存摘要，五分钟后过期。链接使用站点根页面的 URL fragment，避免令牌进入服务请求路径和访问日志。用户打开后在现有网站登录，页面明确显示 QQ 号和登录账号，由用户点击确认。未确认不保存关联；过期、重复用于其他账号、QQ 已属于其他账号时拒绝绑定。确认重复投递对同一账号幂等，解绑取消旧确认请求。保留既有 openid 数据，不从 QQ 头像等信息猜测号码。

确认正文包含页面展示的 `expectedUserId`，后端先与本次 Cookie 用户比较，不一致时拒绝写入并要求重新核对，不把它当作身份凭据。新链接创建时清理过期请求，仍有效的幂等记录及当前绑定保留。

## 二维码结果

只查询当前有效用户自己的任务。检查实际图片存在、任务期限、扫码/授权、刷新状态和二维码版本；签名后再次确认状态未变。OSS 链接最长 60 秒，且不超过本次扫码剩余期限。不公开 Bucket、不返回凭据。已签发链接在到期前具有访问能力，刷新可能替换同一对象，应重新查询；本地对象模式明确返回无法提供 OSS 链接。

签名的各次状态读取必须从实时任务取得，实时记录丢失时拒绝签发，不能采用数据库的网页恢复副本。

## 协议与交付

采用核对后的 `@mastra/mcp` 2.x 与当前 MCP `2026-07-28`（消息格式 JSON-RPC 2.0），开启旧客户端基本工具调用兼容。现有 TypeScript ESM 保留；Node 最低版本按 Mastra 要求提升到 22.13。

测试使用合成账号、受控依赖和临时数据库；检查真实 MCP HTTP 工具发现/调用、并发隔离、拒绝未认证调用、QQ 确认/冲突/过期/解绑、任务归属/重复申请/二维码失效。执行类型检查、相关测试和构建。后续按用户要求将提交推送 `origin/test`，并设置测试环境 Cloudflare 的 MCP Token；不部署，不连接真实 QQ、Redis、OSS 或生产数据库。

参考：<https://mastra.ai/reference/tools/mcp-server>；<https://modelcontextprotocol.io/specification/2026-07-28>；<https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md>。
