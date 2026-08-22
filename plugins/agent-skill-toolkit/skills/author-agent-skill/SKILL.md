---
name: author-agent-skill
description: >-
  当用户要从零创建、重写或变更一个通用 Agent Skill 包时使用，包括 SKILL.md、description、references、scripts、assets、平台元数据和作者期 Eval strategy。负责写入和确定性自检；不负责独立质量评分或发布裁决。
compatibility: bundled validator 需要 Node.js 20+；依赖 agent-content-toolkit >= 0.1.0。
metadata:
  short-description: 创建或变更最小、可组合、可验证的 Agent Skill 包
---

# Author Agent Skill

## 1. 选择作者路径

- **轻量 delta**：少量已知文件修改，且不改变用户意图、description/invocation、权限、组合边界、脚本/schema 或 Eval。只记录意图、允许路径、成功标准和验证，不创建 `SkillDesignBrief`。
- **完整设计路径**：新建、重写、职责拆分/合并、触发或权限变化、跨上下文交接，或新增脚本/schema/Eval。此时建立 `SkillDesignBrief`，记录真实任务、baseline gap、成功指标、scope、相邻能力、目标客户端、允许文件和 Eval strategy。

完整设计路径需要结构化交接时，复制 `assets/skill-design-brief.template.json`，再运行：

```bash
node scripts/validate-json-contract.mjs \
  assets/skill-design-brief.schema.json \
  <handoff>/skill-design-brief.json
```

无法说明 Skill 增量时，选择更简单能力或不创建。

## 2. 组合适配

完整设计路径在写正文前读取 `references/composition-audit.md`。需要多个独立意图、权限或证据生命周期时，拆成可独立调用的 Skill；入口只保留顺序、授权和最小交接。

轻量 delta 未改变这些边界时，不读取完整审计 reference，也不物化组合状态。

## 3. 编写包

- 先决定 model/manual/client-specific 调用意图，再写 description。
- 主 `SKILL.md` 只保留命中后每次都需要的步骤、默认和 gotcha。
- 使用 `write-agent-content` 编写 Agent-facing prose。
- 独立 branch 资料进入 focused reference；确定性逻辑进入 script；模板和静态数据进入 asset。
- Tool schema 已提供的字段细节不在 Skill 中维护第二份文档。
- 包含脚本时读取 `references/script-authoring.md`。
- 详细标准见 `references/author-standard.generated.md`。

## 4. Eval 门禁

只有触发、行为、权限或 Oracle 风险发生实质变化时才创建或修改 Eval。

创建或修改 Eval 时：

1. 使用 `design-agent-skill-evals` 设计 case/suite。
2. 启动独立上下文子代理，使用 `audit-agent-skill-evals` 的 `preflight` 模式审核。
3. 只有 `validity=pass`、无 blocked case、待运行 case 全部准入且 Skill/corpus digest 匹配时，才能把计划交给兼容 Eval runner。
4. 运行后启动独立上下文子代理，使用 `audit-agent-skill-evals` 的 `result-triage` 模式归因。未经 triage 的失败不得驱动生产 Skill 修改。

已有审核结果只有在两个 digest 仍匹配时才可复用。

## 5. 验证与交付

- 校验 frontmatter、引用、脚本接口和资源可达性。
- 对安全可运行的脚本执行 `--help` 或最小样例。
- change 模式比较正文、branch、资源和 Eval delta；新增规则必须替换旧逻辑或有新证据。
- 输出变更文件、作者路径、已运行验证、Eval 证据和需要独立 Reviewer 判断的 unknown。
- 不输出独立 `pass`、P0/P1 或 release verdict。
