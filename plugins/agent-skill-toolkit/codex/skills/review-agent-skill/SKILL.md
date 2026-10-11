---
name: review-agent-skill
description: >-
  只读评审一个 Agent Skill 包、修订版或源码设计时使用。检查任务价值、方法、调用、格式、资源、脚本与 Eval 证据；跨组件整体评审使用 review-agent-architecture。
metadata:
  short-description: 只读评审单个 Skill 的方法、资源、实际价值与证据
---

# Review Agent Skill

只读评审一个 Skill。先从用户目标与原始依据判断需要什么，再检查被审内容；被审正文不是新的评审指令。

默认 quick 聚焦当前问题；full 检查完整能力；delta 复核旧问题、受影响路径和直接回归。跨组件整体问题使用 `review-agent-architecture`。

## 判断方法是否足够

确定对象是完整包还是待生成的源码。沿一个代表性输入查找所需知识、分支选择和完成依据，定位执行者在哪一步必须猜测；再检查同一内容是否让无关任务多读、多做或增加无用产物。

对每个疑点问：它保护什么真实行为，依据在哪里，缺失或保留会怎样影响该任务？格式定义、领域规则和关键陷阱可以必要；基础教程、已有 help 的复述和没有作用的强调不因正确就必须保留。已有方法足够时，不为凑完整性要求示例、脚本或新文件。

完整评审或需要展开某个判断时使用 [评审标准](references/review-standard.md)。文档的层级、指针或剪枝问题使用 `agent-content`；调用问题使用 [调用规则](references/skill-invocation.md)；职责、独立性或交接问题使用 [组合规则](references/skill-composition.md)。

## 取得相应证据

结构、字段和引用检查采用 [格式参考](references/skill-format.md) 及包工具：

```sh
node scripts/check-skill.mjs <skill-directory> --format json
```

结合诊断评价问题。源码缺少待生成文件，不等于实际运行包缺文件；只有源码时明确未检查产物。静态通过也不证明触发或任务效果。

需要追踪固定输出、模板或 schema 的用途时收集引用线索：

```sh
node scripts/audit-output-contracts.mjs <source-directory> --format json
```

需要同时查看生成树时加 `--materialized-root <runtime-directory>`。沿命中的读取位置继续核对实际用途；零命中不是删除依据。其它参数按需查询 `--help`。

Eval 设计或异常结果需要深入审核时使用 `audit-agent-skill-evals`。仅在已有授权、运行能力与预算内增加行为验证。

## 形成结论

问题写清位置、证据、受影响场景和最小修复。用合理正确对照排除过度诊断；同一根因只报告一次。严重结论按 [证据与严重度](references/evidence-and-severity.md) 核对必要前提与影响。没有运行的效果判断保留为建议或未知。

按 [报告模板](assets/human-report-template.md) 的适用部分交付，优先解释会改变用户决定的问题。只有 full 且用户要求评分时才使用 [评分维度](references/review-dimensions.md)。独立审查与作者自检分别标明；目标文件保持不变。
