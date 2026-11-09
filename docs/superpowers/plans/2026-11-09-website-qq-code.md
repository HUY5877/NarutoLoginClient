# 网站 QQ 绑定码实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 登录用户发码，当前 QQ 机器人用真实发送者 QQ 自动兑换并关联该网站账号。
**Architecture:** 账号持有的一次性代码 + 独立新机器人绑定表/事务；MCP `bind_qq` 增加可选参数，无代码模式也使用新表；前端独立数字绑定 API，旧表与提醒逻辑保持不变。
**Tech Stack:** TypeScript / PostgreSQL / Mastra MCP / React / Node test / PGlite / Playwright。
**Spec:** `docs/superpowers/specs/2026-11-09-website-qq-code-design.md`

## Global Constraints

- 只在用户指定的 `test` 分支修改并推送，中文提交。
- 不根据用户正文选择 QQ 或网站 userId；Cookie 与可信 QQ 消息是各自身份来源。
- 代码 24 字符 base64url、5 分钟有效、摘要存储，重发撤销旧码；带错误码不能回退注册。
- 新表 `qq_robot_bindings` 与 `qq_robot_binding_codes` 独立，不读写、复制或自动迁移旧表；旧提醒不变。
- 保留旧用户和任务，不合并/删除；OpenID 和旧数字绑定链路保持兼容。
- 所有新机器人绑定和代码写入共享独立 PostgreSQL 事务锁。

## Review Focus

- 新表已绑定自动账号向网页登录账号转移，旧码不能夺回，旧表逐字保持。
- 同码不同 QQ 竞争与成功重试，解绑后重放不能恢复关联。
- 错误/过期/停用代码没有新用户或解绑副作用。
- Cookie 用户不受正文 userId 欺骗，状态不泄漏码明文。
- 关闭、换号和新码请求之间的旧异步响应不覆盖当前视图。

## Task 1：存储与服务

- [x] 先增加失败用例，再实现独立机器人绑定表、代码表、发码、状态及兑换方法。
- [x] 新增 service `createChallenge(userId)`、`getStatus(userId)`，`bind(qq,bindingCode?)` 分流。
- [x] 新机器人 16 项、旧链接 18 项测试通过，含双向旧表隔离快照。

## Task 2：网站接口与 MCP

- [x] 新增 `/api/qq-number-binding` 登录 GET/POST challenge/DELETE 接口与 HTTP 回归。
- [x] 扩展 MCP bindingCode schema，验证有代码和无代码分流、错误不回退；HTTP 23 项通过。

## Task 3：前端

- [x] hook 改用数字 API，移除二次确认。
- [x] 弹窗和入口显示新机器人、命令、倒计时、自动成功及已绑定 QQ。
- [x] 浏览器 8/8 通过，含到期前最后时刻兑换的最终查询回归；已检查 390px 手机布局。

## Task 4：接入与交付

- [x] 同步源码文档、QQ 技能与项目提示词；真实模型验证普通用户凭码绑定本人及过期码不降级注册。
- [x] 相关回归、类型检查、构建、独立审查。
- [x] 提交推送 test，核对部署和 QQ 工具 schema，保存验证记录。

## 验证范围

2026-11-09：相关 TypeScript 测试 57/57，浏览器 8/8，类型检查与前后端构建通过。独立审查发现的最终过期轮询问题已先复现失败再修复；框架将可选 null 删除重试的行为已用显式拒绝 null 防止降级注册，并有协议回归。

限并发完整测试真实退出码 1：519 项，517 通过、2 失败。`admin-interrupt.test.ts` 为文件级失败，单独复跑 10/10 通过；另一个为此前已在未修改基线复现的 Windows tsx watcher 父进程退出失败。未修改这些无关实现，不将全套报告为全部通过。

实现提交 `e1acf5ed1401d6d4b6a06f35a2214a57fd34526c` 已推送 `origin/test` 并通过 Vercel 发布。线上前端已显示新入口及机器人 QQ，新网站接口未登录返回 401；MCP schema 已包含 `bindingCode`。

本机只重载空闲 cc-connect，保留 NapCat、会话与历史。QQ 端仅 `bind_qq` 预先批准，主机仍为 suggest/read-only/on-request。真实 `gpt-6.1-sol` + 假 OneBot + loopback MCP（无真实业务数据）通过有效/过期码两次调用，QQ 与代码原样匹配，失败不省略代码注册，10 项审计检查通过。三个可恢复的旧 QQ 会话已无模型轮次地刷新业务规则；一个本已归档的旧会话保持归档。未在真实网站创建绑定或发送真实 QQ 消息。

完整本机验证记录：`D:\AI项目\QQ-Codex\docs\verification\website-qq-code-binding-verification.json`。
