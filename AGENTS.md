# AGENTS.md / CLAUDE.md

本文件是 Codex 和 Claude Code 共用的项目指令。仓库里的 `CLAUDE.md` 是指向 `AGENTS.md` 的符号链接，用来让多个 agent 读取同一份约定，维护时只改这一份文件。

在当前仓库创建或维护同时支持 Codex 和 Claude Code 的双平台插件。

## Overview

`pnpm` monorepo，工作区定义在 `pnpm-workspace.yaml`。CLI 发布包是 `packages/cli`（`@lesliechan721/aw`）；插件通过独立的 sidecar/full catalog 包 `@lesliechan721/aw-plugins-manifest` 和 `@lesliechan721/aw-plugins` 分发。插件源码在 `plugins/`，插件作者工具在 `.agents/skills/create-aw-plugin/`，标准静态/AW 插件 Skill 的只读评审工具在 `.agents/skills/skill-review/`。根目录 `README.md` 面向项目使用者，`docs/` 放公开维护文档，`docs/dev/` 只作开发过程记录。

## Maintenance Principles

- 改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发/安装流程，或任何会影响插件作者使用方式的能力时，必须同时检查 `.agents/skills/create-aw-plugin/`。如果插件作者技能、模板、示例或测试夹具不再准确，要在同一轮修改中更新，避免运行时能力和作者文档脱节。

## Build & Test Commands

- `pnpm install` — 安装工作区依赖
- `pnpm build` — 编译 `@lesliechan721/aw`，并生成本地 catalog staging / runtime bundle（`packages/cli/plugins-dist`）
- `pnpm test` — 运行全部 Vitest 用例
- `pnpm test:unit` — 只跑单元测试
- `pnpm test:integration` — 验证 CLI 命令编排、adapter 集成和夹具行为
- `pnpm test:coverage` — 生成覆盖率报告
- `pnpm test:smoke` — 验证真实 build/pack 产物（不进入常规 `pnpm test`）
- `pnpm test:smoke:build` — 只校验 `pnpm build` 产物
- `pnpm test:smoke:pack:cli` — 校验 CLI tarball 内容
- `pnpm test:smoke:pack:catalog` — 校验 sidecar/full catalog tarball 内容
- `pnpm test:smoke:pack` — 串行校验 CLI 与 catalog tarball
- `pnpm test:smoke:fetch` — 校验 catalog fetch / selector / cache fallback 相关 smoke
- `pnpm plugin:test <plugin>` — 运行单个插件的 Node 脚本测试；`--all` 才会让任一坏插件阻断整轮
- `pnpm plugin:change:add <plugin> --bump <kind> --summary <text>` — 为已有插件的开发期 production 变化添加 release intent，不直接递增 plugin version
- `pnpm plugin:version:check -- --base <git-ref>` — 作者门禁：使用当前 production bundler 检查已有插件相对 Git 基线的 production 变化是否有 release intent；新插件保留初始 version 且不创建 intent；先运行 `pnpm build`
- `pnpm plugin:release:apply --all` / `pnpm plugin:version:check:release -- --base <git-ref>` — 稳定发布前统一应用 intent（没有 intent 时成功跳过），并校验 plugin version 已递增
- `pnpm plugin:eval <plugin> --skill <skill> --batch-name <name>` — 按 owner Skill 根 `evals/manifest.json` materialize Codex 最终制品并运行本地显式模型 eval；`--materialize-only` 不调用模型，后续运行用输出的 `--batch-id` 追加同一批次
- `node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs <skill> --validate-only` — 校验 `.agents/skills/<name>` 的静态 Skill eval 合同；真实模型运行必须传 `--batch-name` 或 `--batch-id`，并按需传 suite、split、case、runs 和 model 等参数
- `pnpm test:smoke:plugin-scripts` — 校验真实插件脚本 staging、依赖闭包和 bundle 布局
- `make verify-cli` / `make verify-catalog` / `make verify-release` — 分别校验 CLI-only、catalog-only、组合发布链路
- `pnpm run release:pack:cli` / `make pack-cli` — 生成 CLI 本地 tarball
- `pnpm run release:pack:catalog -- --catalog-version x.y.z` / `make pack-catalog CATALOG_VERSION=x.y.z` — 生成 sidecar/full catalog tarball
- `pnpm run release:pack -- --catalog-version x.y.z` / `make pack CATALOG_VERSION=x.y.z` — 同时生成 CLI 与 catalog tarball
- `pnpm run release:local` / `make local-install` — 跑 CLI 本地发布验证链路，并执行本地 `npm install -g`
- `make beta-release CLI_VERSION=x.y.z-beta.n CATALOG_VERSION=a.b.c-beta.n` — 校验并发布 CLI 测试版和 beta catalog
- `make release CLI_VERSION=x.y.z CATALOG_VERSION=a.b.c` — 校验并发布 CLI 正式版和 latest catalog
- `pnpm publish:cli` — 兼容旧入口；不改版本号，只发布当前已经写入的稳定版本到官方 npm registry

## References

- @docs/architecture.md — CLI 源码布局、三层分发模型、关键路径
- @docs/coding-conventions.md — TypeScript 风格、边界约定、核心类型
- @docs/testing.md — 测试规范、提交前检查清单
- @docs/plugin-authoring.md — 插件 manifest 约定、skill 触发规则、scope 语义
- @docs/plugin-installation.md — `aw` 安装、升级、状态检查与排障指南
