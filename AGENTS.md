# AGENTS.md / CLAUDE.md

本文件是 Codex 和 Claude Code 共用的项目指令。仓库里的 `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接，用来让多个 agent 读取同一份约定，维护时只改这一份文件。

在当前仓库创建或维护同时支持 Codex 和 Claude Code 的双平台插件。

## Overview

`pnpm` monorepo，工作区定义在 `pnpm-workspace.yaml`，真正发布的包是 `packages/cli`（`@yiliang/aw`）。插件源码在 `plugins/`，插件作者工具在 `.agents/skills/create-agent-workflows-plugin/`。根目录 `README.md` 面向项目使用者，`docs/` 放公开维护文档，`docs/dev/` 只作开发过程记录。

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
- `pnpm run release:pack` / `make pack` — 生成 `.release/tarballs/` 下的本地 tarball
- `pnpm run release:local` / `make local-install` — 跑本地开发验证链路，并执行本地 `npm install -g`
- `make beta-release VERSION=x.y.z-beta.n` — 同步根目录和 `packages/cli/package.json` 版本号，跑完整校验后发布测试版 `beta` dist-tag
- `make release VERSION=x.y.z` — 同步根目录和 `packages/cli/package.json` 版本号，跑完整校验后发布正式版 `latest`
- `pnpm publish:cli` — 兼容旧入口；不改版本号，只发布当前已经写入的稳定版本到 `packages/cli/package.json` 的 `publishConfig.registry`

## References

- @docs/architecture.md — CLI 源码布局、三层分发模型、关键路径
- @docs/coding-conventions.md — TypeScript 风格、边界约定、核心类型
- @docs/testing.md — 测试规范、提交前检查清单
- @docs/plugin-authoring.md — 插件 manifest 约定、skill 触发规则、scope 语义
- @docs/plugin-installation.md — `aw` 安装、升级、状态检查与排障指南
