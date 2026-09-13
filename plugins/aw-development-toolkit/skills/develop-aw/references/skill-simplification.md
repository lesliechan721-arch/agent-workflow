# AW 源 Skill 简化适配

简化 AW 插件内源 Skill 时，用本分支提供源码、隔离上下文和物化条件。

## 确定可写源

从 Workspace 的 manifest、构建声明和目标文件确认内容来自 Skill source、共享 provider 还是 renderer，固定可写路径及消费者范围。源码缺少待注入 reference 时，以对应 final 检查运行内容。共享 provider 的改动超出授权消费者范围时，先说明影响并固定范围。

## 冻结输入并建立候选

冻结当前输入，包括所需 Workspace marker/metadata、manifest、依赖、build/runtime imports、provider、renderer、配置及相关未提交和未跟踪文件；不能以 Git HEAD 或单独的 Skill 子目录代替。

从冻结的 baseline 建立可重建的独立 candidate，固定 platform、scope、解析后的配置及未变构建条件。两者的绑定各自在对应源码上下文校验。

## 准备并比较实际运行包

按 `aw review prepare --help`，从各自源码上下文以相同 profile 条件准备到新的隔离目录。该命令只准备运行包，不执行 Review 或 Eval，也不要求 Eval suite。

使用 receipt 中的 `skills[].finalPath`、profile 和 `sourceBindingPath`。已有输入未变且绑定有效的运行包可复用，包括 Runner 产物；候选 source/provider/renderer 改变后重新准备。

正式对照交给已授权的 `run-aw-skill-evals`。若 Eval prepare 再次物化，核对 Spec 实际 current/previous target 与本轮比较版本的内容一致，不能只凭 profile 名判断。

## 应用源码差异

候选被接受且应用已获授权后，只应用 source diff，不复制临时 final。应用前核对原工作区相关源码与冻结输入；遇到并行修改时协调差异，不覆盖用户工作。应用后在目标源码上下文重建并确认 final；单插件和反向依赖验证使用 `plugin-development.md`。
