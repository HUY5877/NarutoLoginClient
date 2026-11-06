# 测试环境 QQ 授权存储

抓号器通过 HTTPS 上传完整 QQ 授权，上号器列出当前网站用户保存的账号，并在用户选择后读取指定记录。客户端不直接连接 PostgreSQL。网站 Cookie 登录仍使用已有 `/api/auth/login`；新接口不接受独立的全局 API 密钥。

2026-11-06 合并 main 后，旧测试授权与 main 的任务抓号分别保存。旧加密授权使用 `naruto_login.qq_authorizations_encrypted`，main 抓号继续使用 `naruto_login.qq_authorizations`。仅测试环境核对真实数据库名为 `naruto_login_test` 后，在初始化事务内识别旧密文表并改名，保留原记录、ID、密文、索引与用户关联，不解密重写。两服务共用数据库事务锁；遇到未知、混合或冲突结构时回滚并报错，生产环境不会迁移旧密文表。

`GET /api/qq-authorizations` 继续支持 main 的本人抓号历史。测试环境配置旧授权密钥后，同时返回旧加密授权的元数据，按更新时间倒序排列，不返回授权内容。没有旧密钥时只读 main 抓号历史。旧 POST、按 ID 读取及删除仍只在测试环境开放，且只作用于旧加密授权。此次兼容验证仅使用临时数据库和合成数据，未连接真实数据库。

## 环境与初始化

- 仅 `APP_ENV=test` 提供旧授权的 POST、按 ID 读取及删除。正式环境这些接口返回 404，且不会构建或初始化旧授权数据库连接；main 抓号历史列表仍可用。
- Cloudflare 测试 namespace 须提供 `QQ_AUTHORIZATION_ENCRYPTION_KEY`，值为随机生成的 32 字节密钥的 64 位十六进制字符串。
- 密钥缺失或格式错误时，新接口返回 503；已有网站接口继续可用。进程环境中的同名业务配置不会覆盖所选 KV namespace。
- 数据库连接地址须指向 `naruto_login_test`。初始化还会执行 `SELECT current_database()`，实际名称不符就停止，不执行 DDL。
- 旧授权表是 `naruto_login.qq_authorizations_encrypted`，外键关联现有 `naruto_login.users(id)`。初始化使用数据库事务与 advisory lock，可重复运行。它不会创建或修改旧用户表。
- 可用 `new PgQqAuthorizationStore(config).initialize()` 初始化；用完须 `close()`。服务类 `QqAuthorizationService` 也提供这两个方法。

## 接口

全部请求沿用网站登录返回的 Cookie。列表、读取、上传及删除均只作用于登录用户自己的记录，管理员身份也不能越过这个限制。响应带 `Cache-Control: no-store`。

| 方法 | 路径 | 结果 |
| --- | --- | --- |
| POST | `/api/qq-authorizations` | 201 `{item}`，同一用户的同一个 QQ 账号更新现有记录 |
| GET | `/api/qq-authorizations` | `{items}`，按更新时间倒序；测试环境可同时含两种来源的元数据，旧授权仍最多保存 200 个账号 |
| GET | `/api/qq-authorizations/:id` | `{item,authorization}`；过期返回 410 |
| DELETE | `/api/qq-authorizations/:id` | 204；不存在或不属于本人均返回 404 |

上传格式如下，示意值不能用于实际登录：

```json
{
  "label": "我的一区",
  "authorization": {
    "schema_version": 1,
    "app_id": "1104307008",
    "captured_at_epoch_ms": 1792720800000,
    "callback_url": "auth://tauth.qq.com/#完整官方回调参数"
  }
}
```

`item` 仅含 `id`、`label`、`accountHint`、`capturedAt`、`expiresAt`、`updatedAt`、`expired`。时间均为 UTC ISO 8601 字符串；`accountHint` 为 OpenID 最后 6 位小写字符，用于区分账号，不含完整 OpenID。列表不会包含 token、回调或密文。备注为 1–40 个字符，拒绝控制字符、双向控制字符和损坏的 Unicode。

这个 POST 接口保留最大 64 KiB 的 JSON；main 的抓号上传和模型渠道接口保留各自的请求限制。上传前校验重复 JSON 键、重复回调参数、回调来源、应用编号、token 格式和时间。随后调用固定的 QQ 官方 `/oauth2.0/me` 校验 token 对应的应用与 OpenID；请求不跟随重定向，有超时与响应大小限制。网络校验失败不会写入新授权。

完整回调会保留 `pf`、`pfkey`、`pay_token` 等参数。有效期使用原回调的 `auth_time + expires_in`；缺少 `auth_time` 时使用保存的原始 `captured_at_epoch_ms`。下载不会重置捕获时间或续期。剩余不足 1 秒即视为过期。较早捕获的授权不会覆盖更新的授权。

## 数据与密钥

数据库中的完整授权使用 AES-256-GCM 加密，每次上传生成独立的随机 nonce。认证附加数据绑定所属网站用户、应用和账号指纹。OpenID 使用与用户绑定的 HMAC 指纹进行去重，数据库仅保存最后 6 位用于展示，不保存明文 token 或完整回调。

密钥仅放在服务端配置，不写入 Git、APK、数据库表或日志。更换密钥会使旧密文无法读取，并改变账号指纹；当前版本没有自动密钥迁移功能。需要保留旧记录时，必须先设计并验证迁移，不能直接替换 KV 密钥。

日志只记录固定错误码和服务位置，不记录请求体、授权、HTTP 查询地址或数据库驱动详情。新功能的错误不会将底层异常文本返回客户端。

## 验证

`npm run typecheck` 校验类型。`npm test` 包括授权解析、有效期、官方响应、加密绑定、账号隔离、容量、数据库名称守卫及 HTTP 限制测试。测试仅使用合成凭据和内存或模拟数据库，不连接真实 QQ、Cloudflare 或 PostgreSQL。实际测试环境建表和上传下载验证由部署步骤单独执行。

2026-10-23 已部署独立测试预览：`https://naruto-login-client-fx63s9ajo-sust-acmer.vercel.app`，`/api/health` 已确认 `environment=test`。全套 327 项自动测试通过，最后的 URI 校验修补后 11 项专项测试及类型检查再次通过。

实际测试库回归已验证：网站 Cookie 登录、官方 QQ 身份核验、完整回调上传后逐字段读回一致、列表无凭据、其他用户读取与删除返回 404、同账号重复上传更新原记录、数据库仅存密文、删除后无法读取。3 号模拟器上的两个 APK 已验证网站账号登录、列表显示和手动选择；测试会话、临时用户及授权记录已清理。新版 APK 中现场扫码自动上传与游戏进入成功尚未联合验证。

本次只发布测试预览。向 `main` 推送会触发正式发布，因此按本次测试环境范围保留本地提交，不推送生产分支。
