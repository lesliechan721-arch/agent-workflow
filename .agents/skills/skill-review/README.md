# skill-review

用于对 Agent Skill 做多维度、证据化、可计算的质量评审。

## 核心能力

- 12 个维度、总权重 100。
- 质量分、证据置信度和评审覆盖率分离。
- 发布门禁优先于总分。
- quick、full、release、delta 四种模式。
- 重点审核触发条件、Skill 内容、渐进式披露、脚本、references、assets、eval、架构职责和维护性。
- 防止 review 通过不断追加自然语言规则偏离原目标。

## 工具

```bash
node scripts/inspect_skill_target.mjs /path/to/skill --format json
node scripts/validate_scorecard.mjs /path/to/scorecard.json --format json
```

先复制 `assets/scorecard-template.json`，由 reviewer 填分和证据，再用脚本计算总分与发布结论。
