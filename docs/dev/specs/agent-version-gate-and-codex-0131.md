# Agent 版本门禁与 Codex 0.131 原生能力对齐 Spec

日期：2026-05-19
状态：需求确认稿
基线：Codex CLI 0.131.0、Claude Code 2.1.88、`docs/dev/specs/aw-version-management.md`
文档规范：`docs/dev/spec-plan-writing-guide.md`

## 文档定位

本 Spec 只定义最低宿主 agent 版本门禁、Codex 0.131 原生插件能力对齐、Claude Code 2.1.88 支持边界、用户体验和验收标准，不写实现计划、阶段拆分、具体测试文件或迁移步骤。

本文件继承现有 AW 版本管理基线：CLI version、catalog version、plugin version 和 `compatibility.aw.minVersion` 仍然是 AW 自身的版本合同。本轮新增的是“宿主 agent 版本”合同，也就是用户本机 `codex` 和 `claude` 可执行文件的最低版本要求。宿主 agent 版本不进入插件 manifest，也不替代 catalog/plugin 的 AW 兼容性判断。

## 背景

Codex 升级到 0.131 后，原生插件能力面已经覆盖 `skills`、`mcp_servers`、`apps`、`hooks` 和 `interface`，插件管理接口也补齐了 `plugin/list`、`plugin/installed`、`plugin/read`、`marketplace/remove`、`marketplace/upgrade` 等能力。AW 当前对 Codex user scope 已经走 native marketplace + app-server `plugin/install` / `plugin/uninstall` 主链路，但状态诊断、hooks 物化和 marketplace 清理仍有一部分停留在 AW 自管逻辑上。

同时，AW 过去只检测 `codex` / `claude` 是否存在，没有检测宿主 agent 版本。低版本 agent 可能缺少插件 CLI、app-server RPC、native hooks 或 manifest 字段支持，继续安装或升级会留下难以解释的半成功状态。用户需要 AW 在写入前 fail fast，并明确提示升级 Codex 或 Claude Code。

Claude Code 的最低开发基线确定为 2.1.88。该版本源码确认支持插件 marketplace add/list/remove/update、plugin install/uninstall、hooks、commands、agents、skills、MCP/LSP 和 user config 等插件能力；未知顶层 manifest 字段会被忽略，不会破坏 AW 生成的额外兼容字段。

## 现状探查结论

### AW 现有版本体系还没有宿主 agent 门禁

- `docs/dev/specs/aw-version-management.md` 已定义 CLI、catalog、plugin 和依赖最低版本，代码中也已经出现 `compatibility.aw.minVersion`、catalog history、sidecar/full catalog 和 `dependencies.plugins[].minVersion`。
- `packages/cli/src/utils/detect.ts` 目前只通过 PATH 或 `AW_FORCE_CLAUDE_AVAILABLE` / `AW_FORCE_CODEX_AVAILABLE` 判断平台是否可用，不读取 `claude --version` 或 `codex --version`。
- `packages/cli/src/commands/platform-resolution.ts` 当前允许 Codex project repo-managed target 在没有 `codex` 可执行文件时继续执行；本轮用户已确认要改成写命令全覆盖门禁。

### Codex 0.131 原生能力比 AW 当前消费面更完整

- Codex 0.131 的 `.codex-plugin/plugin.json` 原生识别 `skills`、`mcp_servers`、`apps`、`hooks` 和 `interface`。
- Codex app-server protocol 已有 `plugin/list`、`plugin/installed`、`plugin/read`、`plugin/install`、`plugin/uninstall`、`marketplace/add`、`marketplace/remove` 和 `marketplace/upgrade` 等 RPC。
- AW 当前 `packages/cli/src/utils/codex-app-server-client.ts` 只封装 `plugin/install` 和 `plugin/uninstall`。
- AW 当前 `packages/cli/src/generators/local-plugin.ts` 只为 Claude native manifest 生成 hooks；`packages/cli/src/utils/bundle-layout.ts` 的 Codex manifest 校验也尚未允许 `hooks`。
- AW 当前 Codex hooks 主要由 adapter 写 `.codex/hooks.json`，并通过 tracking 管理共享 hook groups。这条路线适合 Codex project repo-managed surface，但没有吃到 Codex 0.131 user-scope native plugin hooks 生命周期。

### 现有 Codex 扩展仍可保留

- Codex 0.131 没有原生 plugin-level developer instructions 或 agent roles 字段。AW 的 `codex.developerInstructionsBlock` 和 `codex.agentRole` 仍应继续写 Codex config / role layer，而不是塞进 `.codex-plugin/plugin.json`。
- `codex.skill` 仍是 `SKILL.md + agents/openai.yaml`，`policy.allow_implicit_invocation` 仍可按 AW SkillTrigger 配置 patch。
- Codex 仍没有 project-scope native install state。Codex project scope 继续是 repo-managed artifacts；只是本轮门禁要求写入前也必须确认本机 Codex 版本达标。

### Claude Code 2.1.88 是可支持基线

- 本地 Claude Code 2.1.88 源码的 plugin manifest schema 支持 `skills`、`hooks`、`commands`、`agents`、`outputStyles`、`mcpServers`、`lspServers`、`settings`、`userConfig` 和 `channels`。
- 2.1.88 源码有 `claude plugin marketplace add/list/remove/update` 和 `claude plugin install/uninstall` 处理逻辑。
- `claude --version` 当前机器输出 `2.1.119 (Claude Code)`，满足最低版本；`codex --version` 当前机器输出 `codex-cli 0.131.0`，满足最低版本。

## 已确认决策

1. 最低宿主 agent 版本门禁覆盖所有会写入或删除平台 native/runtime 状态、repo-visible artifacts、install record、recovery marker 或 project artifact identity 的目标。只要命令目标包含 Claude 或 Codex，对应 agent 必须存在、可执行、版本可解析且不低于最低版本。Codex project scope 也不再保留“缺少 codex 仍可写 repo-managed artifacts”的例外。
2. 最低宿主 agent 版本由 AW CLI 内置为全局门槛：Codex `>= 0.131.0`，Claude Code `>= 2.1.88`。本期不在插件 manifest、catalog manifest 或依赖声明里增加 per-plugin agent 版本字段。
3. Codex 0.131 对齐本期按全面原生化处理：补齐 Codex native hooks manifest 生成/校验，引入 `plugin/list`、`plugin/installed`、`plugin/read` 做 native 状态诊断，并使用 `marketplace/remove` / `marketplace/upgrade` 等原生管理接口收口 marketplace 生命周期。

## 目标、范围与非目标

### 目标

1. 在 AW CLI 中定义宿主 agent 最低版本：Codex `0.131.0`，Claude Code `2.1.88`。
2. 在 `install`、`upgrade`、`upgrade --all`，会执行安装/升级等价写入的 `reinstall`、`repair`，会真实删除平台状态或 AW 受管状态的 `uninstall`、`cleanup`，以及会刷新已安装 artifact 或重新应用 SkillTrigger runtime 的 `aw config set/unset/reset` 和主控制台配置动作前执行宿主 agent 版本预检。
3. 版本预检必须发生在第一笔平台状态、repo-visible artifact、native cache、install record、recovery marker 或受门禁保护的 config store 变更之前。配置写入命中已安装 target 的 refresh/apply 时，版本不达标必须让整次配置命令失败，不能先保存配置再留下 stale runtime。
4. `--platform both` 中任一目标平台版本不达标时，本次命令整体失败，不能先写入另一个平台。
5. 缺少可执行文件、版本命令失败、版本输出不可解析和版本低于要求，都必须形成清晰、可操作的错误，并提示升级对应 agent。
6. 版本解析遵守严格 SemVer 2.0.0；允许从已知 CLI 输出中提取 SemVer token，例如 `codex-cli 0.131.0` 和 `2.1.119 (Claude Code)`，但不把 `latest`、`v1.2.3`、`1.2` 或非 SemVer 预发布格式自动修正为合法版本。
7. `AW_FORCE_CLAUDE_AVAILABLE` / `AW_FORCE_CODEX_AVAILABLE` 只表示“可用性检测可被测试或特殊环境覆盖”，不能绕过版本门禁。测试和命令 runtime 可以通过可注入 runner 提供明确的 fake version。
8. `status --verbose` 和主控制台诊断应能展示宿主 agent 版本检测结果、最低要求和是否阻断写入；普通 `status` 只在版本缺失、不可解析或过低时提示，不展示 `probeFailed`。
9. Codex user-scope native plugin hooks 进入 `.codex-plugin/plugin.json`，由 Codex 0.131 原生插件生命周期加载。AW 后续不应在 user-scope 新写会重复触发的 `.codex/hooks.json` hook groups。
10. Codex project scope 继续使用 repo-managed `.codex/hooks.json`，因为 Codex 0.131 仍没有 project-scope native install state。
11. Codex app-server client 能读取 `plugin/list`、`plugin/installed`、`plugin/read` 结果，并把它们用于 Codex user-scope native 状态诊断、外部 ownership 判断和 mention/native view 校验；Codex project-scope 不以这些 RPC 作为 hard gate。
12. Codex marketplace 生命周期收口应优先使用原生 `marketplace/remove` / `marketplace/upgrade` 管理接口，不能回退到手写或手删 Codex config/cache 来伪装 native 成功。
13. Codex user-scope 写命令需要 native RPC 完成或证明 Codex native 成功状态时，RPC 不可用、method unavailable 或返回协议错误必须 fail closed；Codex project scope 不调用 native RPC，只受宿主 Codex 版本门禁和 repo-managed 写入安全检查约束。只读状态可以降级为诊断 unknown，但不能把 unknown 当成 healthy。
14. Claude Code 2.1.88 保持为 Claude native 插件能力开发基线；AW 生成的 Claude plugin manifest、hooks、agents、commands、MCP 等能力必须继续兼容该版本。
15. 公开文档、插件作者参考、安装文档、架构文档和相关测试夹具要同步更新，避免作者继续以“只需要可执行文件存在”或“Codex user hooks 只写 `.codex/hooks.json`”理解新合同。

### 范围

- 宿主 agent 版本检测、比较、错误输出和 JSON/status 诊断合同。
- config-triggered artifact refresh、SkillTrigger built-in apply 和主控制台“重新应用配置”的版本门禁边界。
- Codex user-scope native hooks manifest 生成、校验、安装、升级，以及旧 AW-managed user hooks 本期不迁移的边界。
- Codex native app-server 只读诊断接口：`plugin/list`、`plugin/installed`、`plugin/read`。
- Codex native marketplace 管理接口：`marketplace/remove`、`marketplace/upgrade`，以及必要的 lifecycle 诊断。
- Codex project scope 在新门禁下的用户体验变化。
- Claude Code 2.1.88 作为最低支持版本的文档和验收要求。

### 非目标

- 不设计 agent 自动升级。AW 只提示用户升级 Codex 或 Claude Code。
- 不在本期新增 `compatibility.codex.minVersion`、`compatibility.claude.minVersion` 或 per-plugin agent 版本字段。
- 不改变 `compatibility.aw.minVersion`、catalog history、plugin version 或 dependency `minVersion` 的既有语义。
- 不把 Codex `codex.developerInstructionsBlock` 或 `codex.agentRole` 迁入原生 plugin manifest；Codex 0.131 没有对应原生字段。
- 不引入 Codex project-scope native plugin install state。project scope 仍是 repo-managed artifacts。
- 不改变公共 hook 事件模型；`extensions.hooks` 仍只表示跨平台公共事件，平台专属事件仍放在 `extensions.nativeHooks.<platform>`。
- 不用本地 cache、旧 config 或环境变量绕过宿主 agent 版本不达标的结论。
- 不把 `status`、主控制台或诊断读路径变成隐式 repair/install/upgrade 入口。
- 不设计旧版 Codex user-scope AW-managed `.codex/hooks.json` hook groups 的历史迁移或接管策略；当前官方插件集没有这类需要迁移的 user-scope hooks。

## 术语与状态模型

### 宿主 agent

宿主 agent 指 AW 要写入或调用的目标产品 CLI：

- Codex：`codex` 可执行文件。
- Claude Code：`claude` 可执行文件。

本轮最低版本门槛只针对宿主 agent，不针对模型版本、AW CLI 版本、catalog 版本或插件版本。

### Agent 版本状态

每个平台的版本状态至少包含：

- `supported`：可执行文件存在，版本可解析，且当前版本大于等于最低版本。
- `missing`：需要该平台写入，但找不到可执行文件。
- `probeFailed`：版本命令执行失败或超时。
- `unparseable`：版本输出中找不到合法 SemVer。
- `tooOld`：版本可解析，但低于最低版本。
- `unknown`：只读诊断中无法确认版本；写命令不能把它当成可用。

写命令只接受 `supported`。其它状态都必须在写入前失败。普通 `status` 的默认视图只提示 `missing`、`unparseable` 和 `tooOld` 这三类明确可行动的版本问题；`probeFailed` 和 `unknown` 只进入 `status --verbose`、`--json`、主控制台诊断详情或具体写命令错误。

### Codex Native 与 Repo-managed Surface

Codex user scope 是 native plugin surface：AW 注册本地 marketplace，调用 Codex app-server 或原生命令完成 plugin install/uninstall、materialized cache 和 user config 写入。本轮后，user-scope hooks 也应属于 native plugin manifest lifecycle。

Codex project scope 是 repo-managed surface：AW 写 `.agents/skills/`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/`、`.codex/agents/` 和 `.agent-workflows/project-artifacts/`。它不调用 Codex native install RPC，但写入前仍必须通过 Codex 版本门禁。

## 用户体验需求

### 写入前的版本拦截

当用户运行这些命令时，只要目标平台包含 Codex 或 Claude，就必须先完成对应 agent 版本预检：

- `aw install ... -p codex|claude|both`
- `aw upgrade ... -p codex|claude|both`
- `aw upgrade --all -p codex|claude|both`
- `aw reinstall ...` 中会重新执行平台安装的路径
- `aw repair ...` 中会重新写入平台 native/runtime 状态的路径
- `aw uninstall ... -p codex|claude|both`
- 执行删除计划的 `aw cleanup ... -p codex|claude|both`；`cleanup --plan` 仍是只读诊断，不触发写入门禁失败
- `aw config set/unset/reset <plugin> ...` 中本次变更会命中已安装 artifact 的 `refreshKeys`，或会触发 AW 内建 SkillTrigger apply pipeline 的路径
- 主控制台触发的等价安装、升级、重装、修复、卸载、cleanup 删除、配置保存或“重新应用配置”动作

`aw config` 没有 `--platform` 参数，版本门禁必须从本次配置写入会影响的已安装 locations 推导平台集合：user 配置最多影响 user target 和当前仓库 project target，project 配置只影响当前仓库 project target。命中多个平台时按整体事务处理，任一平台版本不达标则本次配置命令整体失败，不能写 config store、runtime artifact 或 dynamic diagnostic cache。未安装插件的预配置、孤立 store 的 raw reset，以及未命中 `refreshKeys` 且不触发 SkillTrigger apply 的纯 config store 更新，不触发宿主 agent 版本门禁。

Fresh clone 后只有 project artifact identity / repo-visible artifacts、但本机 install record 尚未认领的位置，不算可刷新的已安装 target。本次配置变更不触碰 project repo-visible artifact refresh 时，可以作为 config-only 预写入继续，不触发宿主 agent 版本门禁，并在 receipt 中用 `configRefreshSkippedReason: "adoptExistingRequired"` 提示先认领再刷新；完全没有可刷新 target 的预配置或孤立 store 更新使用 `noRefreshTarget`。如果变更命中 project artifact `refreshKeys`，则必须在写 config store 前失败，提示先运行 `aw repair --adopt-existing`，不能借 config-only 写入绕过 repo artifact ownership。

错误文案必须包含平台名、检测到的版本或检测失败原因、最低要求和下一步建议。示例语义：

```text
Codex 版本过低：当前 0.130.0，AW 插件安装至少需要 0.131.0。请升级 Codex 后重试。
```

```text
Claude Code 版本过低：当前 2.1.87，AW 插件安装至少需要 2.1.88。请升级 Claude Code 后重试。
```

缺少 executable 时不能继续执行上述写动作，即使目标是 Codex project scope。

### JSON 与诊断输出

失败 JSON 或诊断 payload 应提供稳定 reason code，至少区分：

- `agentVersionMissing`
- `agentVersionProbeFailed`
- `agentVersionUnparseable`
- `agentVersionTooLow`
- `codexNativeApiUnavailable`

可读字段应包含：

- `platform`
- `command`
- `detectedVersion`
- `requiredMinVersion`
- `rawVersionOutput`（仅在 debug/verbose 中出现，避免污染普通 JSON）
- `suggestedAction`

`status --verbose` 应展示所有被扫描平台的 agent 版本状态。普通 `status` 只在 `missing`、`unparseable` 或 `tooOld` 可能阻断下一次写命令时显示简短提示；`probeFailed` 不进入普通 `status` 默认摘要。

### Codex Native Hooks

支持 Codex 的插件如果声明 `extensions.hooks` 或 `extensions.nativeHooks.codex`：

- Codex user-scope native bundle 的 `.codex-plugin/plugin.json` 必须包含 Codex 0.131 可识别的 `hooks` 字段。
- hooks 内容必须使用 Codex 0.131 支持的事件、matcher 和 handler schema。
- user-scope 安装/升级后，Codex native plugin lifecycle 应能发现这些 hooks。
- 本期不处理旧版 user-scope AW-managed `.codex/hooks.json` hook groups 的迁移。若现场存在缺少 ownership evidence 的 hook group，无论它看起来是否像 AW 历史残留，都不能自动删除或接管；它也不作为本期 native hooks 生成的阻断条件。
- Codex project-scope 仍写 `.codex/hooks.json`，并继续通过 tracking/project artifact identity 保护 ownership。

### Codex Native 状态诊断

Codex user-scope 状态应把 AW 本地证据和 Codex native 证据分开展示：

- `plugin/installed` 用于确认当前 Codex 认为哪些插件已安装、启用或可注入。
- `plugin/read` 用于读取指定插件详情，辅助解释 native manifest、skills、hooks、MCP、apps 和 interface 是否进入 Codex native view。
- `plugin/list` 用于检查 marketplace 可见插件列表、外部 marketplace ownership 和 mention 可见性。

普通 `status` 和不带 verbose 的 `status --json` 不启动 `codex app-server`，只展示 AW 本地证据、Codex config/cache 静态读证据和必要的版本诊断。`status --verbose`、`status --verbose --json`、主控制台诊断详情和发现页需要解释 Codex user-scope native view 时，可以启动 `codex app-server` 读取上述 RPC；这仍然是只读诊断，不能顺带刷新 marketplace、修复 cache、写 config 或创建目录。

证据优先级按用途区分：

- AW install record、project artifact identity、managed config/cache evidence、recovery marker 和 shared owner 仍是 AW ownership、cleanup 授权和 project-scope 健康判断的主要证据。
- Codex native RPC 证据只作为 Codex user-scope native view 的补充真相，用于说明 Codex 当前是否认为插件已安装、启用、可注入、可被 mention，或是否来自非 AW marketplace/source。
- RPC 能证明同名 user-scope native 插件由非 AW 来源管理时，user-scope install/upgrade/reinstall/repair 必须按 external ownership 冲突处理；没有 AW ownership 证据时，RPC 结果不能授权 cleanup、takeover 或 marketplace/remove。
- RPC 不可用、超时、method unavailable 或协议错误时，verbose 诊断显示 native view unknown；unknown 不能提升为 healthy，也不能覆盖已有 AW 本地 ownership 证据。只有 Codex user-scope 写命令需要 native 结果来完成写入或证明成功时，失败才阻断命令；Codex project scope 不因这些 RPC 不可用而阻断 repo-managed 写入。

### Codex Marketplace 生命周期

AW 不再把 Codex marketplace 生命周期收口理解为“改一段 TOML 或删一个 cache 目录”。当需要移除、刷新或核验 Codex user-scope AW marketplace 时：

- 能走 Codex 原生 `marketplace/remove` 的路径必须走原生接口。
- 能走 Codex 原生 `marketplace/upgrade` 的路径必须走原生接口。
- 原生接口成功后，AW 再更新自己的 install record、recovery marker、active runtime view 或诊断缓存。
- 原生接口失败时，AW 不能自行手改 Codex config/cache 来制造成功状态，只能给出修复或升级 Codex 的建议。

具体命令边界如下：

- `aw install`、`aw upgrade`、`aw upgrade --all`、`aw reinstall` 和会重写 Codex user-scope native 状态的 `aw repair`，如果需要刷新或校验 AW 本地 marketplace，必须在 user-scope native 写入前使用 `marketplace/upgrade` 或等价的 Codex 原生刷新接口。
- “需要移除 Codex user-scope AW marketplace 注册”指本次 `aw uninstall` 或执行删除计划的 `aw cleanup` 完成目标插件 native 卸载或残留清理后，AW 能证明 Codex user-scope 下已没有任何仍需该 marketplace 的受管 `@aw` 插件、install record、native recovery breadcrumb、shared native ref、native transaction marker 或 AW-owned native cache/config evidence。无法证明归属的 config-only / cache-only 残留不能授权删除 marketplace；单纯 disabled-only config entry 不阻止移除。
- `aw uninstall` 和执行删除计划的 `aw cleanup` 只有满足上述条件时才调用 `marketplace/remove`；仍有任一受管 Codex user-scope native 使用者时必须保留 marketplace。普通单插件卸载仍以 `plugin/uninstall` 和 AW-owned 状态清理为主，只有它同时移除了最后一个受管 native 使用者时才进入 marketplace removal。
- `aw init` 只预热 AW catalog/cache，不写活 Codex user-scope marketplace；它不调用 `marketplace/upgrade` 或 `marketplace/remove`。
- `status`、`cleanup --plan`、发现类页面和主控制台只读首页只做诊断，不刷新或移除 marketplace。
- Codex project-scope 的安装、升级、卸载、repair 和 cleanup 不调用 `marketplace/remove` / `marketplace/upgrade`。

## 公开合同和命令边界

### 版本检测合同

Codex 版本检测使用 `codex --version`。输出中第一个合法 SemVer token 是检测版本；例如 `codex-cli 0.131.0` 解析为 `0.131.0`。

Claude Code 版本检测使用 `claude --version`。输出中第一个合法 SemVer token 是检测版本；例如 `2.1.119 (Claude Code)` 解析为 `2.1.119`。

SemVer token 前后必须是字符串边界或空白，不能从紧贴其它字符的更长 token 中截取子串。`v1.2.3`、`agent-1.2.3`、`1.2.3beta` 和 `1.2.3.4` 都不能被当作合法 `1.2.3` 接受；`codex-cli 0.131.0` 中的 `0.131.0` 可以接受。

版本比较使用严格 SemVer precedence。预发布版本只有在 SemVer 规则下大于等于最低版本时才通过；非 SemVer 的开发标识不能被自动转换。

### 写入前门禁

版本门禁是写命令 preflight，不是 adapter 内部的 best-effort 检查。命令层在解析出目标平台和目标插件后、任何外部写入前，必须统一确认所需平台的 agent version 均为 `supported`。这里的写命令包括 direct CLI 和主控制台触发的等价写动作；`status`、`cleanup --plan`、发现类页面、主控制台只读首页和只读安全预检不写状态，只展示版本诊断。

`--platform both` 的门禁按整体事务处理：任一平台出现 `missing`、`probeFailed`、`unparseable`、`tooOld` 或 `unknown`，本次命令不写任一平台，不创建 native cache、active view、install record、recovery marker 或 repo-visible artifacts。

`aw config set/unset/reset` 的门禁不是按用户传入平台计算，而是先用 historical runtime、install record、dynamic diagnostic cache 和本次 key 变更推导会被 refresh/apply 的已安装 target。只要推导出的任一 target 需要 Codex 或 Claude 写入，命令就必须在写 config store 前完成对应 agent 版本预检；预检失败时不写 config store、不更新 runtime artifact、不写 dynamic diagnostic cache，也不执行部分平台刷新。没有已安装 consumer、只有 orphan store raw delete，或本次变更不会触发 artifact refresh / SkillTrigger apply 时，`aw config` 只写 AW config store，不触发宿主 agent 版本门禁。可认领但本机尚未认领的 project artifacts 只允许 config-only 预写入：未触发 project artifact refresh 时 receipt 标记 `adoptExistingRequired` 或 `noRefreshTarget`；触发 refresh 时先要求 `aw repair --adopt-existing`，不得进入 agent 版本门禁或平台写入阶段。

Codex native RPC hard gate 只覆盖 Codex user-scope native 写入链路：`plugin/install`、`plugin/uninstall`、写后 native view 校验，以及需要刷新或移除 AW marketplace 注册的 `marketplace/upgrade` / `marketplace/remove`。Codex project-scope 命令不调用这些 RPC；它们通过宿主 Codex 版本门禁后，只按 repo-managed artifact 的安全检查决定是否继续。

### 只读命令边界

`status`、发现类页面和主控制台首页可以读取版本与 native 状态，但不能因为发现 agent 版本过低而修改本地状态，也不能自动运行 upgrade/repair。它们只能按普通视图或 verbose 诊断层级展示阻断原因和下一步命令。

普通 `status`、不带 verbose 的 `status --json`、`cleanup --plan` 和主控制台只读首页不启动 `codex app-server`。需要 Codex user-scope native view 的 `status --verbose`、`status --verbose --json`、主控制台诊断详情和发现页可以启动 `codex app-server` 读取 `plugin/list`、`plugin/installed` 和 `plugin/read`；失败时只降级为 native view unknown，不写状态，也不把 unknown 当成 healthy。

### 文档和作者工具边界

作者文档需要明确：

- 插件作者无需在 manifest 中声明最低 Codex/Claude Code 版本；本期由 AW CLI 全局控制。
- 如果插件使用 Codex hooks，user-scope native bundle 会进入 `.codex-plugin/plugin.json`，project-scope 仍写 `.codex/hooks.json`。
- 本期不承诺迁移旧版 user-scope AW-managed `.codex/hooks.json` hook groups；无 ownership evidence 的 hook group 必须保留。
- 修改 Codex native hooks 物化方式会改变插件 artifact 身份，官方插件需要按既有版本管理规则递增 plugin version。
- `pnpm plugin:test` 和相关 fixture 需要覆盖 Codex 0.131 / Claude 2.1.88 的最低版本假设。

## 验收标准

1. 当 `codex --version` 返回 `codex-cli 0.130.0` 时，`aw install <plugin> -p codex`、`aw upgrade <plugin> -p codex`、`aw uninstall <plugin> -p codex`、执行删除计划的 `aw cleanup <plugin> -p codex` 和 Codex project-scope 等价写命令都在写入前失败，并提示需要 Codex `>= 0.131.0`。
2. 当 `codex --version` 返回 `codex-cli 0.131.0` 时，Codex 目标通过版本门禁，后续失败只来自其它 preflight 或写入逻辑。
3. 当 `claude --version` 返回 `2.1.87 (Claude Code)` 时，Claude 安装、升级、卸载、执行删除计划的 cleanup 和等价写动作都在写入前失败，并提示需要 Claude Code `>= 2.1.88`。
4. 当 `claude --version` 返回 `2.1.88 (Claude Code)` 或更高版本时，Claude 目标通过版本门禁。
5. `--platform both` 中任一平台缺失、`probeFailed`、不可解析或版本过低时，本次命令没有任何平台写入、没有新增 native cache、active view、install record、native marker，也没有写 repo-visible artifacts。
6. 设置 `AW_FORCE_CODEX_AVAILABLE=1` 或 `AW_FORCE_CLAUDE_AVAILABLE=1` 不能绕过版本过低、不可解析或 `probeFailed` 的结论。
7. `status --verbose --json` 能稳定输出每个平台的 agent version 状态、检测版本、最低要求和阻断 reason code；普通 `status` 只在 `missing`、`unparseable` 或 `tooOld` 时给出简短提示，不展示 `probeFailed`。
8. 已安装 target 的 `aw config set/unset/reset` 或主控制台配置保存命中 dynamic artifact refresh / SkillTrigger apply 时，若受影响 Codex 或 Claude 版本不达标，本次配置命令在写 config store 前失败，不写 runtime artifact、dynamic diagnostic cache 或部分平台刷新；未安装插件预配置、orphan store raw reset、可认领但尚未认领位置的 config-only 预写入，以及未触发 refresh/apply 的纯 config store 更新不做宿主 agent 版本门禁。可认领 project target 的配置写入如果触发 project artifact refresh，必须先失败并提示认领；未触发时 receipt 以 `adoptExistingRequired` 或 `noRefreshTarget` 标明没有刷新 target。
9. 主控制台诊断、主控制台触发的等价写动作和发现类页面有可追踪验收：主控制台首屏和发现页列表读取与 `status --json.consoleItems`、current catalog discovery 同源的 agent version/native 摘要；需要 Codex user-scope native view 的诊断详情走 verbose 读路径；只读页面不写状态、不刷新或移除 marketplace；主控制台触发的写动作、配置保存和“重新应用配置”复用 direct CLI 的版本门禁、`--platform both` 整体失败语义和 Codex user-scope native RPC hard gate，并展示同样的阻断原因与下一步动作。
10. 支持 Codex 且声明 hooks 的插件，在 user-scope native bundle 中生成 Codex 0.131 可识别的 `.codex-plugin/plugin.json` 的 `hooks` 字段；bundle layout 校验接受并校验该字段。
11. 同一插件安装到 Codex project scope 时，hooks 仍写入 repo `.codex/hooks.json`，不会尝试创建 project-scope native plugin install state。
12. 本期不验收旧版 AW-managed Codex user hooks 自动迁移；AW 不再为 Codex user scope 新写 `.codex/hooks.json` hook groups，且无 ownership evidence 的用户/外部 hook groups 保留。
13. 普通 `status` 和不带 verbose 的 `status --json` 不启动 `codex app-server`；Codex user-scope `status --verbose`、`status --verbose --json`、主控制台诊断详情和发现页能使用 `plugin/installed`、`plugin/read` 和 `plugin/list` 辅助诊断 native view。RPC 不可用时显示 native view unknown，不把它误判为 healthy，也不影响 Codex project-scope repo-managed 状态判断。
14. RPC 证据只能作为 Codex user-scope native view 和外部 ownership 诊断证据；没有 AW ownership、install record、recovery marker 或受管 cache/config evidence 时，RPC 结果不能授权 cleanup、takeover 或 `marketplace/remove`。RPC 能证明同名 user-scope native 插件由非 AW 来源管理时，user-scope 写命令按 external ownership 冲突失败。
15. 需要刷新 Codex user-scope AW marketplace 的安装、升级、重装和 native repair 路径使用 Codex 原生 `marketplace/upgrade` 或等价刷新接口；只有删除后已无任何受管 `@aw` Codex user-scope native 使用者或恢复证据时，user-scope cleanup/uninstall 才使用 `marketplace/remove`；失败时不手改 Codex config/cache 伪装成功。`aw init`、普通 `status`、`cleanup --plan`、主控制台只读首页和 Codex project-scope 路径不调用这些接口。
16. Claude Code 2.1.88 源码支持的插件能力仍通过 AW bundle/layout 校验：skills、hooks、commands、agents、MCP、LSP、user config 和 marketplace install/uninstall 不被本轮改动破坏。
17. `docs/plugin-authoring.md`、`docs/plugin-installation.md`、`docs/architecture.md`、`.agents/skills/create-agent-workflows-plugin/` 参考文档和相关 fixtures 同步描述新的 agent 版本门禁与 Codex native hooks/RPC 行为。
