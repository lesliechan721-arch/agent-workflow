---
name: develop-aw
description: >-
  涉及 AW 插件及其 Skill 的分析、创建、修改、评审、简化、验证或物化时使用，也用于维护 AW Catalog Workspace、依赖、版本和本地开发源。提供来源、构建共享、平台投影与 Portable Agent Skills 分发方法。
user-invocable: true
compatibility: 采用通用方法时依赖 agent-content-toolkit 和 agent-skill-toolkit；执行 AW 工具时需要 Node.js 22+、PATH 中提供公开作者命令的 aw CLI 及相应工作区依赖。
metadata:
  short-description: 处理 AW 插件与 Skill，提供来源、构建和物化方法
---

# Develop AW

确定 AW 对象、权威源码和本次所需产物，完成相应操作。Skill 创作采用 `author-agent-skill`，Agent 内容采用 `agent-content`。当前任务已采用评审、简化或 Eval 方法时，本技能提供 AW 事实与工具操作；质量判断、候选接受和实验策略由相应方法负责。

## 确定目标与证据

从用户路径、当前文件和已有回执确认 Workspace、Plugin、源 Skill 或运行包，保留用户要求、允许修改范围和执行限制。复用仍有效的资料；目标不唯一或缺少决定性输入时再补齐。

| 本次需要 | 处理方式 |
| --- | --- |
| 理解或修改可见源码、职责和文字 | 使用源码及相关声明 |
| 核对实际内容、调用 metadata 或注入资源 | 固定 platform/scope/config，复用当前 final；不足时按授权准备运行包 |
| 导出标准 Agent Skills | 核对显式 Portable 声明，再物化所选 Skill |

完整运行包不以创建 Eval 为前提，源码分析不以构建或 Portable 导出为前提。

## 使用 AW 工具

首次调用前，从本 Skill 实际 root 运行：

```bash
aw self check --from <skill-root> --json
```

命令缺失或 `ok=false` 时说明缺少的能力，继续可完成的静态工作，停止依赖缺失能力的操作。字段和参数从当前 `aw plugin capabilities --json`、所需 `--surface` 与命令 `--help` 取得。

Workspace 使用用户明确位置、canonical `<root>/plugins/<name>` 的归属或公开 CLI 的解析结果。普通修改不隐式初始化另一个 Workspace。修改落在权威 source/provider；生成物和来源绑定由工具维护。

## 按当前决定读取资料

| 当前任务 | 资料 |
| --- | --- |
| 解析 source/final/profile、修改 owner，或准备一个和多个版本 | [来源与运行包](references/source-materialization.md) |
| 创建、修改、注册或验证 Plugin | [Plugin 开发](references/plugin-development.md) |
| 选择组件、配置、安装态配置读取或生命周期脚本 | [组件方法](references/plugin-components.md) |
| 编译 Node 工具、共享文件、注入或生成 Skill 资源 | [构建与共享](references/build-and-sharing.md) |
| 处理平台差异、模板、文件选择、动态投影或能力要求 | [平台投影](references/platform-projection.md) |
| 维护 Workspace、inventory、依赖、版本或删除 Plugin | [Catalog 维护](references/catalog-development.md) |
| 声明或导出 Portable Agent Skills | [Portable 分发](references/portable-skills.md) |
| 激活、检查或停用本地开发源 | [Development source](references/development-source.md) |
| 判断 AW 组件组合、依赖边和平台差异 | [领域依据](references/aw-domain-review.md) |
