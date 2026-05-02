# `plugin-extension-boundary-repair.md` 计划审查报告

审查对象：`docs/dev/plans/plugin-extension-boundary-repair.md`  
审查时间：2026-04-27

本轮审查基于当前仓库基线，范围限定为：

- 计划审查，不是代码实现复审
- 不考虑旧版构建物兼容或迁移成本
- 重点看计划是否能在当前基线上落地
- 重点检查测试覆盖是否足以兜住这轮改动

对照依据：

- 当前仓库实现：`packages/cli/src/**`、`.agents/skills/create-agent-workflows-plugin/**`
- 当前测试：`packages/cli/tests/**`
- Codex 源码：`/Users/LeslieChan/Desktop/codex/codex-rs`
- Claude Code 源码：`/Users/LeslieChan/Desktop/claude-code-source-code/src`

## Findings

### 1. 低严重度：文档更新面的清单还建议再显式补到安装/内部约定入口，并把 `Stop` 是否属于“非公共事件”改成跟随第 1 步最终决策

位置：

- `docs/dev/plans/plugin-extension-boundary-repair.md:304-325`
- `docs/plugin-installation.md:116-128`
- `docs/coding-conventions.md:15-22`

问题：

这版计划的主链路已经补得比较完整，文档侧也明确覆盖了 `SKILL.md`、`docs/plugin-authoring.md`、`references/extensions-spec.md`、`references/mcp-and-apps.md`、`references/comprehensive-example.md` 等关键入口。

但从当前仓库基线看，仍有两类文档入口会在这轮修复后继续误导实现、联调或人工排查，而计划正文里还没有把它们显式列进更新范围：

- `docs/plugin-installation.md` 现在还写着 Codex 会生成 `.codex/permissions.json`、`.codex/agents.json`，这和当前基线实现已经不一致，更不用说这轮还要把 permissions / hooks contract 继续收口。
- `docs/coding-conventions.md` 还把 `HookEvent` 固定写成 `'before_tool' | 'after_tool' | 'session_start' | 'session_stop' | 'command'`。而计划第 1 步和第 4 步正是在重做这组公共事件集合。

另外，计划第 3 步的“当前不纳入公共层”章节里，已经把 Codex `Stop` 先写成非公共事件；但同一份计划前面又明确要求第 1 步先决定 `session_stop` 是否保留，以及若保留就映射到 Codex `Stop`。也就是说，这里的文档更新说明最好跟随第 1 步最终结论，而不是先把 `Stop` 静态写死在“非公共事件”清单里。

这不是实现阻塞项，但如果不顺手收口，结果会是代码 contract 修好了，仓库里仍留着几份直接指导作者或维护者排查问题的旧说明，后续很容易把错误约定重新带回测试、样例或人工操作步骤里。

建议：

- 在第 3 步里把 `docs/plugin-installation.md` 和 `docs/coding-conventions.md` 显式纳入更新范围。
- 将“Codex hooks 的非公共事件”改成条件性表述，例如“除第 1 步最终保留并映射进公共层的事件外，其余原生事件不纳入公共层”，或把这条放到第 1 步决策之后再回填。
- 如果希望继续用测试兜住文档入口漂移，可以考虑在作者工具文档对齐测试外，再补一条轻量断言，覆盖安装指南中 Codex 产物路径的关键术语。

## Open Questions / Assumptions

- 上轮报告中的核心阻塞项，这版计划已经吸收完成：Claude permissions 的原生 `Bash(...)` 规则形状、Codex `prefix_rule(...)`、Codex hooks 的 `HooksFile` 形状、`.app.json` 的 `apps.*.id`、模板化 `.mcp.json` / `.app.json` 的 source-rendered 分层、source/bundle manifest 分流、`agentOverrides` 的平台生效视图、`validateBundleLayout()` / `pnpm test:smoke:build` 的补强、`--with-apps` scaffold 收口，都已经进入正文。
- 本轮重新对照 Claude Code 与 Codex 基线源码后，没有再发现新的中/高严重度结构性缺口。就当前基线而言，这份计划已经可以指导实现，不再停留在“文档上自洽但落不到代码入口”的状态。
- 这里默认第 1 步会先完成 HookEvent 公共集合决策，再回填第 3 步的文档说明和 fixture 术语；如果实现时打算并行推进，建议先把这条依赖关系写清楚，避免文档先落成一版互相打架的说法。

## 测试评估

这版计划的测试矩阵已经足够覆盖本轮高风险链路，尤其是下面这些地方都已经被纳入：

- hooks / permissions 双平台最终 artifact 形状
- `session_stop` / `command` 的 contract 收口与 manifest fail fast
- `agentOverrides` 在 install、status、historical fallback、tracking、回滚中的一致视图
- `.mcp.json` / `.app.json` 模板与非模板两条链
- source validator、bundle loader、install preflight 三层校验
- `validateBundleLayout()`、`pnpm test:smoke:build` 和 embedded bundle 健康检查
- `validate_plugin.js` built / fallback 两种模式的行为边界

除了上面这个低严重度的文档入口问题，本轮没有再发现明显的测试盲区，也没有新的未知高风险链路遗漏。

## 结论

这份计划现在已经没有阻止进入实现阶段的主要问题了。

建议在开工前顺手把第 3 步的文档更新范围再写实一点，并让 `Stop` 是否属于“非公共事件”跟随第 1 步最终决策。除此之外，本轮没有再发现新的阻塞项。
