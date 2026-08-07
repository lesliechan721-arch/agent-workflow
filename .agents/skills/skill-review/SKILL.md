---
name: skill-review
description: 当用户要求审核、评分、发布检查、精简、重构、比较或迭代 Agent Skill、SKILL.md、description、references、scripts、assets、evals、角色配置、完整技能包或当前 agent-workflows 项目的插件 Skill 时使用；从规范有效性、目标价值、触发准确性、范围与组合、指令质量、上下文与渐进式披露、架构职责、脚本、资源、评测、可靠性和维护性等维度进行证据化评分，给出发布门禁、缺陷和最小改进集。不要用于普通代码或文档 review，除非评审对象本身是 Agent Skill。
compatibility: Requires the agent-workflows repository, Node.js 20+, and installed workspace dependencies.
metadata:
  short-description: 多维度、证据化、可计算的 Agent Skill 质量评审
---

# Skill Review

评审目标不是让 Skill 覆盖所有理论边界，而是判断它是否用最小、可验证、职责归属正确的机制解决目标问题。

## 评审模式

- **quick**：仅有 `SKILL.md` 或用户只要求快速检查；给出临时分数，不作发布通过结论。
- **full**：检查完整技能包，默认模式。
- **release**：在 full 基础上核对当前官方规范、执行安全可运行的脚本检查，并要求 trigger/behavior eval 或等价证据。
- **delta**：有上一版时比较改动是否关闭旧问题、引入回归或增加无证据复杂度；不重新无限扩张问题空间。

## 先固定评审合同

从用户材料提取：目标问题、观察到的失败、成功标准、适用环境、范围外事项和发布要求。材料未支持的前提标为未知，不要自行补全。

每条证据标记为：

- `observed`：真实 trace、复现、测试结果或用户确认的失败。
- `documented`：被审文件、官方规范、schema、源码或配置直接支持。
- `inferred`：静态推理或未来风险。

纯 `inferred` finding 默认不得升级为 P0/P1，除非存在直接逻辑矛盾。

## 执行流程

1. 枚举 `SKILL.md`、`references/`、`scripts/`、`assets/`、`evals/`、角色和相关配置；缺失材料会降低覆盖率，不要猜测内容。
2. 运行静态诊断：
   ```bash
   node scripts/inspect_skill_target.mjs <skill-dir-or-SKILL.md-or-plugin> --format json
   ```
   修订版增加 `--previous <old-SKILL.md>`；相关 TOML 用可重复的 `--related '<glob>'`。脚本输出是证据和提示，不是自动缺陷判定。
3. 任何计分评审都读取 `references/scoring-model.md`。full/release 读取 `references/review-dimensions.md`。
4. 根据对象按需读取：
   - 生命周期、跨 agent 协议、重试或复杂分支：`references/architecture-boundaries.md`
   - 有 scripts、references 或 assets：`references/scripts-and-resources.md`
   - 审核 description、触发或 eval：`references/evals-and-triggering.md`
   - 修订版：`references/delta-review.md`
   - 需要核对 Agent Skills 标准：`references/official-agent-skills-basis.md`；release 评审还应验证当前官方文档。
   - 当前仓库的 AW 插件或动态 Skill：`references/agent-workflows-plugin.md`
5. 使用 `assets/scorecard-template.json` 填写维度分数、证据、门禁和 findings，再运行：
   ```bash
   node scripts/validate_scorecard.mjs <scorecard.json> --format json
   ```
   采用脚本计算的总分、覆盖率、置信度和发布结论，不手算。
6. 按 `assets/report-template.md` 输出。先给方向、门禁和总分，再列优势、缺陷和最小改进集。

## 评分纪律

- 质量分与证据置信度分开；缺少 eval 不等于文案一定错误，但不能给出高置信发布结论。
- 同一根因只在一个主维度扣分；其它维度说明影响，不重复处罚。
- 没有 scripts 或 references 不自动扣分；当它们确实不需要时，正确省略可以得到高分。
- 高总分不能覆盖门禁失败。规范无效、关键文件断裂、依赖不存在能力、安全/权限边界破坏或核心目标矛盾时，发布仍失败。
- P0/P1 必须指出证据、正确职责层、最小改动和验证方式。优先删除、替换或抽象现有规则，不默认追加自然语言条件。
- 当 Skill 以自然语言维护计时、额度、pending、跨 actor 握手、乱序事件或取消/关闭竞态时，先审查架构归属；不要通过继续补分支伪造运行时状态机。

## 停止条件

当评审合同清楚、核心行为已有验证方案、没有证据支持的 P0/P1，且新增建议只会增加状态、例外或上下文成本时，明确给出通过或带 advisory 通过，并停止继续找问题。
