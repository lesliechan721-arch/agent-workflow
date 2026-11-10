# AW 文档导航总览

欢迎查阅 Agent Workflows (AW) 文档。文档按读者角色与任务路径组织如下。

---

## 1. 终端用户与日常使用

面向在 Codex、Claude Code 等环境中使用 AW 插件的终端开发者。

| 文档 | 适用任务 | 主要内容 |
| --- | --- | --- |
| [用户快速入门指南](guide/getting-started.md) | 首次安装与日常操作 | CLI 安装、平台目标配置、用户/项目需求声明、插件安装、配置修改与生效、来源刷新与插件升级、同步与安全清理。 |
| [用户排障指南](guide/troubleshooting.md) | 异常诊断与故障恢复 | 按可观察症状排查：配置保存但应用失败、来源刷新失败与快照损坏、状态受阻/需同步、清理跳过文件、平台 CLI 缺失等。 |

---

## 2. 插件与 Catalog 作者

面向开发自定义 Agent 插件或分发独立插件市场的创作者。

| 文档 | 适用任务 | 主要内容 |
| --- | --- | --- |
| [开发你的第一个插件](authoring/first-plugin.md) | 编写单个插件源码 | 从零初始化脚手架、Manifest v4 声明、编写 Skill、验证与测试闭环、只读取证、配置与动态产物扩展、安全删除。 |
| [Catalog 作者指南](authoring/catalog.md) | 维护与分发插件市场 | 初始化 Catalog Workspace、版本管理、聚合构建、本地开发源调试、两阶段发布计划与授权应用、核心发布门禁。 |
| [插件与 Skill README 规范](authoring/readme-standard.md) | 编写面向人类的产品说明 | 人类 README、Agent 指令（`SKILL.md`）与评测（`evals/`）三者职责边界与内容规范。 |

---

## 3. 公开参考合同 (Reference)

面向外部作者、自动化工具链及仓外 Agent，提供唯一定义的精确机器与技术合同。

| 合同文档 | 核心主题 |
| --- | --- |
| [CLI 命令与输出](reference/cli.md) | 非交互命令、JSON 外壳、退出码、确认与生命周期 payload |
| [Manifest 与配置声明合同](reference/manifest-and-config.md) | Plugin Manifest v4 规范、Config Definition v5、本地 `$ref` 展开、Store v6 Envelope 存储与原子写入解耦。 |
| [插件运行时合同](reference/plugin-runtime.md) | 静态/动态 Skill 声明、readRuntimeConfig 合同、完整组件集合 v3、命令响应 v2、preApply 脚本与原生平台投影。 |
| [托管命令参考合同](reference/managed-commands.md) | 托管命令稳定 ID 算法（`cmdp_` 前缀）、参数权限（`argsPrefix`）、Claude Code 沙箱排除与执行生命周期。 |
| [原生工具参考合同](reference/native-tools.md) | 原生二进制工具依赖声明（`aw.windows-job.v1`）、平台工具 Reader 协议与平台包按需解析。 |
| [外部 Catalog 参考合同](reference/catalog.md) | 外部 Catalog Snapshot schema 7 规范、来源配置 schema 2、三层版本分层、发布计划与 Journal 状态机。 |
| [Review 取证与 Eval 评估合同](reference/review-and-eval.md) | 纯只读 Review 取证回执、证据缺口分析、来源绑定（sourceBinding）、EvalSpec v1 / EvalAudit v1 / EvalResult v2 机器合同。 |

---

## 4. 仓库维护者与贡献者

面向维护 AW CLI、Core 核心包、官方 Catalog 仓内插件与发版流水线的贡献者。

| 维护者文档 | 核心主题 |
| --- | --- |
| [AW 维护者指南](maintainers/README.md) | 维护者总入口、开发环境、源码与生成物边界、主题地图与日常文档维护规则。 |
| [编码约定](maintainers/coding-conventions.md) | TypeScript strict 规范、ESM 扩展名、小函数与共享类型约定。 |
| [测试指南与 Test Value Gate](maintainers/testing.md) | 测试分层（unit/integration/perf/smoke）、Vitest 并发预算与 Test Value Gate 门禁。 |
| [CI 说明](maintainers/ci.md) | GitHub Actions CI 矩阵、3 平台环境、自动 Beta 触发规则与产物边界。 |
| [官方发布与失败恢复指南](maintainers/release.md) | 官方 CLI 五包体系、本地一体发版、Actions 自动发布、版本占用与显式修复流程（`--repair-cli`）。 |

### 架构设计主题 (`maintainers/architecture/`)

- [插件生命周期](maintainers/architecture/lifecycle.md)：安装、同步、重建、移除与安全清理的底层事实、所有权标记与恢复语义。
- [配置与状态](maintainers/architecture/config-and-status.md)：意图声明、五类现场互斥状态、Store v6 结构与保存/生效解耦架构。
- [Catalog 来源](maintainers/architecture/catalog-sources.md)：多来源管理、Candidate/Active/Installed 三层分层、Active store 损坏恢复与缓存回收。
- [平台边界](maintainers/architecture/platforms.md)：Codex 与 Claude 生产环境解析、Native 与 Portable 投影、Windows Job Helper。
- [TUI 交互与能力覆盖](maintainers/architecture/tui.md)：全屏交互终端架构、四主面板、Review 取证展示与完整能力覆盖。
- [Review 与 Eval 架构](maintainers/architecture/review-eval.md)：审计引擎、评估数据流、进程收容与证据验证。
