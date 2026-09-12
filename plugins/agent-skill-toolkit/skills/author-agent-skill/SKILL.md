---
name: author-agent-skill
description: >-
  创建或变更 Agent Skill package 时使用，包括 SKILL.md、description、调用属性、references、scripts、assets 和 Eval case/suite 设计。也适用于只补充该 Skill 的 Eval 资产。负责写入和确定性自检；不作独立质量裁决、Oracle 准入、模型 Eval 执行或发布。
compatibility: 使用项目或目标客户端提供的包验证能力；Agent-facing 内容依赖 agent-content-toolkit。
metadata:
  short-description: 创建和变更最小、可验证的 Skill，并按需设计 Eval
---

# Author Agent Skill

写正文或 reference 时使用 `agent-content`。先确认可编辑源码与运行包的关系；项目适配提供构建约束和允许路径，标准包检查针对实际可消费的目标。

局部修词、修路径直接处理；职责、调用、权限、脚本、消费者或 Eval 发生变化时，只对受影响部分补充设计依据。新建或实质重写时读取 `references/design-and-validation.md`。设计依据可留在当前上下文，不强制创建中间产物。

## 按变更面读取

| 条件 | 材料 |
| --- | --- |
| description、自动/手动触发或 Skill 组合 | `references/invocation-and-description.md` |
| 脚本新增或接口修改 | `references/script-authoring.md` |
| 创建或修改 Eval case/suite | `references/eval-design.md` |
| 拆分/合并、共享职责或固定输出合同 | `references/composition-audit.md` |

## 边界

- 规则精度与脆弱性相配。保留领域事实和关键安全约束，优先删除重复、放宽多余步骤或按 branch 披露；不会因为没有现成 Eval 就拒绝正常编辑。
- Eval 设计与独立审核分开；作者可检查结构和明显自相矛盾，但不能为自己的 Oracle 签发 passing Audit。不要为测试通过改写用户目标或扩大修改权限。

## 交付

执行与变更面相称的确定性检查；未知脚本先读再决定是否运行。返回实际修改、验证及关键未验证项。用户未要求时，不额外生成 Review、模型 Eval 或发布文件。
