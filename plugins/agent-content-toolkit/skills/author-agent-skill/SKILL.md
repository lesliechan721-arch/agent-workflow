---
name: author-agent-skill
description: >-
  当用户要从零创建、重写或变更一个通用 Agent Skill 包时使用，包括 SKILL.md、description、references、scripts、assets、平台元数据和作者期 eval strategy。负责写入和确定性自检；不隐式处理 agent-workflows 的 plugins/<name>/ 项目工作，不负责独立质量评分、发布裁决或项目专有 materialization。AW 适配器可以显式把本 Skill 作为叶子能力调用。
metadata:
  short-description: 创建或变更最小、可组合、可验证的 Agent Skill 包
---

# Author Agent Skill

模式为 `create` 或 `change`。本 Skill 可以写入目标包，但不能给自己的结果出独立 Review 结论。

## 1. 建立 SkillDesignBrief

先记录：

- 真实任务与来源证据；
- without-skill / previous-version gap；
- 可观察成功标准；
- scope、out-of-scope 和相邻能力；
- invocation intent 与目标客户端；
- 允许修改文件；
- Eval strategy。

复制 `assets/skill-design-brief.template.json` 到本次任务的 handoff 目录，填写真实值，并校验该任务文件。模板不是任务产物。例如：

```bash
node scripts/validate-json-contract.mjs assets/skill-design-brief.schema.json <handoff-dir>/skill-design-brief.json
```

无法说明 Skill 增量时，选择更简单能力或不创建。

## 2. Composition Fitness Audit

在写正文前读取 `references/composition-audit.md`，枚举：

- 独立用户意图；
- 权限模式；
- 证据生命周期；
- 通用与项目 profile；
- 需要 clean context 的阶段；
- 可用 artifact handoff。

Authoring 与独立 Review、Eval 设计与 Oracle 审核、通用标准与项目运行适配默认分离。拆分后只保留一个轻量 orchestrator 时，orchestrator 只拥有阶段顺序、授权和 artifact 合同。

## 3. 设计调用与范围

- 先决定 model/manual/client-specific 调用意图，再写 description。
- description 以用户意图和交付结果开头，覆盖真实 branch 与高价值 near-miss。
- 一个 Skill 对应一个可独立解释和触发的工作单元。

## 4. 编写包

- 主 `SKILL.md` 只保留命中后每次都需要的步骤、默认和 gotcha。
- Agent-facing prose 使用 `write-agent-content` 的标准投影；详细规则见 `references/author-standard.generated.md`。
- 需要独立 branch 的资料使用 focused reference；确定性逻辑进入 script；模板和静态数据进入 asset。
- Tool schema 已提供的字段细节不在 Skill 中维护第二份文档。

## 5. Eval strategy

- `evalStageOwner=author-agent-skill` 时，本 Skill 拥有下面的 Eval 设计与审核阶段。
- `evalStageOwner=caller` 时，只消费 caller 提供且已校验的 Eval artifact，不重复启动或重做这些阶段。
- 只有触发或行为存在真实风险时才创建 Eval。
- 需要新建或大改 Eval case 时，启动 fresh-context 子代理并调用 `design-agent-skill-evals`。
- Oracle preflight 必须启动另一个 fresh-context 子代理并调用 `audit-agent-skill-evals`；Author 自检不能替代它。
- 具体子代理参数和生命周期由当前 Codex 或 Claude runtime 决定。本 Skill 不维护调度器。
- 子代理结果必须匹配 `assets/eval-audit-result.schema.json`。结构无效时，把诊断返回同一子代理修正一次；再次无效则停止该阶段。

## 6. 确定性验证

- 校验 frontmatter、引用、脚本接口和资源可达性。
- 对安全可运行的脚本执行 `--help` 或最小样例。
- change 模式比较正文、branch、资源和 Eval delta；新增规则必须替换旧逻辑或有新证据。

## 7. 交付

输出：

- 变更文件；
- SkillDesignBrief；
- Composition verdict；
- 已运行验证；
- Eval handoff；
- 需要独立 Reviewer 判断的 unknown。

不得输出独立 `pass`、P0/P1 或 release verdict。
