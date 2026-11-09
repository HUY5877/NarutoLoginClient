# QQ 直接绑定实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `bind_qq({qq})` 自动创建或复用用户并返回 `{qq,userId}`，QQ 端可发现并调用该工具。

**Architecture:** 数字 QQ 绑定服务在一个数据库事务内查找旧关联或创建普通用户和关联，使用现有写锁解决并发。HTTP MCP 只切换到新方法；网站旧确认流程兼容保留。

**Tech Stack:** TypeScript、PostgreSQL、Mastra MCP、Node test、PGlite；现有 Codex app-server 和 cc-connect TOML。

**Spec:** `docs/superpowers/specs/2026-11-09-direct-qq-binding-design.md`

## Global Constraints

- 用户明确指定 `test`；所有提交中文，仅推送 `origin/test`。
- 真实 QQ 号来自可信消息上下文，维持现有身份及审批规则。
- 新用户非管理员、可用、随机密码不回传；旧停用用户不能自动复活。
- 原子幂等绑定，兼容原已绑定账号，不变更官方群提醒和 OpenID 数据。
- QQ 端只启用 `bind_qq`，不顺带开放其他后台工具；不记录凭据。

## Review Focus

- 并发重试只能产生一个关联和一个用户。
- 已有旧绑定复用，停用用户不被绕过。
- 新用户创建失败或关联失败要整体回滚。
- 用户名冲突不关联到不相干网站账号。
- 工具声明、实际返回、文档和运行时技能一致。

## Task 1：直接绑定服务

- [x] 在 `tests/mcp-qq-bindings.test.ts` 先增加失败用例。
- [x] 在 `src/server/mcp-qq-bindings.ts` 增加 store/service `bind(qq)`。
- [x] 跑服务测试，验证幂等、回滚、旧关联、停用和非法输入（PGlite 连接串行化，不等同于真实 PostgreSQL 多连接锁竞争测试）。

## Task 2：MCP 接口和集成

- [x] 先更新 `tests/hyrz-mcp.test.ts`，验证无 Cookie 首次与重复绑定。
- [x] 在 `src/server/hyrz-mcp.ts` 返回 `{qq,userId}` 并更新 `src/server/app.ts` 依赖类型。
- [x] 更新文档、相关 mock，跑相关测试、类型检查和构建。
- [x] 独立代码审查通过；提交并推送目标为 `test`。

## Task 3：QQ 部署

- [x] 同步 QQ 项目技能和本机技能的绑定说明。
- [x] 备份现有配置，将 QQ 的 MCP override 改为只开放 `bind_qq`。
- [x] 核对线上测试站工具 schema，重启空闲 cc-connect。
- [x] 验证工具发现、QQ 在线和历史保留，记录实际部署结果。

## 实现验证记录

2026-11-09：绑定服务测试 26/26，真实 HTTP MCP 测试 18/18，类型检查和前后端构建通过。独立审查及本地原生 MCP SDK schema 验证通过。

限并发全量测试 514/515 通过；唯一失败为 `tests/port.test.ts` 的 Windows tsx watch 父进程退出测试。在未修改的 `219c9343fb0fa71fe79b0b7f3f7aaafea222b711` 隔离快照上单独运行同一用例，也以相同错误退出 1。本次未修改端口实现和测试，不将全量报告为全部通过。

## 测试站与 QQ 部署验证

实现提交 `899541d9943d2ec94ea6e285a7f7000f7f36def7` 已推送 `origin/test`，Vercel 发布成功；`https://test.huy1.site/api/mcp` 的线上工具声明确认 `bind_qq` 返回 `userId`，不再返回绑定链接。

QQ 专用配置已备份后改为 `hyrz.enabled=true` 且 `hyrz.enabled_tools=["bind_qq"]`，只重载空闲的 cc-connect，保留 NapCat、身份校验、沙箱和审批。实际原生 Codex 的新会话与原 QQ 聊天恢复均只发现该业务工具，并确认新版输出 schema；QQ 在线，原会话绑定和历史条数保持一致。此次部署未调用真实绑定、解绑或二维码业务，也未发送真实 QQ 消息；首次实际绑定由用户在 QQ 发起。

完整本机验证记录：`D:\AI项目\QQ-Codex\docs\verification\hyrz-direct-binding-verification.json`。
