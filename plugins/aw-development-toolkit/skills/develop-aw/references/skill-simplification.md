# AW 源 Skill 简化适配

仅在简化 AW 插件内源 Skill 时读取。本分支提供源码、隔离上下文和物化；`simplify-agent-skill` 负责变化族、保留行为、预算及 accept/reject/inconclusive。已有适配上下文沿用，按缺口补准备步骤。

## 确定可写源

从当前 Workspace 的 manifest、构建声明和目标文件确认内容来自 Skill source、共享 provider 还是 renderer。提供允许修改的真实路径和相关消费者；源码缺少待注入 reference 时，以对应 final 检查运行内容。只有 final 且无法追踪可编辑源时，交付计划或临时实验，不声称完成生产修复。共享 provider 的改动超出授权消费者范围时，先说明影响并固定范围。

## 冻结输入并建立候选

使用项目可用的隔离方式保存当前输入，包括所需 Workspace marker/metadata、manifest、依赖、build/runtime imports、provider、renderer、配置和未提交文件。不能只复制 Skill 子目录，也不能默认 Git HEAD 等于用户输入。使用 Git worktree 时仍需纳入本次相关的未提交和未跟踪输入。

baseline 源码上下文保持不变，从它建立可重建的独立 candidate。固定 platform、scope、解析后的配置及不属于本轮变化族的构建条件。baseline 与 candidate 的绑定各自在对应源码上下文校验；candidate 已变不会抹去旧 baseline 的实验价值，但旧 binding 不能代表当前 candidate。

## 准备并比较实际运行包

使用公开 `aw review prepare --help` 确认当前参数；从各自源码上下文对目标运行 `aw review prepare`，指定相同 profile 条件和新的隔离输出。它只准备运行包，不执行 Review 或 Eval；无需建立 Eval suite 才能准备。复用已有匹配产物时核对来源与当前性，不重复准备已验证且输入未变的产物。

使用 receipt 中的 `skills[].finalPath`、profile 和 `sourceBindingPath`；digest 由 CLI 产生。候选 source/provider/renderer 改变后重新准备，比较 final 的实际内容。源码更短而 renderer 输出未变时，只能报告维护成本下降。

正式模型对照交给已授权的 `run-aw-skill-evals`；本分支不执行模型或签发 Audit。Runner 已提供匹配的可检查产物时可复用。若 Eval prepare 再次物化，核对 Spec 实际 current/previous target 与本轮比较版本的内容，不能仅凭 profile 名相同认定一致。两版身份可以不同；每份 Spec/Audit 须满足自己的精确绑定。缺少运行证据时保留为未验证候选。

## 应用源码差异

Simplifier 接受候选且应用已获授权后，只应用对应 source diff，不复制临时 final。应用前核对原工作区相关源码仍与冻结输入一致；遇到并行修改时协调受影响差异，不覆盖用户工作。应用后在目标源码上下文重建并确认对应 final，交付源码变化、产物与绑定及未验证项。需要单插件或反向依赖验证时使用 `plugin-development.md`；有争议再请求独立 Review，不强制每轮完整评审。
