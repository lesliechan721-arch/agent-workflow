---
name: write-agent-content
description: >-
  当用户要创建或编辑给 Agent 直接读取的 AGENTS.md、CLAUDE.md、prompt、role instructions、reference 或其它指令文档时使用；负责内容结构、上下文指针、完成边界和剪枝。不用于完整 Agent Skill 包的创建或变更，也不用于只读质量评审。
metadata:
  short-description: 创建或编辑轻量、可达、可执行的 Agent-facing 内容
---

# Write Agent Content

目标是用最少的 always-loaded 内容稳定改变 Agent 行为，而不是把所有正确做法写进文档。

## 边界

- 完整 Agent Skill 包：使用 `author-agent-skill`。
- 只读质量评审：使用 `review-agent-content` 或 `review-agent-skill`。
- 本 Skill 可以修改目标文档，但不替用户发明未提供的项目事实。

## 工作流

1. **定义读者和作用域**
   - 明确目标 Agent/客户端、文档加载方式、always-loaded 与按需加载边界。
   - 提取用户目标、可观察成功条件、范围外事项和事实来源。

2. **写最小行为合同**
   - 不参考现有章节顺序，先写不超过 7 条的必要行为。
   - 每条必须属于项目事实、非显然 gotcha、脆弱操作或明确输出合同。

3. **设计上下文路径**
   - 对外部材料写清 context pointer：目标是什么、哪些 branch 需要它。
   - 将内容分类为 step、in-file reference、disclosed reference、script、asset 或 environment lookup。

4. **起草内容**
   - 多种方案合理时写目标、默认和选择依据；脆弱操作才使用精确步骤。
   - 关键步骤有清晰且可检查的完成条件。
   - 软性行为优先描述要做什么；硬安全边界再使用 prohibition。

5. **剪枝**
   - 删除模型默认会正确处理的 no-op、环境可直接查询的缓存和重复含义。
   - 同一概念的定义、规则和 caveat 放在一个权威位置。

6. **验证**
   - 以真实输入或 minimal pair 检查 pointer、步骤和输出是否改变目标行为。
   - 若删除某规则的影响未知，标记 `needs-ablation`，不因担心而永久保留。

需要详细标准时读取 `references/writing-standard.generated.md`。

## 输出

返回修改后的内容或 diff，并说明：

- 保留的最小行为合同；
- 新增或调整的 pointer；
- 被删除、放宽或迁移的内容；
- 尚需真实运行验证的假设。
