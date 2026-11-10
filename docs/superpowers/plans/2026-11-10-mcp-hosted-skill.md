# 服务端挂载业务技能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow the checklist below.

**Goal:** 将火影业务技能移入 MCP 服务代码目录，由服务器挂载，客户端按简短 instructions 读取。

**Architecture:** 保留 `@mastra/mcp 2.8.0` 和 `@mastra/core 1.82.0` 稳定版，使用 Mastra `resources.listResources/getResourceContent` 暴露固定 `skill://hyrz-service/SKILL.md`，复用现有认证。文件在 MCPServer 构造时读取并缓存，不增加业务工具。

**Tech Stack:** TypeScript ESM、Node、Mastra MCP、Vite SSR、Vercel。

**Spec:** 本聊天用户明确选择“保留 Mastra 最新稳定版，通过资源挂载 skill”；继续当前 `test` 分支。

## 验证与约束

- 技能保持业务、身份、私有二维码及单次工具调用要求；去除本机编码说明和绝对源码路径。
- instructions 只提醒阅读固定技能资源；不把整份内容塞入初始化说明。
- 新旧 MCP 协议均能列出和读取；未授权、跨站、其他 URI 不可读取本地文件。
- 构建及 Vercel 函数携带技能，资源正文与仓库文件逐字节一致。
- 只读线上检查不调用绑定、二维码或任务业务；不发送真实 QQ 消息。

## 步骤

- [x] 查清稳定版和预览版 API；用户确认沿用稳定版的资源挂载方式。
- [x] 新增资源读取与构建复制测试，先看到缺少挂载时失败，再实现。
- [x] 迁移技能及原有元数据；挂载资源并精简 instructions；补构建文件携带。
- [ ] 完成类型检查、相关与全量测试、构建、独立评审。
- [ ] 提交并推送 `test`，核对 Vercel Preview 与线上受认证资源读取。
- [ ] 将原本地入口改为指向仓库技能的兼容链接，并保存迁移、发布及读取证据。
