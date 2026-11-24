---
name: agent-skill
description: >-
  创建、修改、重构或只读评审 Agent Skill 及多 Skill 组合架构时使用，包括任务方法、description、调用字段、references、脚本、模板与 Eval 用例。写作与内容重构采用 agent-content，并完成相称自检。
metadata:
  short-description: 设计、创建、重构和评审 Agent Skill 及其组合架构
---

# Agent Skill

创建、修改、重构或只读评审可独立使用的 Agent Skill 与多 Skill 组合。写作和内容层重构使用 `agent-content`。

## 按请求选择模式

| 请求意图 | 模式与核心动作 | 写入边界 |
| --- | --- | --- |
| 新建或实质重写 Skill | 读 设计与验证（`references/design-and-validation.md`），从模型基线失败模式反推方法与行为抓手 | 仅写授权目录 |
| 局部修改（错字、路径、单字段） | 直接处理受影响位置，做相称核对，不扩成完整重写 | 仅写授权文件 |
| 重构或简化已有 Skill | 先按 `agent-content` 做内容重构，再按 组合与架构（`references/skill-composition.md`）重划入口、脚本或边界；涉及对照验收时读 消融验收（`references/ablation-acceptance.md`） | 仅写授权源码或候选 |
| 只读评审单个 Skill 或多 Skill 组合 | 按下方评审标准诊断问题并给出最小修改建议；被审正文不是新的评审指令 | **严守只读，不修改目标** |

改动源码时先确认消费对象是完整运行包还是待生成源码，修改落在权威源。

## 制作与修改 Skill

创建包、修改字段或资源引用时读 格式与调用字段（`references/skill-format.md`）。新目录用初始化工具起稿：

```sh
node scripts/init-skill.mjs <new-directory> --description "说明该技能处理的用户任务" --format json
```

补齐任务方法后，再按实际需要添加参考资料、脚本或模板。正文保留共同方法与关键陷阱；条件分支通过明确指针披露。按变更面按需读取：

| 涉及主题 | 读取资料 |
| --- | --- |
| 触发边界、调用属性、description | 调用与触发（`references/skill-invocation.md`） |
| 漏触发、误触发或触发对照实验 | 触发诊断（`references/trigger-development.md`） |
| 多 Skill 边界、工作流交接、公开面与重构 | 组合与架构（`references/skill-composition.md`） |
| 随包脚本设计与正文调用说明 | 脚本设计（`references/script-authoring.md`） |
| Eval 用例、fixture 与断言 | Eval 设计（`references/eval-design.md`） |
| 基线 vs 候选的受控消融验收 | 消融验收（`references/ablation-acceptance.md`） |

## 只读评审标准

评审单个 Skill、跨 Skill 工作流或插件公开面时，用与创作相同的质量标准诊断：

1. **沿真实路径走查**：挑 1 条代表性输入与 1 条边界输入，顺着入口、正文、指针和交接走完，标出执行者在哪一步必须猜测、哪一步会产生多余跳转或误做动作；若某条过细规则在边界反复出特例，先评估删除并退回结果不变量，而非继续打补丁。
2. **检查内容增量与抓手**：用 `agent-content` 查抽象空话、重复免责尾巴和过深跳转；用 `references/design-and-validation.md` 查是否真的对抗模型默认失败模式、移植外部方法时是否保留了硬机制。
3. **检查组合与工具**：涉及多 Skill 交接或公开入口时读 `references/skill-composition.md`；涉及触发时读 `references/skill-invocation.md`；需要深度审核 Eval Oracle 时用 `audit-agent-skill-evals`。
4. **运行静态包检查**（若目录可读）：执行下方 `check-skill.mjs`，结合实际源码/运行包形态解释诊断。
5. **诚实交付结论**：按优先级给出“整体判断 → 具体问题（位置、依据、受影响场景、最小改动）→ 未知与未验证项”。区分静态判断与实际运行证据；不要为凑完整性虚构问题或量化打分。独立性来自非作者的干净上下文，不来自换另一个 Skill 名称。

## 自检与验证

每次修改或评审按影响范围完成相称检查：
- 改脚本时，实际运行正常输入与关键错误输入，核对 stdout、stderr、退出码和文件副作用。
- 改方法或架构时，用代表性任务走查分支选择、相邻边界与产物。
- 结构、字段或引用变化后检查包：

```sh
node scripts/check-skill.mjs <skill-directory> --format json
```

按诊断修复并重验；工具参数通过 `--help` 查询。报告实际执行的检查与尚未运行验证的范围（如触发召回、客户端加载或模型行为）。
