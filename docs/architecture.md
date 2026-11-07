# Architecture

> [!NOTE]
> 本架构说明的所有主题已重组迁移至维护者架构文档（`docs/maintainers/architecture/`）与公开参考合同（`docs/reference/`）。各主题唯一权威当前正文见下方对应链接，维护总入口见 [AW 维护者指南](maintainers/README.md)。

## 设计边界

架构原则、弱状态与强配置边界见 [AW 维护者指南：开发环境与源码边界](maintainers/README.md#开发环境与源码边界)。

## CLI Source Layout (`packages/cli/src`)

源码模块划分与职责分工见 [AW 维护者指南：开发环境与源码边界](maintainers/README.md#开发环境与源码边界)。

### Module Invariants

原模块不变量与核心门禁已按领域归入对应唯一当前主题：

- **Renderer 上下文、敏感分批与产物扫描**：见 [插件运行时合同：动态 Renderer 与 ArtifactPlan 合同](reference/plugin-runtime.md#3-动态-renderer-与-artifactplan-合同) 与 [敏感文本扫描合同](reference/plugin-runtime.md#53-敏感文本扫描合同)。
- **写入管线、依赖拓扑、Ownership 与安全清理**：见 [插件生命周期：写入流程与确认](maintainers/architecture/lifecycle.md#写入流程与确认) 与 [Ownership 与删除权限](maintainers/architecture/lifecycle.md#ownership-与删除权限)。
- **配置持久化、敏感配置保护与正则校验**：见 [状态与配置：Config Store v6 持久化与写管线](maintainers/architecture/config-and-status.md#3-config-store-v6-持久化与写管线)。
- **Native/Portable 平台投影、共享 Marketplace 与 Windows 辅助**：见 [平台策略架构说明：Codex 原生集成](maintainers/architecture/platforms.md#2-codex-原生集成rollout-门禁与-project-activation) 与 [原生分组物化、Claude 边界与 Portable 技能](maintainers/architecture/platforms.md#3-原生分组物化claude-边界与-portable-跨平台技能)。

## Distribution and Runtime State

快照生成、传输校验与存储分层见 [外部 Catalog 参考合同](reference/catalog.md) 与 [Catalog 来源架构说明](maintainers/architecture/catalog-sources.md)。

### 平台与 Portable Skill

平台投影、Native 与 Portable 技能物化见 [平台策略架构说明](maintainers/architecture/platforms.md) 与 [插件运行时合同](reference/plugin-runtime.md#5-平台投影合同native-与-portable)。

### User 与 Project 联合恢复

需求声明、目标选择与恢复编排见 [插件生命周期：需求目标与输出](maintainers/architecture/lifecycle.md#需求目标与输出)。

## Catalog Sources

多来源配置、Active 状态与快照存储见 [Catalog 来源架构说明](maintainers/architecture/catalog-sources.md)；外部 Catalog 格式与版本规范见 [外部 Catalog 参考合同](reference/catalog.md)。

## Write Pipeline

写入流程、依赖拓扑与锁内检查见 [插件生命周期：写入流程与确认](maintainers/architecture/lifecycle.md#写入流程与确认)。

### preApply

声明、上下文输入、超时门禁与进程树治理见 [插件生命周期：preApply](maintainers/architecture/lifecycle.md#preapply) 与 [插件运行时合同：preApply 脚本合同](reference/plugin-runtime.md#4-preapply-脚本合同)。

## Live Status and Config

状态判定（ready/needsSync/orphaned/blocked/absent）、冲突证据及配置 Store v6 见 [状态与配置架构说明](maintainers/architecture/config-and-status.md)；配置声明合同见 [Plugin Manifest 与配置声明合同](reference/manifest-and-config.md)。

### TUI 批量插件写入

当前目标范围、分组、部分成功与精确重试见 [TUI：安装与批量目标](maintainers/architecture/tui.md#安装与批量目标)及[确认与结果](maintainers/architecture/tui.md#确认与结果)。

### TUI 导航流程

当前页面、焦点、Reader、返回与退出见 [TUI：浏览与完整阅读](maintainers/architecture/tui.md#浏览与完整阅读)及[返回、重载与退出](maintainers/architecture/tui.md#返回重载与退出)。能力入口见[能力覆盖](maintainers/architecture/tui.md#能力覆盖)。

### TUI v7.2 投影与键盘修复

原条目的有效条件已合入 [TUI 当前主题](maintainers/architecture/tui.md)：批量目标范围、完整阅读、位置结果、返回与退出、确认动作绑定、批量安装焦点。

### TUI 诊断投影与脱敏边界

当前定义见 [TUI：诊断与脱敏](maintainers/architecture/tui.md#诊断与脱敏)。

## Platform Boundaries

客户端家目录解析与环境隔离见 [平台策略架构说明](maintainers/architecture/platforms.md)。

### Codex shared native 与 project activation

Codex 原生市场投影、项目覆盖与私有缓存保护见 [平台策略架构说明：Codex 原生集成](maintainers/architecture/platforms.md#2-codex-原生集成rollout-门禁与-project-activation)。

## 托管命令

托管命令的完整声明、生命周期与运行合同见 [托管命令合同](reference/managed-commands.md)。

## 已安装运行配置

运行时已安装配置注入与读取见 [插件运行时合同：已安装配置读取合同](reference/plugin-runtime.md#2-已安装配置读取合同)。

## Windows 原生辅助程序

Windows Job Helper 构建、ACL 与进程治理见 [平台策略架构说明：Windows 原生辅助程序](maintainers/architecture/platforms.md#5-windows-原生辅助程序job-管理与交付流水线)。

## Agent Skill Eval 执行与 Runner 边界

评测引擎内部架构与数据流见 [Review 与 Eval 架构说明](maintainers/architecture/review-eval.md)；机器合同见 [Review 取证与 Eval 评估合同](reference/review-and-eval.md)。

## AW Review 准备、只读取证与来源绑定

只读 Review 取证管线与快照隔离见 [Review 与 Eval 架构说明](maintainers/architecture/review-eval.md#2-只读-review-取证管线内部实现) 与 [Review 取证与 Eval 评估合同](reference/review-and-eval.md#1-只读-review-取证合同aw-review-inspect)。

## 人读 Review

人读 Review 报告职责与边界见 [Review 取证与 Eval 评估合同](reference/review-and-eval.md#4-人读-review-报告合同)。

## Release Flow

官方 CLI 五包体系、Catalog 发布编排、Journal 状态机与失败恢复见 [官方发布与失败恢复指南](maintainers/release.md)。

## Key Paths

系统关键路径与源码布局见 [AW 维护者指南：开发环境与源码边界](maintainers/README.md#开发环境与源码边界)。
