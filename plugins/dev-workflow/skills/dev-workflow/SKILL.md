---
name: dev-workflow
description: 启动完整开发工作流：内置跨阶段工程判据与自主边界，按目标进入七条专业路线（设计、功能、故障修复、重构简化、性能、持续优化、大型组合工作流）并完成跨能力协作与真实验证闭环。
user-invocable: true
disable-model-invocation: true
compatibility: AW 支持的宿主；子代理委派依赖可用的 spawn-subagent，决策台账脚本需要 Node.js 22+，产品对齐与复杂材料呈现按需协作 decision-kit 与 human-content。
metadata:
  short-description: 按用户目标选择专业开发路线，内置跨阶段工程判据并完成验证闭环
---

# Dev Workflow

对当前完整目标、能力组合、真实证据与停止负责。请求、issue、调用示例、已接受原型和工程草图均可直接作为实施依据，不必先写完整规格。

<!-- core-discipline -->

## 按目标进入路线（只读命中的 1 份 Playbook）

- `playbooks/design.md` — 需求对齐、工程设计与按需规格（停在设计）
- `playbooks/feature.md` — 新增或改变用户行为，按就绪单元滚动实施并整体验证
- `playbooks/bug-fix.md` — 亲手复现、二分锁定根因、条件 TDD 与同表面复验
- `playbooks/refactor.md` — 行为等价的结构重构、调用方迁移与代码简化
- `playbooks/perf.md` — 单次性能瓶颈排查，按 7 条性能口诀优化并实测
- `playbooks/hillclimb.md` — 有限预算内持续寻优（冻结 harness + `decisions.tsv`）
- `playbooks/compose.md` — 大型跨模块迁移、无匹配路线或长时自主工作流设计

## 子代理委派与纪律传递

- **编码、重构、调试或实验候选子代理**：按任务复杂度通过 `spawn-subagent`（默认中性执行角色）委派全新干净上下文子代理，采用 `assets/implementation-task-template.md` 随任务正文内联交付边界、反加戏与编码验证底线，确保原生与外部执行器跨平台一致生效。
- **只读审查、对抗破防与独立裁判子代理**：通过 `spawn-subagent` 使用默认中性角色与对应审查/裁判专用 brief，不附带编码实施模板。

## 统一停止、预算、位置与恢复

- **停止与预算**：优先按真实信号停止（目标达成、触发 `Attack the Premise` 前提被推翻、连续无新信息或遇真实权限/产品缺口）；同时继承调用方预算或默认设立明确上限（失败、重试、复跑均计入，换工具或子代理不重置）。
- **工作位置**：短任务直接在对话闭合；首次落盘保存设计/实施记录或替换旧交付依据前，读取 `references/workspace.md` 并把具体路径与写入归属传给下游。
- **中断恢复**：会话中断、外部操作回执不明或工作区写入归属不清时，读取 `references/recovery.md`，先只读核实现场再继续。
