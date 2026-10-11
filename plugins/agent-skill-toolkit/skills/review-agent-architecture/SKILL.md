---
name: review-agent-architecture
description: >-
  只读评审多个 Agent Skill、插件、角色、工具或阶段组成的有界 workflow，或公开入口与依赖 portfolio 时使用。沿用户结果检查路由、方法、交接、证据 owner、独立运行、权限和实际使用成本；不修改目标，不代替单 Skill 的内部评审。
metadata:
  short-description: 沿真实用户路径评审 Skill 组合、独立可用性与公开入口
---

# Review Agent Architecture

只读评审多个能力如何共同完成一个结果，或用户如何选择公开入口。先固定目标、参与组件、代表性路径与排除项；范围不充分时只评价已核对部分，不给整体通过结论。

## 沿真实任务检查

从用户请求走到最终产物，记录每个组件接收什么、完成什么、下一步实际使用什么。区分采用一个方法、创建新的执行上下文、复制资源和安装依赖；目录或 Skill 数量不能代替执行证据。

检查工作流时使用 [工作流评审](references/architecture-review.md)。检查入口数量、命名和插件边界时使用 [公开能力评审](references/public-surface-review.md)。两类问题同时存在时，先建立实际任务路径，再判断公开面是否需要调整。

调用可达性问题按 [调用规则](references/skill-invocation.md) 核对；职责、交接和独立判断按 [组合规则](references/skill-composition.md) 核对。单个 Skill 的内部问题需要深入检查时使用 `review-agent-skill`，整体评审保留跨组件影响与最终判断。

## 追踪依赖和消费者

必要依赖应在当前环境可用，重要信息应由上游产物或明确引用交给下游。声称独立可用时，检查离开原宿主后的实际运行；仅有声明时保留验证缺口。

需要定位固定输出、模板或 schema 的引用时运行：

```sh
node scripts/audit-output-contracts.mjs <source-directory> --format json
```

需要同时扫描生成树时加 `--materialized-root <runtime-directory>`。沿线索核对真实产物与读取代码；同名文件、邻近关键词和零命中都不能单独决定业务用途。其它参数按需查询 `--help`。

## 比较更简单的方案

比较直接处理、单 Skill 和组合路径是否能完成同一任务。解释每个额外入口、交接或上下文隔离带来的方法收益，以及读入、导航、权限和失败传播成本。

先定位问题在被调用能力、调用者还是运行环境，再建议最小变更。保留独立裁决、真实复用和必要恢复；不以减少组件数量为唯一目标，也不为可命名的每个分支新增入口。

## 交付

报告评审范围、整体是否连贯、关键问题与证据、最小调整方案及未验证条件。分别说明设计推断和实际执行事实。按用户指定位置写报告，被审目标保持不变。
