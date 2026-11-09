# AGENTS.md

本仓库是开发 `aw` CLI 与 Agent 插件的 pnpm monorepo。

## 项目基础

- 工具链版本以 `package.json` 的 `packageManager` 和 `engines` 为准。
- `pnpm build` 包含 TypeScript 类型检查，并生成 CLI、Catalog staging 和 runtime bundle；没有独立 `typecheck` 命令。

## 项目设计原则和复杂度门禁

- 面向个人本地使用，默认单一 `AW_HOME` 写锁。新增锁、持久状态或补偿机制前，必须证明高概率或高影响的实际风险，且简单恢复不足。
- 不为低概率且低影响的问题增加复杂度，代码评审也忽略此类建议。
- 失败必须保留恢复渠道；不得删除 foreign/shared 内容，弱状态损坏不得永久阻断清理。
- 新增持久或协调机制，修改并发、配置/状态写入、恢复或跨系统一致性，以及评审这些改动时，先读 `docs/maintainers/README.md#项目设计约束`。

## 文档维护

行为变化时更新唯一当前定义，同批更新实际消费者。维护文档或 Agent 阅读指针前，读 `docs/maintainers/README.md#文档维护`。

## 按任务读取

| 任务 | 必读路径 |
| --- | --- |
| 安装、同步、重建、移除、cleanup、共享归属 | `docs/maintainers/architecture/lifecycle.md` |
| CLI 命令、JSON 输出、退出码或非交互边界 | `docs/reference/cli.md` |
| 配置行为、状态证据或判定 | `docs/maintainers/architecture/config-and-status.md` |
| TUI 页面、键盘、导航、Review、结果或诊断投影 | `docs/maintainers/architecture/tui.md` |
| Catalog 来源、Active、缓存或 Store | `docs/maintainers/architecture/catalog-sources.md` |
| 外部 Catalog 格式或消费语义 | `docs/reference/catalog.md` |
| 作者声明、校验或版本语义 | `docs/reference/manifest-and-config.md` |
| manifest、资源、renderer 或 preApply | `docs/reference/manifest-and-config.md`、`docs/reference/plugin-runtime.md` |
| 托管命令或命令执行 | `docs/reference/managed-commands.md` |
| 原生工具或原生制品 | `docs/reference/native-tools.md` |
| 平台边界、Native/Portable 投影或 Windows helper | `docs/maintainers/architecture/platforms.md` |
| Review/Eval 准备、取证、执行或来源绑定 | `docs/maintainers/architecture/review-eval.md`、`docs/reference/review-and-eval.md` |
| TypeScript 改动 | `docs/maintainers/coding-conventions.md` |
| 测试改动、测试层级或验证命令选择 | `docs/maintainers/testing.md`，先通过 Test Value Gate |
| CI 工作流 | `docs/maintainers/ci.md` |
| 本地安装、打包、发布或发布恢复 | `docs/maintainers/release.md` |
| 具体插件维护、runner 用法或插件协议 | 该插件 README、相关 SKILL 及其条件引用；公共合同按对应 Reference 主题读取 |
| 插件或 Skill 的用户说明 | `docs/authoring/readme-standard.md` |
| 插件基础架构、manifest/schema、adapter、scope、分发/安装或作者工具 | `docs/maintainers/README.md#同步规则与所有权约束` |
