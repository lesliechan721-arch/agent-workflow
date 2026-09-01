# AGENTS.md

本仓库是一个 `pnpm` monorepo，用于开发和分发 `aw` CLI，以及面向 Codex 和 Claude Code 的插件。

## 项目基础

- 使用 `pnpm@10.33.0` 和 Node.js `>=22`。
- `pnpm build` 编译 CLI，并生成本地 catalog staging 和 runtime bundle。项目没有独立的 `typecheck` 命令；构建过程包含 TypeScript 类型检查。
- `packages/cli/dist/` 和 `packages/cli/plugins-dist/` 是生成目录，不要手工修改。

## 项目设计原则和复杂度门禁

- 本项目是个人本地工具，不为高并发设计。默认只使用一个 `AW_HOME` 写锁；只有已证明的真实并发边界才可以增加锁。
- CLI 和 Catalog 是公开产品，支持多个 Catalog 来源。每个来源可独立失败；不要求来源之间或 npm 与 Git 之间强一致。
- plugin config、catalog source config 和 catalog state 是强配置，写入必须原子提交。version-scoped publication journal 是强恢复和门禁状态，也必须原子写入。plugin outputs、依赖现场、lifecycle snapshot、Catalog store snapshot 和 prepared release 是可删除、可重建的弱状态。
- 插件安装依赖第三方工具，且用户可能手动修改其结果。动作应尽力完成，并允许部分成功；不要为不可控现场承诺完全正确或补偿回滚。
- 每条失败链必须保留 `cleanup`、`cleanup --force`、`reinstall`、source sync 或发布新版本中的至少一种恢复方式。安全边界不得删除 foreign 或 shared 内容；弱状态损坏也不得永久阻止清理。
- CLI/npm 远端发布失败或结果不确定后，普通发布必须提升版本，不得直接续跑同一候选；CLI 显式 repair 仍绑定未变化的 prepared descriptor 和 attempt。Catalog 对同一 journal plan 可对账或续跑，不同 plan 必须提升版本。隔离 Git repo 是 pending plan 的暂存 artifact；`prepared` 或 `uncertain` 的 journal 或 repo 缺失或损坏时，不得盲目重建或复用该版本，必须停止并提升版本。`published` journal 缺失时，远端 immutable tag 仍占用版本。首次远端写入前保存隔离 Git repo，成功后删除 repo 并保留 JSON journal。
- 新增 ledger、持久合同、摘要协议、锁层级、事务、补偿或迁移状态机前，必须证明高概率或高影响的可观察风险，且简单恢复渠道不足。低概率且低影响的问题不得增加代码复杂度；代码评审也忽略这类会增加复杂度的建议。

## 按任务读取

- 修改 CLI 行为、公开合同、写入流程、status、config、catalog/cache、平台边界或分发模型时，读取[架构说明](docs/architecture.md)。
- 修改 TypeScript 时，读取[编码约定](docs/coding-conventions.md)。
- 添加或修改测试、选择测试层级或选择验证命令时，读取[测试指南](docs/testing.md)，并先通过 Test Value Gate。
- 创建或维护 `plugins/<name>/`，或修改 manifest/schema、adapter、scope、插件分发/安装流程或作者合同工具时，读取[插件维护指南](docs/plugin-maintenance.md)和相关架构说明。
- 执行本地安装、打包或发布时，读取 README 的[开发与发版流程](README.md#本地开发与发版流程)。
