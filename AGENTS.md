# AGENTS.md

本仓库是一个 `pnpm` monorepo，用于开发和分发 `aw` CLI，以及面向 Codex 和 Claude Code 的插件。

## 项目基础

- 使用 `pnpm@10.33.0` 和 Node.js `>=20`。
- `pnpm build` 编译 CLI，并生成本地 catalog staging 和 runtime bundle。项目没有独立的 `typecheck` 命令；构建过程包含 TypeScript 类型检查。
- `packages/cli/dist/` 和 `packages/cli/plugins-dist/` 是生成目录，不要手工修改。

## 按任务读取

- 修改 CLI 写入流程、status、config、catalog/cache、平台边界或分发模型时，读取[架构说明](docs/architecture.md)。
- 修改 TypeScript 时，读取[编码约定](docs/coding-conventions.md)。
- 添加测试、修改公开合同或选择验证命令时，读取[测试指南](docs/testing.md)。
- 创建或修改插件，或修改 manifest/schema、adapter、scope、分发/安装流程及作者合同工具时，读取[插件维护指南](docs/plugin-maintenance.md)。
- 执行本地安装、打包或发布时，读取 README 的[开发与发版流程](README.md#本地开发与发版流程)。
