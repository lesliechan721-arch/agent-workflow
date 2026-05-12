# Codex Explore Skill 重设计 Spec Review（二次审查）

审查对象：`docs/dev/specs/codex-explore-skill-redesign.md`  
审查日期：`2026-05-09`

## 主要发现

本轮未发现新的阻塞级问题。上一轮报告里的 3 个核心问题，这次都已经在 spec 里被明确收口了。

1. `codex.skill` 和静态 skill 管线的真值冲突，已经从“方向判断”收敛成了可执行 contract。

- spec 现在明确采用“静态模板真值 + 动态运行时渲染”的模型，不再让同名 skill 同时充当模板真值和运行时真值，见 `docs/dev/specs/codex-explore-skill-redesign.md:39,91,118-155,415`。
- 它也明确要求把声明了 `codex.skill` 的 `skillKey` 从现有静态 materialization 直写集合里排除，避免 project / user scope 双写同一路径，见 `docs/dev/specs/codex-explore-skill-redesign.md:130,149,389`。
- 这正对上了当前基线里只支持两类动态 target、且 artifact plan validator 只认识 `codex.developerInstructionsBlock` / `codex.agentRole` 的现实，见 `packages/cli/src/types.ts:250-315` 和 `packages/cli/src/utils/artifact-plan.ts:18-30`。

2. user scope 的动态 skill 时序已经闭环，不再停留在“希望安装后可见”的口头要求。

- spec 现在把 user scope 的安装 / 升级 / refresh 顺序单独写成了 contract：先校验 owner 和冲突、捕获 rollback baseline，再渲染 skill、应用 trigger patch、提交 AW-managed runtime skill，最后执行 native install 或 native cache refresh，见 `docs/dev/specs/codex-explore-skill-redesign.md:151-153,157-166,391-395,418`。
- 这正好覆盖了当前安装顺序里的关键缺口：现状是先 `materializeSkillTriggerPreference()`，再 native install，最后才 `installExtensions()` 跑动态 artifact，见 `packages/cli/src/commands/install.ts:1364-1498`。
- 也覆盖了当前 refresh 只把两类动态 artifact 视为可刷新的限制，见 `packages/cli/src/utils/artifact-refresh.ts:58-69`。

3. status / repair / drift 的“期望内容来源”已经定义清楚，不再会把动态 skill 天然判成漂移。

- spec 现在明确要求 dynamic skill 的 expected tree 来自“renderer 输出 + 当前配置 + 当前 trigger patch”，repair 也必须走重新渲染而不是回写静态 bundle 内容，见 `docs/dev/specs/codex-explore-skill-redesign.md:126-127,155,396,419`。
- 这正对当前 repo skill 漂移判断仍以 embedded pristine skill 为比较基线的实现，见 `packages/cli/src/adapters/codex.ts:4175-4194`。

## 剩余风险

1. “通用只读探索”这部分仍然受 Codex runtime 的 `explorer` contract 约束，这不是 spec 内部逻辑漏洞，但它依然是交付边界。

- spec 这次已经把它写成显式前置条件，而不是默认视为仓库内可直接完成，见 `docs/dev/specs/codex-explore-skill-redesign.md:33,42-45,414`。
- 这意味着当前仓库可以先落 `codex.skill`、清理旧 instruction / role、修复 renderer dedent、补测试和文档；但如果 runtime 仍只允许 codebase exploration，就不能把“网页 / 文档 / 日志 / 多源资料”的公开能力声明成已完成。

## 落地评估

需求方向是合理的，产品判断也比上一版清楚得多。去掉轻量 instruction、去掉专用 role、把清理逻辑收回到底座、修复 `trimBlock()`、同时把 `$codex-explore` 改成唯一入口，这一组决定彼此一致，没有明显自相矛盾的地方。

从当前基线看，这个需求能落地，但它已经不是“改一个插件”这么简单，而是一次穿过 CLI 底座的 contract 扩展。当前基线里：

- 动态 artifact target 还只有两种，见 `packages/cli/src/types.ts:250-315`。
- artifact plan validator 也只接受这两种 target，见 `packages/cli/src/utils/artifact-plan.ts:18-30`。
- refresh 只识别 instruction / role 两类动态 artifact，见 `packages/cli/src/utils/artifact-refresh.ts:58-69`。
- 安装顺序和 stale prune 触发点都还是旧模型，见 `packages/cli/src/commands/install.ts:1364-1545`。

不过这次 spec 已经把这些基线缺口逐项转成了实现 contract、测试要求和验收标准，而不是留给实现者自己脑补，所以“能不能做”这一层已经没有问题，主要剩下实现工作量和拆分节奏的问题。

## 优化建议

1. 建议把实施顺序写成两个里程碑。第一阶段先完成 `codex.skill` 底座、旧 artifact 清理、status/repair/refresh 闭环和 dedent 修复；第二阶段再在 runtime contract 明确后正式把 skill 的公开定位放宽到通用只读探索。这样更符合 spec 里已经写出的前置条件。
2. 建议在 spec 末尾再补一张很小的“触发策略真值表”，只覆盖 `default` / `auto` / `manual` 三种安装偏好分别对应 runtime `allow_implicit_invocation` 的结果。现在正文已经足够完整，但这张表会让实现、测试和代码评审更快对齐。

## 结论

上一轮报告指出的问题已经修复。本轮没有新的 spec 级阻塞项。

如果按当前文档进入实现，仓库内部分已经具备落地条件；唯一需要持续单独跟踪的是 Codex runtime 对内置 `explorer` 的能力 contract。只要这个外部前置条件没有完成，就不应该把“通用只读探索”当成已经验收的对外能力。
