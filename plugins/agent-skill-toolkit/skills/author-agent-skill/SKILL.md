---
name: author-agent-skill
description: >-
  当用户要从零创建、重写或变更一个通用 Agent Skill 包时使用，包括 SKILL.md、description、references、scripts、assets、平台元数据和作者期 Eval 资产。负责写入和确定性自检；不负责独立质量评审、Eval Oracle 审核、昂贵 Eval 执行或发布裁决。
compatibility: bundled validator 需要 Node.js 20+；依赖 agent-content-toolkit。
metadata:
  short-description: 创建或变更最小、可组合、可验证的 Agent Skill 包
---

# Author Agent Skill

模式为 `create` 或 `change`。本 Skill 只完成用户要求的创建或变更，并验证本次修改面。

## 依赖

- `write-agent-content`：编写 Agent-facing 正文与 reference。
- `design-agent-skill-evals`：仅在用户明确要求创建或修改 Eval 资产时使用。

## 作者路径

- **轻量 delta**：修改集中在少量已知文件，且不改变职责、调用方式、权限、组合边界、脚本/schema 或 Eval 资产。记录意图、允许路径、成功标准和验证，不创建 `SkillDesignBrief`。
- **完整设计路径**：新建、重写、职责拆分/合并、description/invocation 变化、权限变化、跨上下文交接，或新增脚本/schema/Eval 资产。此时建立 `SkillDesignBrief`。

完整设计路径需要结构化交接时，复制 `assets/skill-design-brief.template.json`，再运行：

```bash
node scripts/validate-json-contract.mjs \
  assets/skill-design-brief.schema.json \
  <handoff>/skill-design-brief.json
```

## Reference 路由

| 变更面 | 读取 |
| --- | --- |
| 新建、重写、职责或 scope 变化 | `references/problem-and-scope.md` |
| description、invocation 或 near-miss 变化 | `references/invocation-and-description.md` |
| references、assets 或信息层级变化 | `references/package-and-disclosure.md` |
| 本地脚本变化 | `references/script-authoring.md` |
| 完整创建或重大变更交付前 | `references/completion-and-validation.md` |
| 需要判断是否拆分一个 Skill | `references/composition-audit.md` |

详细通用规则见 `references/author-standard.md`；只读取与当前变更面相关的部分。

## 编写原则

- 无法说明没有 Skill 时的具体失败或增量价值时，选择更简单能力或不创建。
- 主 `SKILL.md` 只保留命中后各 branch 都需要的规则；独立 branch 使用 focused reference。
- 确定、重复、可测试的逻辑进入 script；模板和静态数据进入 asset。
- Tool schema 已提供的字段细节不维护第二份文档。
- 变更 Eval 文件时只负责设计与写入；不自动审核 Oracle、不自动运行 Eval、不自动触发独立 Review。

## 验证与交付

- 校验 frontmatter、name/目录、引用、脚本接口和资源可达性。
- 对安全可运行的脚本执行 `--help` 或最小样例。
- 运行与实际修改面对应的 build、schema 或 deterministic test。
- change 模式比较正文、branch、资源和 Eval 资产 delta；新增规则必须替换旧逻辑或有新证据。
- 输出变更文件、已运行验证和未验证项。完成条件不包括独立 Review、Eval Audit 或模型 Eval。
