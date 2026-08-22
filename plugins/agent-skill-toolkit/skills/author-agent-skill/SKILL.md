---
name: author-agent-skill
description: >-
  当用户要从零创建、重写或变更一个通用 Agent Skill 包时使用，包括 SKILL.md、description、references、scripts、assets、平台元数据和作者期 eval strategy。负责写入和确定性自检；不负责项目专有插件布局、构建、物化或发布流程，也不负责独立质量评分或发布裁决。项目适配器可以显式把本 Skill 作为叶子能力调用。
compatibility: bundled validator 需要 Node.js 20+；编写 Agent-facing 文本需要已安装 agent-content-toolkit >= 0.1.0。
metadata:
  short-description: 创建或变更最小、可组合、可验证的 Agent Skill 包
---

# Author Agent Skill

模式为 `create` 或 `change`。本 Skill 可以写入目标包，但不能给自己的结果出独立 Review 结论。

## 1. 选择最小作者记录

先判断本次工作需要轻量 delta 还是完整设计路径。

- **轻量 delta**：目标 Skill 已存在，修改集中在少量已知文件，不改变用户意图、description/invocation、权限 owner、跨 Skill 组合、证据生命周期或持久 handoff，也不新增或修改脚本、schema 或 Eval。只在运行 trace 与最终回复中记录本次意图、允许修改路径、可观察成功标准和实际验证；不要创建或返回 `SkillDesignBrief` JSON，也不要为了记录可重算的包事实生成 handoff。
- **完整设计路径**：新建或重写 Skill，拆分/合并职责，改变 description、invocation、权限、相邻能力或跨上下文交接，新增脚本/schema/Eval，或 caller 明确需要结构化 handoff。此时建立完整 `SkillDesignBrief`，记录真实任务与来源证据、without-skill / previous-version gap、可观察成功标准、scope、out-of-scope、相邻能力、invocation intent、目标客户端、允许修改文件和 Eval strategy。

完整设计路径中，caller 提供 handoff 路径时，复制并填写 `assets/skill-design-brief.template.json`，再运行：

```bash
node scripts/validate-json-contract.mjs assets/skill-design-brief.schema.json <handoff>/skill-design-brief.json
```

没有可写 handoff 路径时，只在完整设计路径的回复中返回符合 schema 的 JSON。无法说明 Skill 增量时，选择更简单能力或不创建。

## 2. 按风险执行组合适配审计

完整设计路径在写正文前读取 `references/composition-audit.md`，枚举独立用户意图、权限模式、证据生命周期、通用与项目 profile、需要 clean context 的阶段和必要 artifact handoff。

轻量 delta 只核对本次修改是否实际改变上述任一边界。没有改变时记录“组合边界未变化”并继续，不读取完整审计 reference，也不物化组合状态。

Authoring 与独立 Review、Eval 设计与 Oracle 审核、通用标准与项目运行适配默认分离。需要 orchestrator 时，入口只拥有阶段顺序、授权和最小 artifact 合同。

## 3. 设计调用与范围

- 先决定 model/manual/client-specific 调用意图，再写 description；轻量 delta 未触及该边界时保留现状。
- description 以用户意图和交付结果开头，覆盖真实 branch 与高价值 near-miss。
- 一个 Skill 对应一个可独立解释和触发的工作单元。

## 4. 编写包

- 主 `SKILL.md` 只保留命中后每次都需要的步骤、默认和 gotcha。
- Agent-facing prose 由已安装的 `write-agent-content` 提供；不可用时停止该阶段，不复制简化版写作标准。
- 需要独立 branch 的资料使用 focused reference；确定性逻辑进入 script；模板和静态数据进入 asset。
- Tool schema 已提供的字段细节不在 Skill 中维护第二份文档。
- 包含脚本时读取 `references/script-authoring.md`，明确 runtime、依赖、非交互接口、stdout/stderr、退出码、安全默认值和最小验证。
- 详细 Skill 标准见 `references/author-standard.generated.md`。

## 5. Eval 策略

- 只有触发、行为、权限或 Oracle 风险发生实质变化时才创建或修改 Eval；拼写、措辞和不改变行为的局部整理不自动产生 Eval 工作。
- `evalStageOwner=author-agent-skill` 时，本 Skill 负责组织 Eval 设计与审核，但两个阶段必须使用不同 fresh context。
- `evalStageOwner=caller` 时，只消费 caller 提供且通过 schema 校验的 Eval artifact，不重复启动或重做这些阶段。
- Eval case 创建使用 `design-agent-skill-evals`；Oracle preflight 使用另一个 fresh context 中的 `audit-agent-skill-evals`。
- fresh context 的具体实现由 caller、harness 或客户端决定；没有子代理能力时使用独立 session 或输出 handoff，不能在同一上下文自审 Oracle。
- 子代理或独立 session 结果必须匹配 `assets/eval-audit-result.schema.json`。结构无效时允许原 producer 修正一次；再次无效则停止该阶段。

## 6. 确定性验证

- 校验 frontmatter、引用、脚本接口和资源可达性。
- 对安全可运行的脚本执行 `--help` 或最小样例。
- change 模式比较正文、branch、资源和 Eval delta；新增规则必须替换旧逻辑或有新证据。
- 轻量 delta 只运行与实际修改面对应的最小检查；完整设计路径再运行包级检查。

## 7. 交付

输出变更文件、所采用的作者路径、已运行验证、必要的 Eval handoff 和需要独立 Reviewer 判断的 unknown。轻量 delta 返回简洁的意图与验证记录；完整设计路径才返回 `SkillDesignBrief` 和 Composition verdict。不得输出独立 `pass`、P0/P1 或 release verdict。
