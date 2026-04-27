# CLAUDE.md

在当前仓库创建或维护同时支持 Codex 和 Claude Code 的双平台插件。

## Overview

`pnpm` monorepo，工作区定义在 `pnpm-workspace.yaml`，真正发布的包是 `packages/cli`（`@yiliang/aw`）。插件源码在 `plugins/`，插件作者工具在 `.agents/skills/create-agent-workflows-plugin/`。

## Build & Test Commands

- `pnpm install` — 安装工作区依赖
- `pnpm build` — 编译 `@yiliang/aw` 并生成 `packages/cli/plugins-dist` runtime bundle
- `pnpm test` — 运行全部 Vitest 用例
- `pnpm test:unit` — 只跑单元测试
- `pnpm test:integration` — 验证 CLI 命令编排、adapter 集成和夹具行为
- `pnpm test:coverage` — 生成覆盖率报告
- `pnpm test:smoke` — 验证真实 build/pack 产物（不进入常规 `pnpm test`）
- `pnpm test:smoke:build` — 只校验 `pnpm build` 产物
- `pnpm test:smoke:pack` — 只校验 `pnpm pack:cli` 的 tarball 内容
- `pnpm pack:cli` — 打包 `@yiliang/aw`，发包前验收

## References

- @docs/architecture.md — CLI 源码布局、三层分发模型、关键路径
- @docs/coding-conventions.md — TypeScript 风格、边界约定、核心类型
- @docs/testing.md — 测试规范、提交前检查清单
- @docs/plugin-authoring.md — 插件 manifest 约定、skill 触发规则、scope 语义
