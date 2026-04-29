# `plugin-scripts-lifecycle-config.md` 执行计划审查报告

审查对象：`docs/dev/plans/plugin-scripts-lifecycle-config.md`  
审查时间：2026-04-29

本轮审查基于当前仓库基线，范围限定为：

- 执行计划审查，不是实现代码复审
- 重点看文档是否自洽、是否能在当前基线上落地
- 重点检查测试计划是否足以覆盖高风险路径

对照依据：

- 计划文档：`docs/dev/plans/plugin-scripts-lifecycle-config.md`
- 当前公开约定：`docs/plugin-authoring.md`、`docs/testing.md`
- 当前实现：`packages/cli/src/**`
- 当前测试基线：`packages/cli/tests/**`

## Findings

### 1. `project` scope 配置被强行收敛到 repo root，和当前 Claude 的 project scope 语义冲突

计划把 project scope 配置固定到 `<repoRoot>/.agent-workflows/plugin-config/<plugin>/config.json`，并明确说明“不走当前子目录”（`docs/dev/plans/plugin-scripts-lifecycle-config.md:123-126`），后面的读取顺序也沿用了这个假设（`docs/dev/plans/plugin-scripts-lifecycle-config.md:151-153`）。  
但当前基线里，Claude 的 project scope 不是 repo-root scoped，而是“以当前工作目录的真实路径为 key”；只有 Codex project scope 才先解析 repo root（`docs/plugin-authoring.md:57-62`）。实现层也和文档一致：Claude project 配置目录直接取 `cwd/.claude`，Codex 才会先走 `resolveRepoRootSync(cwd)`（`packages/cli/src/utils/paths.ts:104-120`）。

这意味着按现计划落地后，同一仓库下两个不同 Claude project scope 安装会共享同一份 AW config。生命周期脚本和 `aw config --scope project` 读到的配置，将不再和现有 `--scope project` 的作用域一致。这不是文档措辞问题，而是会直接影响安装、升级、命令结果填充和排障判断。

建议先把边界收口清楚，再进入实现：

- 要么让 AW config 也按平台实际 project key 分桶，和现有 scope 语义保持一致。
- 要么明确宣布 AW config 的 `project` scope 是“repo-root scoped 的 AW 作用域”，它不等同于 Claude 现有 project scope，并同步改命名和文档，避免复用同一个 `project` 词但表达不同含义。

### 2. 生命周期运行时的环境变量约定前后矛盾，现计划下 helper 很容易读错配置目录

计划里的标准 helper 明确写了：CLI 外运行的 `aw-config.mjs` 通过 `os.homedir()` / `AW_HOME` 找 user store（`docs/dev/plans/plugin-scripts-lifecycle-config.md:179-197`）；插件测试 runner 也要求为每个插件创建隔离的 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`（`docs/dev/plans/plugin-scripts-lifecycle-config.md:318-320`）。  
但生命周期 runner 的环境变量设计又写成“只传 `AW_PLUGIN_CONTEXT`、`AW_PLUGIN_EVENT`、`AW_PLUGIN_NAME`、`AW_PLUGIN_ROOT`、`PATH/HOME/TMPDIR` 等最小集合”（`docs/dev/plans/plugin-scripts-lifecycle-config.md:203-210`）。测试计划还把 `AW_HOME` / `AW_CODEX_HOME` / `AW_CLAUDE_HOME` 覆写列为明确要覆盖的行为（`docs/dev/plans/plugin-scripts-lifecycle-config.md:436-437`），而当前仓库确实已经把这些覆写当成基线能力测试（`packages/cli/tests/integration/runtime-env.test.ts:74-127`，`packages/cli/src/utils/paths.ts:67-77`）。

按当前写法，插件测试或生命周期脚本一旦复用标准 helper，而不是只读 `AW_PLUGIN_CONTEXT`，就会回退到真实 home 目录，读错 user config store；在隔离测试环境里尤其容易直接失效。这里不只是“最好传更多 env”，而是文档已经给了两套互相打架的运行时约定。

建议在计划里先统一 contract：

- 生命周期 runner 至少透传 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`。
- 或者把这些路径放进 context，并明确 helper 在 `AW_PLUGIN_CONTEXT` 存在时优先读 context，不再自行猜测 home 路径。

### 3. historical fallback 的生命周期方案还没闭环，当前基线下很容易落成“永远跳过”或“直接报错”

计划要求 historical fallback 时，如果当前 catalog / active local bundle 找不到可执行 lifecycle，就 warning 后继续清理（`docs/dev/plans/plugin-scripts-lifecycle-config.md:282-283`、`371-375`）。这个方向是对的，但现在缺了最关键的一步：怎么在 historical 路径里拿到“可执行的 bundle manifest / script root”。

当前基线下，historical target 并不保留真实插件根目录，只会构造一个占位 `PluginMeta`，`rootDir` 为空，manifest 里也没有脚本或配置定义（`packages/cli/src/commands/common.ts:174-240`）。而 `uninstallTargetsOnPlatforms()` 现在拿到的就是这个 target，然后直接围绕它做卸载编排（`packages/cli/src/commands/uninstall.ts:404-449`）。虽然 adapter status 里已经能给出 `activeLocalBundle` 线索（例如 Claude status 会回填 `activeLocalBundle`，`packages/cli/src/adapters/claude.ts:702-740`），但当前计划的实现步骤没有写明要在 uninstall 前据此重新加载 bundle manifest，也没有说明 current catalog 和 active local bundle 冲突时以谁为准。

测试矩阵同样漏掉了这条最容易出错的支线：`cli.test.ts` 只覆盖了普通 install/uninstall lifecycle，`upgrade-command.test.ts` 只覆盖 capabilityChanged，完全没有“historical + active local bundle 仍可执行 uninstall lifecycle”以及“historical + 两边都缺失时 warning fallback”的用例（`docs/dev/plans/plugin-scripts-lifecycle-config.md:429-443`）。

建议把这段设计补实后再实现：

- 明确 historical uninstall 的脚本解析顺序，例如 `current catalog -> active local bundle -> warning fallback`。
- 明确 active local bundle 的 manifest 读取入口放在哪一层。
- 把上述两个 historical 分支都写进 integration 测试。

### 4. `plugin-config/` 的持久化是核心风险点，但测试计划没有把最关键的刷新路径兜住

计划已经正确识别出风险：`initializeLocalMarketplace()` 现在会整体替换 `~/.aw`，如果配置继续放在 `AW_HOME` 下，刷新时必须显式保留 `plugin-config/`，而且“重建不删除配置”要写进测试（`docs/dev/plans/plugin-scripts-lifecycle-config.md:128`、`355-357`、`454-460`）。  
问题是测试计划里并没有任何一条真正落到这个点上。现有 integration / unit / smoke 列表只覆盖了 `aw config` 参数、lifecycle 调用、runtime env 和 `plugin:test` runner（`docs/dev/plans/plugin-scripts-lifecycle-config.md:426-452`），没有一条要求验证 `initializeLocalMarketplace()`、`aw init --force`、non-force stale refresh 或损坏后重建时是否保留 `plugin-config/`。

这在当前基线下是明显缺口，因为本地 marketplace 刷新现在就是 staging copy 后再整体替换目录（`packages/cli/src/utils/local-marketplace.ts:416-463`）。如果这个分支没测，最容易发生的回归就是功能表面可用，但一次 `aw init --force` 或 bundle refresh 直接把用户配置清空。

建议至少补下面几类测试：

- `local-marketplace.test.ts`：force init 保留 `plugin-config/`
- `local-marketplace.test.ts`：non-force stale refresh 保留 `plugin-config/`
- `local-marketplace.test.ts`：本地 `config.json` 损坏触发重建时仍保留 `plugin-config/`
- 视实现位置决定是否再补一个 `initCommand` 集成用例，确认 CLI 入口同样不丢配置

## Open Questions / Assumptions

- 本轮按计划文档当前写法审查，不额外要求兼容旧版 bundle contract 或历史插件 schema。
- 我默认这次新增的 AW 自管配置希望复用现有 `--scope project|user` 语义；如果产品上其实想引入一个“独立于平台安装 scope 的 AW config scope”，那需要在计划里先明确，不然实现和文档都会互相误导。

## 结论

这份计划的方向是成立的：把 lifecycle、AW 自管配置和插件脚本测试一起收进 AW runtime，是当前基线下自然的一步。  
但以上 4 个问题里，前 3 个都已经碰到“按现文档实现会和基线语义冲突，或关键分支没有闭环”的程度，第 4 个则是明显的高风险测试缺口。建议先把这些地方补实，再进入实现阶段。
