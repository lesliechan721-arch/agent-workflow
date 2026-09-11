# Dev Workflow

可独立使用的规格、工作分解、实现、协调与审查能力。安装时依赖 ask-me；Skill 本身不取代项目权限、Git 或运行时。

```bash
aw install dev-workflow -p both
```

| Skill | 用途 |
| --- | --- |
| dev-workflow | 从当前共识和工件选择生命周期下一步 |
| dev-spec | 综合当前要求、重要实现决定、已接受设计和验收 |
| dev-review-spec | 独立审查 Spec |
| dev-build | 协调实施、集成、最终 Review 和有界修复 |
| dev-breakdown | 按需分解成新上下文可独立实施的 Ticket |
| dev-implement | 独立实现一个明确工作项并验证 |
| dev-review-code | 独立审查指定范围的需求与设计符合度、工程质量 |

## 使用路径

Fast：必要短澄清 → 直接 Build → 验证 → 最终 Code Review。默认不产生流程文档。

Standard：必要 Shape → Spec → Spec Review → 用户批准 → Build → 最终 Code Review。需要交接时持久化。

Assured：在 Standard 基础上落实项目要求的隔离、权限、备份、证据和回滚。

Build 小任务直接实现，大任务按需分解，并优先顺序 fresh worker；只有独立性明确时并行。是否委派、是否提交、是否高保障是不同决定。

## Review 与 checkpoint

阶段 Review 仅在公共基础、重大风险或集成边界使用；最终仍审查累计整体结果。自动修复由 Build 在用户/项目授权预算内逐轮判断；新授权未指定次数时，默认最多三轮，并可提前停止。已有较低授权不自动扩大。

更多审查用于补足明确证据缺口，不等于更多修改。预算耗尽不表示允许交付；当前完整结果仍须验证充分并独立审查通过。

正式 Spec Review 使用一个 fresh reviewer，Code Review 默认使用两个 fresh reviewer 分别负责需求与设计符合度、工程质量。能力不足时说明缺口。专业审查默认在对话中报告；协调者在需要持久记录时提供位置并安排历史保存。

有恢复或审计价值时主动建议 checkpoint；明确允许后调用现有 Git 能力。保存点不是 Review 通过证明，提交授权也不包含推送或历史重写。

## 工件

首次转交会保存产物的能力前确定任务位置，优先沿用用户路径、当前任务位置、现有 issue 或仓库约定。没有约定而需要本地记录时，可使用 docs/dev/<task-slug>/。Shape 保存共识，Spec 保存当前规范，Ticket 支持独立实施，Work 按需索引进度，Review 保存指定范围的判断与证据。Fast 也可以生成源码、测试或临时原型文件。

## 典型请求

```text
使用 dev-workflow 改进姓名空值显示，先确认显示内容，再实现和验证。
使用 dev-breakdown 把这份已批准 Spec 拆成可交接工作项，先不要实施。
使用 dev-build 完成已有工作项的集成和最终审查，不要提交。
使用 dev-review-code 审查当前权限核心，说明需求符合度、工程质量和覆盖限制。
```
