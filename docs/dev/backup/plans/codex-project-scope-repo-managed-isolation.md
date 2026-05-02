# Codex Project Scope Repo-Managed 隔离计划

## 结论

Codex 上游当前没有真正的 project scope 原生插件安装能力。`aw` 现有实现为了让 `project` scope 可用，把 Codex 原生 plugin / marketplace 状态写进用户级 `~/.codex/config.toml`，再把部分扩展产物写进当前仓库 `.codex/`。这能让功能跑通，但语义上不是项目隔离：同一个用户启用的 native plugin 会被其它仓库看见或复用。

本计划把 **Codex `project` scope 全部收敛为 repo-managed artifacts**：

- 不再为 Codex project install 调用 `codex plugin marketplace add`。
- 不再为 Codex project install 写 `~/.codex/config.toml [marketplaces]` 或 `[plugins]`。
- 不再为 Codex project install 写 `sharedNativeRefs.projects`。
- `skills` 写到当前仓库 `.agents/skills`。
- 公共 `slashCommands` 在 Codex project scope 转成当前仓库 `.agents/skills` 下的 manual-only skill；Claude 继续安装为原生 slash command。
- `mcpServers` 转写到当前仓库 `.codex/config.toml [mcp_servers.*]`。
- `extensions.instructions` / `permissions` / `hooks` / `agents` 继续走仓库内 `.codex/*`。
- `apps` 在 Codex project scope 首版拒绝安装，因为上游没有项目级等价物。

`user` scope 不改语义，仍走 Codex native plugin 平面。

## 已确认决策

这些决策已经确认，不再作为开放问题处理：

- **Skill 落点**：Codex project scope 使用 `.agents/skills`，不使用用户级 native plugin，也不依赖 project `.codex` 伪装 native install。
- **Skill 命名与冲突**：复制 bundle 内 Codex skill 目录时保留原名，显式触发名 `$skill-name` 不变化。若目标 repo 已存在同名 `.agents/skills/<skill>`，只有当前插件已通过 AW tracking 管理该目录时才允许刷新；未受管目录或其它 AW 插件管理的同名目录都 fail fast。
- **跨平台 slash command 公共协议**：新增公共 `slashCommands` 源码协议，作为插件作者维护 slash command 工作流的唯一来源。Claude Code 侧渲染并安装为原生 `commands`；Codex 侧渲染为 `allow_implicit_invocation: false` 的 skill，通过 `$<name>` 或结构化 skill mention 显式调用，不参与自动触发。Codex project scope 下这类生成 skill 仍写入 repo `.agents/skills/<name>`，按 `kind: "skill"` + `artifactKey: "<name>"` tracking，不新增 Codex 原生 `/command` 假象。
- **公共 slash command 源码 schema**：首版只接受 `slashCommands` 根目录直属的 `*.md` 文件，拒绝子目录命名空间。每个命令文件必须有 frontmatter，顶层必填 `description`，并允许 `claude` / `codex` 显式分平台配置块。Claude-only frontmatter 与运行时语义只能放在 `claude` 块或通过平台模板只出现在 Claude 渲染结果里；Codex 渲染结果必须是合法 skill 指令，不得残留 `$ARGUMENTS` / `$1` 等 Claude 参数占位或命令结果填充语法。
- **公共 slash command 图标资源合同**：`codex.interface.icon_small` / `icon_large` 首版完整支持资源复制，但源码值必须沿用 Codex skill 合同，只能写成 `./assets/...`。源文件位于 `slashCommands` 根目录下的保留 `assets/` 目录；build 只复制被 frontmatter 引用的资源到每个生成的 Codex skill 的 `assets/` 目录，并把 `agents/openai.yaml` 保持为合法的 `./assets/...` 路径。缺文件、越界路径、绝对路径、`../`、反斜杠、非 `assets/` 路径或非普通文件都必须在写 bundle / repo artifact 前 fail fast。`slashCommands/assets/` 是唯一允许的资源子目录，不作为命令命名空间；其它子目录仍按嵌套命令拒绝。
- **旧 command 配置移除**：源码 manifest 不再保留 Claude-only command 作者入口，`manifestOverrides.claude.commands`、旧式 `commands` 配置和只为旧 `commands/` 打包的写法都直接删除或改为 build/validate 错误。当前仍处于开发阶段，不做双读、迁移或 fallback；唯一作者入口是公共 `slashCommands`。`.claude-plugin/plugin.json.commands` 只作为 build 产物存在，用来喂给 Claude 原生 runtime。
- **MCP 落点**：插件 `.mcp.json` / `manifest.mcpServers` 转写为 `.codex/config.toml [mcp_servers.*]`。
- **MCP 形态合同**：Codex project scope 首版完整透传 rendered `.mcp.json` 里的 `mcpServers.<server>` JSON 子树，而不是只支持 `command + args` 这类扁平子集。实现必须把 string / boolean / number / array / object 转成 TOML 等价结构；`null` 因 TOML 无等价表示，必须在写入前 fail fast。写入或刷新某个 server 时，要替换 `[mcp_servers.<server>]` 及其所有后代子表；删除时也要一并清理后代子表，不能留下旧 `tools.*`、`env`、`http_headers` 等孤儿子表。
- **MCP server key 身份**：`mcpServers` 的 server key 使用 rendered JSON object 的原始属性名，不做大小写折叠、路径拆分或安全字符集收窄。实现必须支持需要 TOML quoted key 的名字，例如包含点号、空格、斜杠、大小写或 Unicode 的 key；`artifactKey` 持久化同一份原始 key。TOML writer / parser / remover / drift comparator 都必须按 TOML quoted key 语义定位同一个 server，`[mcp_servers."acme.tools v1"]` 是单个 server key `acme.tools v1`，不能被误当成 `[mcp_servers.acme.tools]` 的嵌套路径。
- **MCP 同名冲突**：目标 `.codex/config.toml` 已有同名 server 且不是 AW 管理时，首版 fail fast，不覆盖、不自动备份恢复。
- **MCP tracking 身份**：`GeneratedArtifact` 增加通用 `artifactKey`，用于表示共享文件里的稳定子项身份；MCP server 使用 server key，避免多个 server 因同一个 `.codex/config.toml` 路径被折叠。
- **GeneratedArtifact path 合同**：tracking manifest 中的 `GeneratedArtifact.path` 继续使用绝对文件系统路径，保持现有 instruction / permission / hook / agent 的语义。本文中出现的 `.agents/skills/<skill>`、`.codex/config.toml` 是 repo 内目标位置或人类展示写法，不是新的持久化格式。
- **Upgrade 下的旧产物清理**：同一插件在 Codex project scope 升级时，使用旧 tracking artifact 集合和新版本生成 artifact 集合做受控差集清理；新版已删除或改名的 repo skill / MCP server 会被清掉，用户手写或其它插件管理的内容不受影响。
- **`capabilityChanged` 显式升级事务**：Codex project scope 保留当前显式 upgrade 的“先 uninstall、再 install”控制流，但这两段必须被同一个恢复快照包住。进入 uninstall 前先捕获旧 repo-managed artifacts、`.codex/config.toml`、tracking manifest、`installed.json`、skill trigger preference 和 lifecycle/config snapshot metadata 的完整 baseline；内部 uninstall 不触发插件 `uninstall` lifecycle。uninstall 成功后，只要新版 install 在 repo artifact 写入、config transaction commit、upgrade lifecycle、tracking 写入、ledger 写入或后续回滚链路任一点失败，就必须恢复旧安装，而不是留下“旧版已删、新版未成”的半状态。
- **AW_HOME 边界**：Codex project-only 命令禁止的是共享 local marketplace/runtime 副作用：不得初始化、修复、替换 `~/.aw/plugins` runtime，不得重放共享 skill trigger preference，也不得因为只读 catalog 准备改写 `~/.aw/config.json` 或本地 marketplace bundle。已合入的 AW bookkeeping 仍然保留：成功安装 / 升级 / 卸载可以按通用合同写 `~/.aw/installed.json`、`~/.aw/plugin-install-snapshots/`，用户在配置向导里显式选择 user scope 时也可以写 `~/.aw/plugin-config/`。所有这些 bookkeeping 写入都必须晚于 Codex project 写入安全预检，不能作为 catalog 准备的副作用。
- **Required config 预检顺序与写入层合同**：Codex project install / explicit upgrade / mixed explicit command 必须先完成不会写状态的安全预检，包括 project installability、user config external ownership、必要的 project `.codex/config.toml` 解析、tracking identity 和 unmanaged repo artifact 冲突检查；这些通过后，才允许进入 required AW config preflight / prompt 并写入 config store。required config preflight 必须继承当前基线合同：按 `pluginName + schema source manifest identity` 聚合，同一条 install / explicit upgrade 命令里同一插件只 prompt 一次、只写一次；prompt 返回的 `selectedScope` 是唯一写入层，后续所有 target 都复用这次写入后的 effective config，不能按 platform / target 循环重复 prompt 或把配置写回命令原始 scope。这样外部同名 native 插件、损坏 TOML 或不可安全恢复的 tracking 不会留下新的 AW config，也不会在 mixed 命令里产生重复配置写入。
- **Lifecycle / config snapshot 接入**：`scripts` / `config` 已经是当前基线。Codex project scope 必须复用同一套 `CommandExecutionContext`、`--script-timeout`、required config preflight、lifecycle runner 和 scope-owned install snapshot。install / upgrade 的 lifecycle 在 repo-managed artifacts 写完后、tracking / ledger 提交前执行；uninstall lifecycle 在 repo artifact 清理前执行；capabilityChanged 内部 uninstall 不能触发插件 `uninstall` lifecycle，随后新版安装只触发 `upgrade` lifecycle。status 的 config/script health 只读接入 status matrix，不能执行 lifecycle 或刷新 marketplace。
- **Codex project executable gate**：Codex project scope 的 repo-managed install、uninstall、显式 upgrade 和 `upgrade --all` 不要求本机 PATH 里存在 `codex` executable，也不要求 `AW_FORCE_CODEX_AVAILABLE=1`。只要目标不会走 Codex native marketplace/plugin runner，就按 repo evidence 和只读 catalog 执行；Codex user scope、或任何实际需要 native runner 的路径仍沿用平台可用性检查。
- **交互式 Codex project 平台候选**：interactive install / uninstall / upgrade 的平台解析也必须使用同一套 repo-managed 可执行性模型，不能只把 `detectEnvironment().codex.available` 当成 Codex 是否可选的唯一依据。只要最终目标是 Codex project repo-managed install，或当前 project scope 已有可识别的 Codex repo-managed evidence，交互式平台 prompt 必须暴露 Codex 候选；只有真实需要 native runner 的 target 才受本机 `codex` executable availability 限制。
- **交互式共享兼容性合同**：改造 `interactive.ts` 的平台解析时，必须保留现有 `interactive install` 共享入口合同。`marketplace.policy.products` 过滤、`both` 下单平台插件禁用 / 默认选择、显式多插件名共同兼容平台交集、无共同兼容平台时的 dispatch 前失败，以及 fake prompt 返回不兼容平台时的 runtime 拒绝，都属于通用兼容性判断；Codex project repo-managed 可执行性只是在这些通用判断之后补充 Codex project 候选，不能覆盖或绕过它们。
- **Apps**：Codex project scope 遇到 `manifest.apps` 直接拒绝安装；提示用户改用 `--scope user`。
- **外部同名 Codex native 插件**：Codex project scope 仍把 user `~/.codex/config.toml [plugins]` 中启用的同名外部 marketplace 插件视为运行时歧义保护。它不作为 project installed evidence；`install` / 显式 `upgrade` 在写任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 前 fail fast。`uninstall` 不把它当成硬阻塞：只要当前 project scope 有 tracking / ledger 证明的 repo-managed evidence，就允许继续清理 AW 自己管理的 repo skill / MCP / extensions，但保留 warning / next step，提示 user-native 同名插件仍然存在；若没有 project managed evidence，则按“当前 scope 未受管”处理，不删除 user native state。若 project scope 已有 repo-managed evidence，`status` 仍以 repo-managed installed signal 为主，外部同名冲突只作为附加诊断和 next step，cell health 为 `needsAttention`，不能短路成 `external`。
- **损坏的 project `.codex/config.toml`**：Codex project scope 命令只有在实际需要读取或改写 project config layer 时，才受 `.codex/config.toml` 语法损坏影响。需要触达 project config layer 的路径包括 MCP server 写入 / 删除 / status、managed `developer_instructions` 写入 / 删除 / status，以及 tracking / historical evidence 已证明当前 scope 管理了这些 config-backed artifact 的 uninstall / upgrade；skills-only 且不触达 `.codex/config.toml` 的 install / status / uninstall / upgrade 不应被无关 TOML 损坏阻塞。`install`、显式 `upgrade`、显式 `uninstall` 和需要读取 config-backed artifact 的 `status` 在任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前 fail fast，`status` 不把受影响 item 降级成 `unknown`。`upgrade --all` 不把这类 target-scoped 错误提升为整命令失败；受影响的 config-backed target 进入 `skipped[]`，code 固定为 `projectConfigUnreadable`，同批 skills-only target 以及 `--platform both` 下其它不受影响 target 继续按各自规则执行。
- **损坏的用户级 `~/.codex/config.toml`**：Codex project scope 不能把用户级配置健康度当作 repo-managed installed evidence 的前置条件，但凡需要可靠读取 user native 平面来判断外部同名插件或 project trust 的路径必须显式分流。`install` 和显式 `upgrade` 无法解析 user config 时早失败，原因是不能排除 user-native 外部同名插件带来的运行时歧义；失败必须发生在任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前；即使同一显式命令还选中了 Claude 或其它可执行 target，也不能部分继续。`status` 和已有 repo-managed evidence 的 `uninstall` 允许继续基于当前 repo 的 tracking / ledger / artifacts 工作，不能把 user config 读失败解释成“没有 externalOwnership”或“项目 trusted”；`externalOwnership` 检查状态与 `projectTrust` 降为 `unknown` 诊断。没有 project managed evidence 时，仍按“当前 scope 未受管 / 不可判定”处理，不删除 user native state。`upgrade --all -p codex -s project` 发现 user config 语法损坏时，所有 Codex project target 都标记为 skipped，并逐项报告原因；因为所有 Codex project target 都必须先完成 reliable external ownership 预检，不存在可在同一 platform/scope 下绕过 user config 继续执行的 target。只有显式 `upgrade --all --platform both` 的混合执行允许跳过受这项预检阻塞的 Codex project target，并让其它 platform/scope 目标按各自规则继续或失败；`--platform auto` 必须先完成 evidence-first 平台推断，若同时存在多平台 evidence 或任一候选平台为 `unknown`，先拒绝 auto，不进入 per-target skipped 分支。
- **Skill trigger 适用性合同**：Codex project scope 先按目标产物计算 `skillTriggerApplicability`，再决定是否需要 ledger 恢复偏好。`none` 表示目标没有 skill trigger 面，例如 `mcp-only` / extensions-only；`fixed` 表示存在 skill artifact 但 runtime 固定，公共 `slashCommands` 生成的 manual-only skill、或全部 skill 都不允许 install override 的插件都归入这一类；`overridable` 表示至少一个有效 Codex project skill 允许 `--skill-trigger` 改写 runtime。只有 `overridable` 需要恢复 `skillTriggerPreference`，`none` / `fixed` 不能伪造成 `default` 偏好，也不能因为 ledger 缺失被 tracking-only 偏好合同卡住。
- **Tracking-only upgrade 偏好合同**：Codex project scope 的 tracking manifest 可以作为 status、discovery、uninstall 和 historical cleanup 的 repo-managed evidence，但首版不能从 tracking-only evidence 推导 skill trigger preference。若 tracking 证明当前 project scope 已受管，且该 target 的 `skillTriggerApplicability === "overridable"`，而对应 ledger scope record 缺失、不可用、未标记 `managed === true`，或无法恢复 install options，显式 `upgrade` 在未传 `--skill-trigger` 时必须 deterministic refusal，并且拒绝发生在 uninstall、repo artifact 写入、stale prune、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前；传入显式 `--skill-trigger` 且 tracking 身份完整时才允许继续，成功后写回新的 ledger scope record。`upgrade --all` 首版不支持 `--skill-trigger`，因此只有这类 `overridable` target 必须逐项记为 skipped，code 固定为 `installOptionsUnavailable`，不能静默按 `default` 升级。`none` / `fixed` target 不要求偏好来源，仍按 external ownership、config、tracking identity 和 catalog compatibility 等其它 preflight 判定。
- **Tracking-only 重复安装偏好合同**：Codex project scope 重复 `install` 不能成为绕过 upgrade 偏好拒绝的旁路。若 tracking 证明当前 project scope 已受管，且该 target 的 `skillTriggerApplicability === "overridable"`，但 ledger scope record 缺失、不可用、未标记 `managed === true`，或无法恢复 install options，且本次没有显式 `--skill-trigger`，`install` 必须 deterministic refusal；传入显式 `--skill-trigger` 且 tracking 身份完整时，才允许刷新 repo artifacts 并重建 ledger scope record。`mcp-only`、`slashCommands-only` 和其它 `fixed` target 的重复安装不需要为了恢复偏好而拒绝。
- **legacy `scopeInitialized` 兼容合同**：旧字段在 Codex project repo-managed 新模型下只表达“当前 scope 是否有 AW-managed evidence”，不表达健康度。完整的 ledger managed scope record 或完整的 AW tracking repo-managed artifact 都让 `scopeInitialized = "yes"`；只有 orphan / unmanaged evidence、user-native external ownership、或完全没有当前 scope evidence 时为 `"no"`；ledger degraded 且没有完整 tracking 能证明归属、tracking manifest 不可读、scope identity 不可建立、或 tracking 身份损坏到无法证明归属时为 `"unknown"`。project trust、external ownership check unknown、catalog embedded fallback、item missing / drifted 不单独改变这个旧字段，它们只影响 `repoManagedSessionState`、health、warnings 和 next steps。
- **显式 `install` / `upgrade --platform auto --scope project` 推断合同**：执行型显式命令不能只按 native executable availability 过滤候选，也不能默认偏向 Codex project repo-managed。命令可以一次接收多个插件，因此 `auto` 必须先计算整组插件的共同兼容平台，再聚合当前 scope 的 managed evidence；只有共同候选平台本身唯一，或整组 evidence 能唯一、安全地指向同一平台时，才允许自动落到该平台。插件同时支持 Claude 和 Codex、Claude 可用、Codex native executable 不可用、Codex project repo-managed 可执行、且当前 scope 没有任何完整 managed evidence 时，`auto` 必须拒绝并要求显式 `--platform codex|claude|both`。同一条命令里不同插件分别指向 Claude / Codex、任一候选侧 evidence 为 `unknown` 且无法安全排除、或整组 evidence 无法共同收敛到唯一平台时，也必须在写入前拒绝。
- **显式 / 默认 `uninstall --platform auto --scope project` 推断合同**：`uninstall` 也必须使用同一套 scope-aware evidence-first 平台解析，不能在命令入口直接被 native availability gate 或单平台 detected result 短路。`aw uninstall <plugin> -p codex -s project` 只要目标是 Codex project repo-managed artifact 清理，就不受 `codex` executable availability 限制。`aw uninstall <plugin> --platform auto --scope project` 必须先统计当前 scope 的完整 managed evidence；只有 evidence 唯一指向 Codex project repo-managed 时才自动落到 Codex，只有 evidence 唯一指向 Claude 时才自动落到 Claude。同时存在 Claude managed evidence 与 Codex project repo-managed evidence 时，`auto` 必须拒绝并要求显式平台；任一候选侧 evidence 为 `unknown` 且无法安全排除时也必须拒绝。没有 Codex project repo-managed evidence 的普通 native uninstall 继续沿用既有 native availability 规则。
- **`upgrade --all --platform auto` evidence-first 推断**：`upgrade --all` 在 `--platform auto` 下必须先用只读 evidence 统计当前 scope 的 ledger managed record 和 repo tracking managed evidence，再决定平台。Codex project tracking-only target 也计入 Codex 平台推断；orphan / unmanaged evidence 不计入；损坏到无法判定归属的 evidence 让对应平台为 `unknown`。只有 evidence 唯一收敛到一个平台后，auto 才进入该平台内部的 target discovery、偏好恢复、external ownership、catalog compatibility 和 skipped/refuse 预检；若多个平台都有 evidence，或任一候选平台为 `unknown` 且无法安全排除，必须在任何 target 写入或 per-target skip 前拒绝自动推断。
- **`upgrade --all` skipped 输出与退出码合同**：首版不为 `install` / `uninstall` / `upgrade` 写命令新增 `--json` stdout 契约。`upgrade --all` 的结构化跳过结果落在 direct command 返回值的稳定 `skipped[]` 字段中，CLI human receipt 同步展示 succeeded / skipped 摘要；reporter/debug event 可以补充诊断，但不能作为 skipped target 的唯一稳定承载面。CLI entry 退出码也必须稳定：部分 target 成功、部分 skipped 时退出 `0`；全部 target skipped 且没有成功升级时退出 `1`。
- **`upgrade --all` target-level 拒绝 code 合同**：`SkippedUpgradeTarget.code` 首版稳定支持 10 个值，不能只停留在类型占位：`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`trackingIntegrityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`。每个 code 都必须有唯一触发条件、固定优先级、direct command 返回值断言、CLI human receipt 断言和退出码回归。catalog 整体不可加载、命令参数错误、`--platform auto` 无法唯一推断仍是 target 外 fatal error，不进入 `skipped[]`。
- **Skills-only status 不受 project trust 误伤**：Codex project scope 只有 skill、没有 MCP / instructions / hooks / rules / agents 时，repo skill 的状态只由 tracking、repo `.agents/skills` 和 pristine bundle 决定。即使当前 catalog 走 embedded fallback，或者 repo trust 是 `untrusted` / `unknown`，也不能把可见的 skills-only 安装降成 `unknown` / `needsAttention`。
- **未声明 kind 的 summary 语义**：`repoManagedSessionState.skills` / `repoManagedSessionState.mcpServers` 始终输出稳定字段；当当前 manifest / historical placeholder 没有声明或证明某个 kind，且当前 repo 也没有该 kind 的 tracked / orphan evidence 时，对应 summary 使用 `state: "not_applicable"`。summary 层的 `absent` 只表示“该 kind 已声明或有期望，但当前 scope 没有对应受管项”，不能再承担“未声明”的语义。
- **Item unknown 的健康语义**：`repoManagedSessionState.items[].state = "unknown"` 表示当前 item 不能可靠判定，例如 hooks JSON 不可解析、tracking 诊断导致无法建立 item 身份。若没有更高优先级的 `missing` / `drifted` / `orphan` / `blockedByProjectTrust`，包含 `unknown` item 的 cell health 和 summary health 都是 `unknown`；human / JSON / next steps 必须直接暴露该 unknown 来源。
- **旧记录迁移**：当前 Codex project scope 还没有上线发布，不需要兼容或迁移已有 project native 记录。

## 当前基线

### 本仓库现状

当前实现把 Codex project scope 拆成两部分：

- `packages/cli/src/adapters/codex.ts`
  - `requiresNativePlugin(plugin)` 把 `skills`、`mcpServers`、`apps` 都视为需要 native plugin。
  - `hasRepoManagedArtifacts(plugin)` 只覆盖 `extensions.instructions`、`permissions`、`hooks`、`agents`。
  - `CodexAdapter.installPlugin(plugin, scope)` 即使收到 `scope === 'project'`，只要插件需要 native plugin，就会注册用户级 local marketplace，并写用户级 `[plugins."<plugin>@aw"] enabled = true`。
  - `CodexAdapter.installPlugin()` 读取 user config 后才做 external ownership 预检；`CodexAdapter.status()` 也会无条件读取 user config 来判断 `[plugins]`、`[projects]`、marketplace health 和 project trust。`readCodexConfigFile()` 是硬解析入口，用户级 TOML 语法损坏会让 project-only status / install 先失败，落不到 repo-managed 分支。
  - project scope 只有在 `hasRepoManagedArtifacts(plugin)` 为 true 时才允许安装；因此只有 `skills` 的插件会被判定为 Codex project 不可安装。
  - ledger 里通过 `sharedNativeRefs.projects` 记录“这个 repo 引用了用户级 native plugin”。
- `packages/cli/src/commands/install.ts`
  - `installCommand()` 在进入 adapter 之前固定调用 `preparePluginTargetsForCommand(..., { ensureLocalMarketplace: true })`，会先准备并可能重建共享 `~/.aw`。
  - `installTargetsOnPlatforms()` 现在已经接入 AW config / lifecycle 基线：先做 required config preflight，再创建 lifecycle/config 安装快照，物化 skill trigger，安装 native plugin，写 repo-managed extensions，执行 install / upgrade lifecycle，最后写 tracking 和 ledger。
  - skill trigger preference 目前物化到共享 `~/.aw/plugins/<plugin>/<platform>/skills`，所以 Codex project scope 的触发偏好会影响同一用户下其它 scope。
- `packages/cli/src/commands/uninstall.ts` / `packages/cli/src/commands/upgrade.ts`
  - `uninstallTargetsOnPlatforms()` 已在平台卸载和 repo artifact 清理前执行 uninstall lifecycle，并通过安装快照解析旧版本脚本 / config 真值。
  - 显式 upgrade 的 `capabilityChanged` 分支已用 `skipLifecycle: true` 调用内部 uninstall，然后由新版 install 路径以 `operation: "upgrade"` 执行 upgrade lifecycle；本计划不能再把内部 uninstall 当成用户真实 uninstall lifecycle。
  - `upgradeCommand()` / `installCommand()` 仍在 target / platform 解析前使用写入型 marketplace 准备，因此 Codex project-only 路径还需要拆只读 catalog 和写入型 runtime 准备。
- `packages/cli/src/utils/plugin-config.ts` / `packages/cli/src/utils/plugin-scripts.ts`
  - AW 自管配置已经落地：user store 位于 `<AW_HOME>/plugin-config/<plugin>/config.json`，project store 位于 `<AW project root>/.agent-workflows/plugin-config/<plugin>/config.json`；effective config 按 `default < user < project` 合并。
  - 安装快照已经落在 `<AW_HOME>/plugin-install-snapshots/`，ledger scope record 通过 `lifecycleConfigSnapshot` 指向快照；status 的 config/script health 以 `installSnapshot` 为优先真值。
  - 因此本计划里的“Codex project-only 不触碰 `~/.aw`”必须收窄为“不触碰共享 local marketplace/runtime”；`installed.json`、install snapshots 和用户显式选择 user scope 时的 plugin-config 属于 AW bookkeeping，但只能在安全预检之后写入。
- `packages/cli/src/utils/detect.ts` / `packages/cli/src/commands/common.ts` / `packages/cli/src/commands/upgrade.ts`
  - `detectEnvironment()` 只有在 `AW_FORCE_CODEX_AVAILABLE=1` 或 PATH 能找到 `codex` executable 时，才把 Codex 标记为 available。
  - `resolveTargetPlatforms()` 和 `resolveUpgradeAllPlatforms()` 在显式 `-p codex`、`--platform auto` 推断和 `upgrade --all` 路径上都会先消费这层 availability gate；即使 Codex project scope 目标只需要写 repo-managed artifacts，也会被“本机没有 Codex CLI”挡住。
- `packages/cli/src/commands/interactive.ts`
  - `detectAvailablePlatforms()` 直接返回 `listDetectedPlatforms(detectEnvironment(...))`，交互式入口仍把 native executable availability 当成平台候选来源。
  - `resolveInstallPlatforms()` 在 interactive install 路径上会先要求至少检测到一个可用平台；缺少 `codex` executable 时，Codex project repo-managed 安装可能在候选选择前被挡住。
  - `resolveInteractiveScopeAndPlatform()` 在 interactive uninstall / upgrade 路径上也使用同一组 detected platforms。Claude 可用、Codex executable 不可用时，prompt 可能只展示 Claude，即使当前 project scope 已有可安全处理的 Codex repo-managed evidence。
- `.agents-plugin` / `.claude-plugin`
  - slash command 当前仍是 Claude Code 专属的 `commands` 能力；Codex 没有同级原生 `/command` extension surface。
  - 作者若想提供跨平台“用户手动触发工作流”，通常需要同时维护 Claude `commands/` 和 Codex manual skill 两套入口，内容容易漂移。
- `docs/plugin-installation.md`、`docs/architecture.md`、`docs/plugin-authoring.md`
  - 文档已经明确写着 Codex native marketplace/plugin 注册始终 user scope，`project` 只影响 repo-managed artifacts。这是当前实现的真实描述，但不是本次目标语义。

### 上游 Codex 源码依据

上游源码路径：`/Users/LeslieChan/Desktop/codex/codex-rs`

关键结论：

- 原生 plugin enabled 只来自 user layer。
  - `core-plugins/src/loader.rs` 的 `configured_plugins_from_stack()` 读取 `config_layer_stack.get_user_layer()` 中的 `[plugins]`。
  - project `.codex/config.toml` 里的 `[plugins]` 不会成为 native plugin install state。
- 原生 marketplace 安装状态也只来自 user layer。
  - `core-plugins/src/installed_marketplaces.rs` 的 `installed_marketplace_roots_from_layer_stack()` 读取 user layer 的 `[marketplaces]`。
  - `core-plugins/src/marketplace_add.rs` 的 local marketplace add 写 user config；local source 指向源目录，不生成 repo-local native install。
- repo skills 有上游支持。
  - `core-skills/src/loader.rs` 会扫描 `.agents/skills`，并按 repo skill roots 加载。
  - 同文件也支持从 config layer folder 的 `skills` 目录加载，但本计划选择 `.agents/skills` 作为 AW project scope 统一落点。
- project config layer 可以承载配置和扩展，但受 trust gating。
  - `core/src/config_loader/mod.rs` 从 `.codex/config.toml` 加载 project config layer；未 trusted 的项目会禁用 project-local config / hooks / exec policy。
  - `hooks/src/engine/discovery.rs` 从 config layer folder 读取 `hooks.json` 或 TOML hooks。
  - `core/src/config/agent_roles.rs` 从 config layer folder 的 `agents/` 读取 agent roles。
  - Codex config 合并路径支持 project `.codex/config.toml` 中的 `mcp_servers`。

因此，上游目前能支持的“真正项目隔离”不是 project-native plugin，而是 repo-managed artifacts。

## 目标和非目标

### 目标

- 让 `aw install <plugin> -p codex -s project` 不写任何用户级 Codex native plugin / marketplace 状态。
- 让 Codex project scope 的 install / upgrade 不初始化、不修复、不重放共享 local marketplace/runtime；即使 `~/.aw` 缺失、stale、marketplace 布局损坏或 ledger degraded，也不能因为 project-only 的 catalog 准备去创建或修复 `~/.aw/plugins` runtime、`~/.aw/config.json` 或 embedded bundle 副本。成功路径仍按通用 AW bookkeeping 写 `installed.json`、install snapshot，必要时写用户显式选择的 user config store。
- 让 Codex project scope 的安装证据全部来自当前仓库：
  - `.agents/skills`
  - `.codex/config.toml`
  - `.codex/hooks.json`
  - `.codex/rules/*.rules`
  - `.codex/agents/*.toml`
  - `.codex/.agent-workflows-manifest.json`
- 让只有 skills 的插件也能作为 Codex project scope 候选，例如现有 `git-commit`。
- 定义跨平台 `slashCommands` 公共协议，让作者只维护一份手动触发工作流；Claude 安装为原生 slash command，Codex 安装为 manual-only skill。
- 让 install / uninstall / upgrade / status / discovery 都使用同一套 scope-aware capability 模型。
- 让 skill trigger preference 在 Codex project scope 只改当前 repo 的 `.agents/skills`，不改共享 `~/.aw`。
- 让卸载只清 AW 自己生成和追踪的 repo-managed 内容，保留用户手写配置。
- 让 Codex project repo-managed install / upgrade / `upgrade --all` 在缺少本机 `codex` executable 时仍可执行，只要该命令不需要 native runner。

### 非目标

- 不实现上游暂时没有的 Codex project-native plugin install。
- 不把 project `.codex/config.toml [plugins]` 当作 native plugin enabled state。
- 不把 native plugin cache 或 marketplace source 复制进 repo。
- 不兼容未上线开发阶段的旧 Codex project scope native 引用记录。
- 不在首版支持 Codex project scope apps。
- 不实现 Codex 原生 `/command` UI 或 `/command` 解析；Codex 侧只提供等价的显式 skill 入口。
- 不允许公共 slash command 在 Codex 侧被模型自动触发；它必须保持 manual-only。
- 不兼容旧 command 配置；源码层不再支持 Claude-only `commands` 作者入口。
- 不改变 Claude Code 的 scope 语义。
- 不改变 Codex user scope 的 native plugin 安装方式。

## 新语义矩阵

| 能力 | Codex user scope | Codex project scope |
| --- | --- | --- |
| marketplace 注册 | `~/.codex/config.toml [marketplaces.aw]` | 不写 |
| plugin enabled | `~/.codex/config.toml [plugins."<plugin>@aw"]` | 不写 |
| plugin skills | native plugin 从 `~/.aw/plugins/<plugin>/codex/skills` 加载 | 复制到 repo `.agents/skills/<skill>` |
| 公共 slash commands | 构建为 manual-only Codex skill，并由 native plugin 从 `~/.aw/plugins/<plugin>/codex/skills` 加载 | 构建为 manual-only Codex skill，复制到 repo `.agents/skills/<command>` |
| skill trigger preference | 继续物化共享 `~/.aw` runtime 副本 | 只物化 repo `.agents/skills/<skill>/agents/openai.yaml` |
| MCP servers | native plugin 从 bundle `mcpServers` 加载 | 转写 `.codex/config.toml [mcp_servers.*]` |
| apps | native plugin 加载 | fail fast |
| permissions / execpolicy | user config layer 或现有 user 落点 | `.codex/rules/*.rules` |
| hooks | user config layer 或现有 user 落点 | `.codex/hooks.json` |
| agent roles | user config layer 或现有 user 落点 | `.codex/agents/*.toml` |
| tracking | user / project 按现有模型 | `.codex/.agent-workflows-manifest.json` |
| ledger native refs | user ref | 不写 project ref |

## 目标目录布局

安装命令：

```bash
aw install git-commit --platform codex --scope project
```

目标仓库：

```text
repo/
├─ .agents/
│  └─ skills/
│     └─ git-commit/
│        ├─ SKILL.md
│        └─ agents/
│           └─ openai.yaml
├─ .codex/
│  ├─ config.toml
│  ├─ hooks.json
│  ├─ rules/
│  │  └─ <plugin>.rules
│  ├─ agents/
│  │  └─ <agent>.toml
│  └─ .agent-workflows-manifest.json
└─ AGENTS.md
```

说明：

- `.agents/skills/<skill>` 保留插件 bundle 内原 skill 目录名。
- `AGENTS.md` 仍默认视为用户项目文档，不作为本计划新增写入目标。
- `.codex/config.toml` 需要 round-trip 保留用户已有配置，只替换 AW 管理的 MCP server 条目。

## 实施计划

### 1. 拆分 Codex capability 模型

当前 `requiresNativePlugin(plugin)` 是平台级判断，不区分 scope。需要改成 scope-aware 模型。

建议新增或替换为以下语义函数：

- `requiresCodexNativePlugin(plugin, scope)`
  - user scope：`skills || slashCommands || mcpServers || apps`
  - project scope：始终 false
- `hasCodexProjectManagedArtifacts(plugin)`
  - true：`skills || slashCommands || mcpServers || extensions.instructions || extensions.permissions || extensions.hooks || extensions.agents`
  - false：没有任何 project 可写能力
  - 不承载 `apps` 拒绝语义；例如 skills + apps 仍返回 true，apps-only 返回 false。
  - 若 `apps` 存在，由独立的 project installability validation fail fast；即使同时存在其它能力，首版也不做部分安装。
- `getCodexProjectManagedKinds(plugin)`
  - 返回更细的 kind，例如 `skill`、`mcpServer`、`instruction`、`permission`、`hook`、`agent`
  - 公共 `slashCommands` 在 Codex runtime 中落成 skill artifact，因此对 cleanup / tracking / status 使用 `kind: "skill"`；若需要面向用户展示来源，可另加非身份字段，不改变 artifact identity。

同步调整：

- `CodexCapabilitySnapshot`
  - 保留兼容读取旧字段的能力，但新写入使用更细的 `managedKinds` 或 `projectManagedKinds`。
  - `requiresNativePlugin` 的新写入值必须来自 `requiresCodexNativePlugin(plugin, scope)`；Codex user scope 的 `slashCommands-only` 插件也要记录为 native capability，不能因为它没有显式 `skills` / `mcpServers` / `apps` 而写成 false。
  - 不再用 `hasRepoManagedArtifacts` 代表 project 可安装性，因为 skills / MCP 现在也能 repo-managed。
- `packages/cli/src/commands/install.ts` 中类似 `hasNativeCapabilities()` 的判断
  - 对 Codex project scope 不能再把 `skills` / `mcpServers` 归入 native-only 拦截。
- interactive candidate 过滤
  - Codex project scope 候选先用 `hasCodexProjectManagedArtifacts()` 判断是否存在 repo-managed kind，再用 project installability validation 计算是否禁用和禁用原因。
  - `git-commit` 这类 skills-only 插件应进入候选列表。
  - 只有公共 `slashCommands`、没有显式 `skills` / MCP / extensions 的插件，也应作为 Codex project scope 候选，因为 Codex 侧会生成 repo skill。
  - `apps-only` 插件在无插件名交互安装里不进入候选；`skills` / MCP / `slashCommands` + `apps` 这类 mixed apps 插件保留为候选但标记 disabled，原因说明 Codex project scope 不支持 apps，需要改用 user scope 或拆分插件。

#### 公共 slash command 协议

新增 `.agents-plugin/plugin.json` 顶层公共字段：

```json
{
  "slashCommands": "./slash-commands"
}
```

约定：

- `slashCommands` 是源码协议，不是平台私有 override；路径必须以 `./` 开头，指向插件源码里的命令目录。
- 命令文件使用 Markdown 文本，命令名来自文件 basename，例如 `slash-commands/review.md` 对应 Claude `/review`，Codex 生成 skill `review`。
- 首版不支持子目录命名空间，唯一例外是保留的 `assets/` 资源目录。`slash-commands/debug/start.md` 这类嵌套命令必须在 validate / build 阶段早失败，不能只取 basename 生成 `start`，也不能发明 `debug-start` 之类的 Codex skill 映射；`slash-commands/assets/*.md` 也不能被当成命令文件。
- 每个 `slash-commands/*.md` 必须包含 frontmatter。顶层只允许公共字段和分平台块：

  ```yaml
  ---
  description: 执行代码审查
  claude:
    description: 执行代码审查
    allowed-tools:
      - Bash(git diff *)
      - Read
    model: inherit
    argument-hint: "[path]"
    shell: bash
  codex:
    description: 执行代码审查
    interface:
      display_name: Code Review
      short_description: 审查代码变更
      icon_small: ./assets/review-16.png
      icon_large: ./assets/review-64.png
      brand_color: "#334155"
      default_prompt: 审查当前变更
  ---
  ```

- 公共必填字段：
  - `description`：非空字符串，映射到 Claude command description、Codex `SKILL.md.description`，也作为 `codex.interface.short_description` 的默认值。
- `claude` 块只允许 Claude command 能力字段：
  - `description`：可选，覆盖 Claude command description；未写时使用顶层 `description`。
  - `allowed-tools`、`model`、`argument-hint`、`shell`：语义沿用 Claude command frontmatter。
  - `disable-model-invocation` 不允许由作者配置；生成时固定写 `true`。
- `codex` 块只允许 Codex skill 元数据字段：
  - `description`：可选，覆盖 Codex `SKILL.md.description`；未写时使用顶层 `description`。
  - `interface`：可选，字段集合沿用 `agents/openai.yaml.interface` 的 `display_name`、`short_description`、`icon_small`、`icon_large`、`brand_color`、`default_prompt`；未写的 `display_name` 默认用命令名，未写的 `short_description` 默认用 Codex description。
  - `icon_small` / `icon_large` 的源码值必须是 `./assets/...`。路径按 POSIX 规则规范化，禁止绝对路径、`../`、反斜杠、空 segment、非 `assets/` 前缀和目录目标；引用文件必须存在于 `slashCommands` 根目录的 `assets/` 保留目录内。build 时把每个 command 实际引用的图标复制到生成的 Codex skill 的 `assets/` 目录，保留相对路径，并在生成的 `agents/openai.yaml` 中继续写合法的 `./assets/...`。同一个资源被同一 command 的两个 icon 字段引用时只复制一次；不同 command 各自复制到自己的 generated skill，避免跨 skill 共享相对路径。
  - `policy` 不允许出现在源码中；生成的 `agents/openai.yaml.policy.allow_implicit_invocation` 固定为 `false`。
- 顶层出现 `allowed-tools`、`model`、`argument-hint`、`shell`、`disable-model-invocation`，或 `codex` 块里出现 Claude-only 字段，都必须 validate / build 失败，提示把平台专属语义放进对应分平台块或删除。
- `slashCommands` 根目录下只有直属 Markdown 命令文件和保留 `assets/` 资源目录是合法输入。`assets/` 内的 Markdown 不生成命令；除 `assets/` 之外的任何子目录仍按“首版不支持子目录命名空间”失败。`assets/` 目录不会被整体复制进平台 bundle，只有被 `icon_small` / `icon_large` 引用且校验通过的文件进入对应 Codex generated skill。
- 公共命令默认是“用户显式触发”的工作流。Claude 侧安装为原生 slash command，并在生成 frontmatter 时保持 `disable-model-invocation: true`；Codex 侧安装为 manual-only skill，`agents/openai.yaml` 固定写 `policy.allow_implicit_invocation: false`。这类生成 skill 不接受 `--skill-trigger auto` 覆盖，也不参与 `skillTriggers` 的 install override。
- Codex 显式调用方式由平台决定：首版暴露为 `$review` 或结构化 skill mention，不承诺 Codex 支持 `/review`。
- 如果公共 slash command 名和显式 Codex skill 名冲突，或者生成后的 `.agents/skills/<name>` 与其它插件 / 用户文件冲突，必须沿用 repo skill 冲突规则 fail fast，不能静默改名。
- 旧 command 配置不再参与 schema：源码 manifest 里出现 `manifestOverrides.claude.commands`、旧式 `commands` 字段，或仅为旧 `commands/` 目录配置 Claude-only 打包规则时，build / validate 必须直接失败并提示改用 `slashCommands`。
- 源码 manifest / 校验合同要覆盖完整链路：
  - `PluginManifestSource` 新增 `slashCommands?: string`，`validatePluginManifest()` 将 `slashCommands` 纳入顶层白名单，并按 `skills` / `mcpServers` 相同的 `./` 相对路径规则规范化。
  - 默认目录 `slash-commands/` 存在但没有声明 `slashCommands` 时，像 `skills/`、`.mcp.json`、`.app.json` 一样 fail fast，提示补声明；声明路径不存在、越界、不是目录或目录内没有可生成的 Markdown 命令时也必须失败。
  - 命令名来自 Markdown 文件 basename，并沿用现有 skill 目录名 / `artifactKey` 校验规则；非法 basename、归一化后重复、与显式 skill 同名时，build 阶段直接失败。
  - `codex.interface.icon_small` / `icon_large` 校验必须在生成任何平台 bundle 前完成；非法路径或缺失文件要 deterministic failure，并在错误里点名对应 command、字段和资源路径。负向场景不能留下半生成的 Claude command、Codex skill、repo artifact、tracking 或 ledger。
- build 阶段把公共命令渲染到两个平台：
  - Claude bundle：生成 `.claude-plugin/plugin.json.commands` 指向的原生 `commands` 目录。
  - Codex bundle：生成 `.codex-plugin/plugin.json.skills` 可加载的 skill 目录，包含 `SKILL.md` 和 manual-only `agents/openai.yaml`。
- `slash-commands/*.md` 支持 `buildConfig.templates`；构建时先按目标平台渲染命令 Markdown，再分别生成 Claude command 和 Codex skill，避免生成物绕过模板变量。Claude 渲染结果可以使用 `$ARGUMENTS`、`$1`、命令结果填充等 Claude-only 语法；Codex 渲染结果中如果仍包含这些语法，必须 fail fast，因为 Codex skill 没有等价输入合同。
- `slashCommands` 源目录只作为 build 输入，不进入平台 bundle。即使 `buildConfig.fileRules` 的 include 命中该目录，构建器也不得把原始 `slash-commands/` 复制进 Claude / Codex bundle；显式把 `slash-commands/**` 或旧 `commands/**` 当平台文件规则配置时，validate / build 直接报错，提示改用 `slashCommands`。
- 作者工具也必须同步到新合同：更新 `validate_plugin.js`、参考文档、隐藏示例夹具和 authoring-tool 集成测试，让新 `slashCommands` 可用、旧 `commands` 入口报错，而不是只更新 README 说明。
- 不提供从旧 command 配置到 `slashCommands` 的自动迁移；仓库内现有插件、示例和测试夹具要直接改成新协议。

### 2. 拆分命令入口的 catalog 准备与写入型 local marketplace 初始化

当前 `installCommand()` / 显式 `upgrade` / `upgrade --all` 在真正解析平台和进入 adapter 之前，会通过 `ensureLocalMarketplace: true` 触发 `ensureLocalMarketplace()`。这会复制 embedded bundle、重放 ledger，并原子替换共享 `~/.aw`。只改 `CodexAdapter.installPlugin()` 不够，Codex project-only 命令仍会提前改写共享 runtime。

需要把“只读 catalog 解析”和“写入型 local marketplace 初始化”拆开：

- 新增只读 catalog 准备路径，例如 `preparePluginTargetsForCommand(..., { catalogMode: 'readOnly' })`。
  - 优先读取现有可用 local marketplace catalog。
  - local marketplace 缺失、stale、布局损坏或 ledger degraded 时，回退 embedded bundle catalog。
  - 不创建或修复共享 runtime，不写 `~/.aw/config.json` / `~/.aw/plugins`，不替换 embedded bundle 副本，不重放 skill trigger preference。
  - 只读 catalog 阶段也不能写 AW bookkeeping；`installed.json`、install snapshot 和 config store 只能在后续写命令通过安全预检后按对应阶段写入。
- `aw install <plugin> -p codex -s project` 和等价的 Codex project-only 交互式安装必须使用只读 catalog。
- 显式 `aw upgrade <plugin> -p codex -s project` 也必须先走只读 catalog；mixed 显式命令要先完成所有写入前预检，确认不会整条失败后，才允许为实际需要 native/runtime 的 Claude 或 Codex user target 进入写入型 local marketplace 初始化。
- 显式 `aw upgrade <plugin> -p codex -s project` 在任何 uninstall 或 repo artifact 清理前，必须先基于当前 catalog 完成 project-scope 可安装性预检；如果当前 catalog 新增 `apps` 或已经没有任何 project managed kind，要早失败并保持旧安装文件、tracking 和 ledger 不变。
- `upgrade --all -p codex -s project` 的列表发现和 bundle 解析也要只读；不能为了列出或加载 project-managed 插件而修复共享 marketplace/runtime。
- `install`、显式 `upgrade` 和 `upgrade --all` 只要命中 Codex project scope 且本次目标包含 MCP / managed `developer_instructions`，或历史 tracking 证明当前 scope 已管理 config-backed artifact，就必须先完成 `.codex/config.toml` 解析预检。`install` 和显式 `upgrade` 遇到语法损坏时，在任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前失败；`upgrade --all` 遇到同类 target-scoped 失败时，把受影响 target 记录到 `skipped[]`，code=`projectConfigUnreadable`，继续处理同批 skills-only target 和 mixed 命令中的其它 platform/scope target。纯 skills-only 路径不触达 project config layer，不做这项预检。
- `install` 和显式 `upgrade` 还必须在写任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 前完成 user `~/.codex/config.toml` external ownership 预检；user config 语法损坏时直接失败。这个预检适用于 skills-only 目标，因为 repo skill 与 user-native 同名插件也会在 Codex 运行时产生歧义。
- Codex project 的 required AW config preflight / prompt 必须排在上述安全预检之后。安全预检失败时，不能创建或修改 `<AW project root>/.agent-workflows/plugin-config`、`<AW_HOME>/plugin-config` 或 install snapshot；安全预检通过后，配置向导可以按通用合同写入 prompt 选择的 scope。
- 显式 `install` / `upgrade` 在 `--platform both|auto --scope project` 下只要解析出的任一 Codex project target 未通过写入前预检，整条命令 deterministic refusal；不新增 `skipped[]`，不执行其它 platform target，也不输出部分成功 receipt。拒绝必须发生在任何 repo artifact、tracking、ledger、native config、AW config / install snapshot bookkeeping 或共享 runtime 写入前。
- `upgrade --all -p codex -s project` 发现 user config 语法损坏时，不进入任何 Codex project target 的刷新、清理、tracking 或 ledger 写入；该 platform/scope 下所有待处理 target 都记录为 skipped，并在 direct command 返回值、CLI human receipt 与 warning/debug 诊断中逐项列出原因。纯 `-p codex -s project` 没有可继续执行的 project repo-managed target；只有显式 `upgrade --all --platform both` 的混合执行能让不属于 Codex project scope 的 target 按各自规则继续。`upgrade --all --platform auto --scope project` 必须先完成 evidence-first 平台推断，推断唯一后才进入该平台内部的 skipped 逻辑；若同一 scope 同时存在 Claude managed evidence 和 Codex project evidence，或任一候选平台 evidence 为 `unknown`，先拒绝 auto。
- `upgrade --all -p codex -s project` 从 tracking manifest 发现 repo-managed target 时，必须先计算 `skillTriggerApplicability`。只有 `overridable` target 需要确认对应 ledger scope record 可用且能恢复 install options；缺失或不可用时把该 target 记录为 skipped，code 固定为 `installOptionsUnavailable`，并说明 tracking 只能证明归属、不能恢复 skill trigger 偏好。`none` / `fixed` target 不要求 ledger 偏好来源，不能因为缺失 install options 被跳过。显式 `upgrade` 同样不能把 `overridable` target 的缺失 scope record 静默回落为 `default`，只能要求用户传入 `--skill-trigger` 或先修复 ledger。
- `upgrade --all --platform auto` 的平台推断不能只看 ledger managed 计数。实现需要新增只读 evidence 统计入口，按当前 scope 分平台收集：
  - ledger managed scope record。
  - 当前 repo tracking manifest 中属于 Codex project scope、且 identity 完整的 AW-managed repo artifacts。
  - Claude 现有 project / user managed evidence。
  其中 Codex project tracking-only evidence 计入 Codex 平台；orphan / unmanaged evidence 不计入；tracking manifest 不可读、scope key 无法建立或 artifact identity 损坏时，对应平台状态为 `unknown`。若只剩一个平台有 managed evidence，则 `auto` 推断到该平台；若多个平台都有 evidence，或任一候选平台为 `unknown` 且无法安全排除，继续要求用户显式传 `--platform codex|claude|both`。
- 上一条 evidence-first 推断只负责发现“该处理哪个平台”，不负责恢复 install options。即使 Codex project tracking-only 让 `auto` 推断到 Codex，后续 `upgrade --all` 也只能在 target 为 `overridable` 且 ledger scope record 不可恢复偏好时把 target 记为 skipped，code 固定为 `installOptionsUnavailable`；`none` / `fixed` target 继续执行其它 preflight，不能被误判成偏好缺失。
- 显式 `install <plugins...>` 和显式 `upgrade <plugins...>` 在 `--platform auto --scope project` 下使用同一套当前 scope evidence 统计来消除歧义，但合同和 `upgrade --all` 不完全相同：它们按同一条命令的插件集合整体推断，不支持 target-level `skipped[]`，也不能因为 Codex project repo-managed 不需要 native executable 就静默覆盖 native availability 的判断。具体规则是：
  - 先基于整组插件的 `marketplace.policy.products` / capability 计算共同候选平台，判断 Claude project、Codex project repo-managed、Codex user/native 等候选可执行性；Codex project repo-managed 可执行性独立于本机 `codex` executable。没有共同候选平台时，必须在 dispatch 前拒绝。
  - 若共同候选平台已经唯一，`auto` 可以落到该平台，但仍要继续执行该平台对应的写入前预检；例如 Codex project-only target 不能被本机 `codex` executable 缺失挡住。
  - 若共同候选平台同时包含 Claude project 和 Codex project repo-managed，则继续聚合整组当前 scope managed evidence。只有每个会影响推断的插件都有完整 evidence，且所有完整 evidence 都唯一指向同一平台时，`auto` 才能落到该平台；Codex project tracking-only evidence 也能让显式 upgrade / 重复 install 稳定落到 Codex。
  - 当前 scope 没有任何完整 managed evidence，或整组里不同插件分别指向 Claude / Codex，或某个插件的完整 evidence 无法和其它插件共同收敛到同一平台时，拒绝 `auto` 并要求显式 `--platform codex|claude|both`；典型场景是 Claude executable 可用、Codex executable 不可用、但 Codex project repo-managed 可以写入。
  - 若任一候选平台 evidence 为 `unknown`，例如 tracking manifest 不可读、scope key 无法建立、或 tracking artifact identity 损坏，且无法安全排除该平台，整条命令拒绝 `auto` 并要求用户先修复 evidence 或显式指定平台。
- 显式 / 默认 `uninstall <plugin>` 在 `--platform auto --scope project` 下同样不能直接复用旧的 `resolveTargetPlatforms()` availability-first 分支。实现需要在 `uninstallCommand()` 进入卸载执行前先做只读 managed evidence 统计：
  - `aw uninstall <plugin> -p codex -s project` 若只清理 Codex project repo-managed artifacts，不要求本机 `codex` executable 可用，也不调用 native runner。
  - `aw uninstall <plugin> --platform auto --scope project` 在当前 scope 只有完整 Codex project repo-managed evidence 时，稳定落到 Codex；即使 Claude executable 可用、Codex executable 不可用，也不能改走 Claude。
  - 当前 scope 同时存在 Claude managed evidence 与 Codex project repo-managed evidence 时，`auto` 拒绝推断并要求显式平台；不能为了“有一个 native 平台可用”而静默选择 Claude。
  - 任一候选平台 evidence 为 `unknown`，例如 tracking manifest 不可读、scope key 无法建立、或 tracking artifact identity 损坏，且无法安全排除时，`auto` 拒绝推断；错误应说明 evidence unknown / 需要显式平台，而不是普通 platform unavailable。
  - 上述拒绝必须发生在 uninstall lifecycle、repo artifact 删除、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前。
- `auto` 一旦拒绝，必须发生在任何 repo artifact、tracking、ledger、native config、AW config / install snapshot bookkeeping 或共享 runtime 写入前；错误信息要说明是平台歧义或 evidence unknown，而不是误报“当前环境没有检测到可用 Codex”。
- `platform=auto|both` 时，命令应先解析出真实会执行的 platform/scope 组合，再按组合决定是否需要写入型初始化；不能在 prepare 阶段无条件 `ensureLocalMarketplace()`。
- `PreparedMarketplaceState` 需要能表达 `source: 'embedded' | 'local'` 和 `changed: false`，让 reporter/status 可以说明本次使用只读 catalog，而不是暗示已初始化 local marketplace。
- 平台解析要把“Codex 可用性”和“Codex project repo-managed 可写性”拆开。显式 `-p codex -s project`、最终只落到 Codex project repo-managed target 的 `--platform auto|both --scope project`、以及 `upgrade --all -p codex -s project`，不能因为 `detectEnvironment().codex.available === false` 而提前失败；只有解析出的目标实际需要 Codex native runner 时，才继续要求本机 `codex` executable 可用。
- 交互式入口必须复用同一套 platform/scope 可执行性判断，不能让 `interactive.ts` 继续保留独立的 native availability gate：
  - `resolveInstallPlatforms()` 不能在 `detectAvailablePlatforms()` 为空时直接拒绝 Codex project repo-managed 安装；若 scope 为 `project` 且候选插件包含 Codex project managed artifacts，Codex 必须作为可选平台参与 prompt / selection。
  - `resolveInstallPlatforms()` 若拆 helper，通用 helper 仍负责 `marketplace.policy.products`、显式插件集合的兼容平台交集、`both` 下单平台插件禁用 / 默认选择、无共同兼容平台时的早失败，以及 prompt 返回值的兼容性校验；Codex project helper 只负责在 scope / target 可 repo-managed 执行时补充 Codex 候选和 native executable gate 分流。
  - `resolveInteractiveScopeAndPlatform()` 在 interactive uninstall / upgrade 中要结合 current scope 的 managed evidence。只要 project scope 存在 Codex repo-managed tracking / ledger evidence，平台 prompt 必须展示 Codex，即使本机 PATH 没有 `codex` executable。
  - Claude executable 可用、Codex executable 不可用的混合环境下，interactive platform prompt 不得隐藏可执行的 Codex project repo-managed 选项；fake prompt 若返回候选外平台或候选外插件，仍由 runtime validation deterministic refusal。
  - 真实需要 native runner 的 Codex user scope、native-only target 或其它非 repo-managed target，继续沿用 Codex executable availability gate。

回归要求：

- `~/.aw` 缺失时执行 Codex project install / explicit upgrade / `upgrade --all`，只读 catalog 和安全预检阶段不得创建 `~/.aw`；成功提交安装后，只允许出现通用 AW bookkeeping，例如 `installed.json`、install snapshot，以及用户显式选择 user scope 时的 plugin-config。
- `~/.aw/config.json` stale、marketplace 布局损坏或 `installed.json` degraded 时，上述 project-only 命令不得修复、替换或重写共享 marketplace/runtime；`installed.json` 只能按命令最终提交、rollback 或 degraded 记录合同写入，不能作为 catalog 准备副作用。
- 只读 catalog 下仍能发现并安装 embedded bundle 里的 skills-only / mcp-only 插件。
- PATH 缺少 `codex` executable 且没有 `AW_FORCE_CODEX_AVAILABLE=1` 时，`aw install <plugin> -p codex -s project` 对 repo-managed 插件仍成功，不调用 native runner，不写 user native config，也不创建或修复共享 marketplace/runtime。
- PATH 缺少 `codex` executable 且没有 `AW_FORCE_CODEX_AVAILABLE=1` 时，显式 `aw upgrade <plugin> -p codex -s project` 仍按 repo evidence 和只读 catalog 执行；若目标需要 native runner，才按原平台不可用错误失败。
- PATH 缺少 `codex` executable 且只有 Codex project tracking / repo-managed evidence 时，`aw upgrade --all -p codex -s project` 仍能发现 target 并进入 per-target preflight；`overridable` / `none` / `fixed` 的 skip 或执行结果由 ledger 偏好、tracking identity、external ownership 和 catalog compatibility 决定，而不是被 availability gate 提前挡住。
- Claude executable 可用、Codex executable 不可用、插件同时支持 Claude 和 Codex、且 Codex project repo-managed 可执行时，显式 `install <plugin> --platform auto --scope project` 和显式 `upgrade <plugin> --platform auto --scope project` 如果当前 scope 没有完整 managed evidence，必须拒绝自动推断并要求显式平台；命令不得创建或修复共享 marketplace/runtime，不得写 Claude project、Codex repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或 native config。
- 同一混合环境下，如果当前 scope 只有完整 Codex project tracking / ledger evidence，显式 `install` 的重复安装和显式 `upgrade` 的 `--platform auto --scope project` 必须稳定落到 Codex project repo-managed 路径，不因缺少 native `codex` executable 改走 Claude。
- 同一混合环境下，如果当前 scope 有任一候选平台 evidence 为 `unknown` 且无法安全排除，显式 `install` 和显式 `upgrade` 的 `--platform auto --scope project` 必须拒绝自动推断；错误要点名 evidence unknown / 需要显式平台，不能伪装成普通 platform unavailable。
- 显式多插件 `install/upgrade --platform auto --scope project` 要先计算整组共同兼容平台，再聚合 evidence：两个插件分别只有 Claude / Codex project managed evidence 时必须拒绝，两个插件都只有 Codex project managed evidence 时才自动落到 Codex；任一插件的候选 evidence 为 `unknown` 时整条命令拒绝，且拒绝发生在任何写入前。
- PATH 缺少 `codex` executable 且没有 `AW_FORCE_CODEX_AVAILABLE=1` 时，`aw install -i -p codex -s project` 对 repo-managed 插件仍能进入候选选择并完成安装，不因 detected platforms 为空而提前失败。
- PATH 同时缺少 `codex` 和 `claude` executable 且没有强制可用环境变量时，默认 `aw install -i --scope project`（即 `--platform auto`）仍必须把 Codex project repo-managed 插件放进候选或 prompt，并可完成 Codex project 安装；同一环境下 `aw install -i --scope user`、或只含 native-only / 无 project managed kind 的候选，仍按没有可用平台或不可安装内容确定性失败。
- PATH 缺少 `codex` executable 且没有 `AW_FORCE_CODEX_AVAILABLE=1` 时，`aw uninstall <plugin> -p codex -s project` 对只有 repo-managed artifacts 的已安装插件仍能清理当前 repo 受管内容，不调用 native runner，不修改 user native config，也不创建或修复共享 marketplace/runtime。
- Claude executable 可用、Codex executable 不可用，且当前 scope 只有完整 Codex project tracking / ledger evidence 时，`aw uninstall <plugin> --platform auto --scope project` 必须稳定落到 Codex project repo-managed 清理路径；不能因 Claude 可用改走 Claude。
- 同一混合环境下，当前 scope 同时存在 Claude managed evidence 与 Codex project repo-managed evidence 时，`aw uninstall <plugin> --platform auto --scope project` 必须拒绝自动推断并要求显式平台；断言 repo artifact、Claude project 文件、tracking、ledger、AW config / install snapshot bookkeeping、native config 和共享 runtime 都保持命令前状态。
- 同一混合环境下，当前 scope 任一候选平台 evidence 为 `unknown` 时，`aw uninstall <plugin> --platform auto --scope project` 必须拒绝自动推断；错误要点名 evidence unknown / 需要显式平台，不能伪装成普通 platform unavailable。
- PATH 缺少 `codex` executable 且当前 project scope 有 Codex repo-managed evidence 时，interactive uninstall / upgrade 的平台 prompt 仍能选择 Codex，并继续进入候选选择或升级模式选择。
- Claude executable 可用、Codex executable 不可用时，interactive install / uninstall / upgrade 不得把可执行的 Codex project repo-managed 选项从 prompt 中隐藏；对应测试只断言 Codex 可选性，不把本轮计划扩展成新的 `both` 展示规则。
- interactive install 仍要覆盖 `marketplace.policy.products` 过滤，确认 Codex project repo-managed 候选补丁不会让策略外平台重新进入 prompt 或 dispatch。
- interactive install 仍要覆盖 `platform=both|auto` 下单平台插件禁用 / 默认选择，确认新增 Codex project 候选不会冲掉已有 `both` 候选禁用规则。
- interactive install 仍要覆盖显式多插件名的共同兼容平台交集；没有共同兼容平台时必须在 dispatch 前确定性失败。
- interactive install 的 fake prompt 返回不兼容平台、候选外平台或候选外插件时，仍必须由 runtime validation deterministic refusal，不得因为 Codex project 候选补丁被当成有效选择。
- capabilityChanged 的显式 project upgrade 如果预检失败，旧 repo skill / MCP / extensions 不被卸载或改写。
- capabilityChanged 的显式 project upgrade 如果 uninstall 已成功、随后新版 install 在写 repo skill、提交 `.codex/config.toml` 后写 tracking / ledger，或任一回滚链路失败前抛错，必须恢复旧 repo-managed 文件、tracking manifest 和 ledger baseline。
- project `.codex/config.toml` 语法损坏且命令目标需要读取或改写 project config layer 时，Codex project install / explicit upgrade 早失败，不写 repo artifacts、tracking、ledger、AW config / install snapshot bookkeeping，也不创建或修复共享 marketplace/runtime；`upgrade --all` 将受影响的 config-backed target 记为 `skipped[]` / `projectConfigUnreadable`，不写该 target 的 repo artifacts、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime，并继续处理同批 skills-only target；skills-only 目标不因无关 TOML 损坏失败。
- user `~/.codex/config.toml` 语法损坏时，Codex project `install` / 显式 `upgrade` 早失败，不写 repo artifacts、tracking、ledger、AW config / install snapshot bookkeeping，也不创建或修复共享 marketplace/runtime；`upgrade --all -p codex -s project` 将该 platform/scope 下所有 target 标记为 skipped，并逐项报告 external ownership 预检无法完成。
- Required AW config 的回归要覆盖顺序：若同一目标既缺 required config 又命中外部同名 native 冲突、user config 损坏、project TOML 损坏或 tracking identity 损坏，命令必须先报安全预检错误，fake prompt 不被调用，config store 和 install snapshot 都保持命令前状态；安全预检通过但缺 required config 时，才进入配置向导或非交互 config refusal。
- Required AW config 的聚合回归要覆盖 mixed install / explicit upgrade：同一插件同时解析到多个 platform / scope target 时只 prompt 一次、只写一次；`prompt.configurePlugin` 返回的 `selectedScope` 若不同于命令 `--scope`，也只写入 `selectedScope` 对应 store，后续所有 target 复用写入后的 effective config。
- Required AW config 的写层回归要和 `aw config configure --scope` 明确分开：`aw config configure --scope user|project` 仍是硬约束，fake prompt 返回另一层必须被拒绝且不写任何 store；install / explicit upgrade preflight 才允许用户在 prompt 中改写写入层，并且仍按同一插件同一 schema source 只 prompt 一次、只写一次。
- Required AW config 的 mixed 命令回归要断言安全预检通过后不会按 platform / target 二次 prompt 或二次 patch；receipt、warning 和 debug 里也不能出现同一插件同一 schema 的重复配置写入记录。
- repo tracking 仍有 Codex project `overridable` skill evidence，但 ledger scope record 缺失或不可用时，显式 upgrade 未传 `--skill-trigger` 要早拒绝，`upgrade --all` 要逐项 skip；两者都不得按 `default` 偏好重写 repo skill，也不得先 prune 旧 artifact。`mcp-only` / `fixed` evidence 不因偏好缺失被拒绝或跳过。

### 3. 改造 Codex install / uninstall native 路径

`packages/cli/src/adapters/codex.ts` 的 `CodexAdapter.installPlugin(plugin, scope)` 需要改成：

- user scope：
  - 保持现有 native install 行为。
  - 必要时调用 `ensureLocalMarketplace()`。
  - 调用 `codex plugin marketplace add <canonical AW_HOME>`。
  - 写 `~/.codex/config.toml [plugins."<plugin>@aw"] enabled = true`。
- project scope：
  - 不调用 native runner。
  - 不调用 `ensureLocalMarketplace()` 作为 native 前置。
  - 不写 user config 的 `[marketplaces]` 或 `[plugins]`。
  - 只做 project capability validation；真正文件写入交给 repo-managed installer。
  - external ownership 预检应从 native install 副作用里拆出来，作为 project 写入前的只读安全检查。user config 无法解析时，这个检查返回 deterministic refusal，不能退化成“没有外部同名插件”。

`uninstallPlugin(plugin, scope)` 对 project scope 也应变为 no-op native path：

- 不读取或清理 user native plugin enabled state。
- 不按 project scope 修改 `sharedNativeRefs.projects`。
- repo-managed 文件清理由 tracking / generated artifacts 流程负责。
- 若 user config 无法解析，project uninstall 仍可在已有 repo-managed evidence 时继续清理 AW 自己拥有的 repo artifacts；只能把 external ownership / project trust 诊断标成 unknown，不能因此触碰或删除 user native state。

`upgradePlugin()` 如果内部复用 uninstall + install，也要保证 project scope 不触发 native uninstall / install。

命令编排层也要同步改，不只改 adapter：

- `installTargetsOnPlatforms()` 不能继续只按 manifest 的 `skills` / `mcpServers` / `apps` 粗判 native 是否写入。native plan / applied 事件、`result.nativePlugins` 和后续 receipt 必须来自 scope-aware 的真实执行结果。
- Codex project scope 即使 manifest 里有 `skills` / `mcpServers`，也只能记录 repo-managed artifact 写入；`nativePlugins.codex` 必须为空，debug/reporter 事件应体现 native path skipped。
- upgrade 合并多个 install result 时，也要保留这个 scope-aware 结果；不能因为 capabilityChanged 或复用 install 流程，把 Codex project scope 重新合并成 native success。
- CLI receipt 只能在 `nativePlugins` 明确记录真实 native 写入时输出 “Codex marketplace 注册 / 插件启用”；Codex project install / upgrade 成功时不得输出这些 native success 文案。

#### 命令层 preflight / status 错误边界

当前命令主链路会把 `adapter.status()` 同时当作状态诊断、external ownership 判断和写入前守门；新语义下必须拆开，否则同一份 user config 异常会在不同命令里被错误地合并成一种结果。

- 新增独立的 Codex project 写入前预检 helper，例如 `preflightCodexProjectWriteTarget()` 或等价命名。它只做写入安全判断：project capability validation、user config external ownership 读取、必要时的 project `.codex/config.toml` 可解析性、tracking identity 完整性、unmanaged repo artifact 冲突和 ledger install option 恢复。它不能调用会聚合状态诊断的 `adapter.status()`，也不能产生 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping、共享 runtime 或 native config 写入。
- `installCommand()` / 显式 `upgradeCommand()` 在 target/platform 解析后、required config preflight / prompt 前调用这个 preflight；`installTargetsOnPlatforms()` 和显式 `runUpgradeTargets()` 也要保证在任何 materialize、uninstall、repo artifact 写入、stale prune、tracking、ledger 或 marketplace 准备前已完成同一套 preflight。user config 无法解析或 external ownership 不能可靠判定时，`install` / 显式 `upgrade` deterministic refusal；不能把 `ExternalOwnershipStatus.present = false`、`checkState = "unknown"` 当成安全通过。
- `preflightRequiredPluginConfigs()` 不能再作为 Codex project explicit install / upgrade 的第一项可写步骤。实现上可以把通用 config preflight 从 `installTargetsOnPlatforms()` 里拆出，或提供 `skipConfigPreflight` 后在命令层按“安全预检 -> config preflight -> 写入执行”的顺序调用；但不能让缺配置的 prompt 先于 external ownership / project TOML / tracking integrity 预检发生。
- required config preflight 的聚合和写入层语义不能在这次拆分中退化。聚合键固定为 `pluginName + schema source manifest identity`，同一条 install / explicit upgrade 命令中同一插件只允许一次 required config prompt、一次 config store 写入；prompt 返回的 `selectedScope` 是唯一写入目标。写入后必须重新解析 effective config，并把结果复用到后续所有 platform / scope target；mixed 命令即使横跨 Claude 与 Codex project，也不能在安全预检通过后按 target 再 prompt、再落盘，或把 prompt 中选择的 `user` / `project` 改写回命令原始 scope。
- `uninstallTargetsOnPlatforms()` 可以继续读取 status 来拿 repo-managed evidence，但不能把 `externalOwnership.present` 当成 project uninstall 的硬阻塞。若当前 project scope 有 tracking / ledger / historical repo-managed evidence，则允许清理 AW 自己拥有的 repo artifacts，并把外部同名或 user config 不可读作为 warning / next step；若没有 project managed evidence，仍按“当前 scope 未受管”处理，不删除 user native state。
- `runUpgradeAll()` 需要先完成 target discovery，再对每个 target 执行 target-level preflight。Codex project target 因 scope 未初始化、user config 损坏、external ownership 无法可靠判断、external ownership 已确认冲突、`overridable` tracking-only 偏好不可恢复、tracking identity 损坏、config-backed artifact 预检失败、current catalog 已不再可 project 安装、current catalog 已不含 historical target，或同名 unmanaged repo artifact 冲突而不能安全刷新时，记录到 `skipped[]`，code 必须落入 `SkippedUpgradeTarget.code` 的 10 个稳定值之一，不阻塞其它 platform/scope target。`none` / `fixed` tracking-only target 不因缺少偏好来源而跳过。只有命令参数错误、`--platform auto` 无法唯一推断、catalog 整体不可加载等 target 外问题才作为整命令 fatal error。
- `statusCommand()` 不能继续无差别吞掉所有 adapter/status 错误。需要定义可识别的 fatal status error 类型，或等价判定函数：project `.codex/config.toml` 损坏且当前 status 目标需要读取 config-backed artifact 时，整条 `aw status` 失败，JSON 模式不能输出半截 JSON；user config 不可读、external ownership check unknown、project trust unknown、普通 item unknown 仍按 cell/report 诊断展示。
- 命令层测试必须直接覆盖同一份 user config 语法损坏下的分流：skills-only project `status` 继续展示 repo item 真值并标 `externalOwnership.checkState = "unknown"`；已有 repo-managed evidence 的 project `uninstall` 继续清理并输出 unknown 诊断；project `install` / 显式 `upgrade` 在写任何状态前拒绝，mixed 显式命令也整条失败且不执行其它 target；`upgrade --all` 把对应 Codex project targets 记为 skipped，`upgrade --all` mixed 命令中的其它 target 继续执行。

#### `upgrade --all` result / receipt 合同

`upgrade --all` 不能继续只有“成功处理了一组 plugins”的返回模型；`upgrade --all` mixed 命令需要同时表达哪些 target 成功、哪些 target 被安全跳过。

新增稳定结构化结果：

```ts
export interface SkippedUpgradeTarget {
  platform: PlatformName;
  scope: Scope;
  plugin: string;
  reason: string;
  code:
    | 'scopeNotInitialized'
    | 'codexProjectUserConfigUnreadable'
    | 'externalOwnershipUnknown'
    | 'externalOwnershipPresent'
    | 'trackingIntegrityError'
    | 'installOptionsUnavailable'
    | 'catalogNotCurrent'
    | 'catalogNotProjectInstallable'
    | 'projectConfigUnreadable'
    | 'unmanagedRepoArtifactConflict';
}

export interface UpgradeCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  skipped: SkippedUpgradeTarget[];
  nativePlugins: NativePluginsByPlatform;
  marketplace?: PreparedMarketplaceState;
}
```

- `SkippedUpgradeTarget.code` 首版稳定支持上面 union 中的全部 10 个值。实现不能新增临时 code，也不能把这些 code 只藏在 warning / reason 文案里。
- 同一 target 同时命中多个 target-scoped blocking reason 时，只落一个 `code`，优先级按以下列表从前到后固定。target 外 fatal error 仍先于本列表中止整条命令，不产生 `skipped[]`。
- `scopeNotInitialized` 只用于已经被 legacy AW bookkeeping、install snapshot 或等价历史记录放入 `upgrade --all` 候选，但完成当前 project scope key 解析后，既没有完整 ledger managed scope record，也没有完整 repo tracking managed evidence 的 target。plain absence、orphan / unmanaged evidence、external-only evidence 不得制造这个 code；新 evidence-first discovery 不应把这些普通缺席项加入候选。
- `codexProjectUserConfigUnreadable` 只用于 Codex project target 在 external ownership / project trust 安全预检前无法读取或解析 user `~/.codex/config.toml` 的情况。这个 code 优先于 `externalOwnershipUnknown` 和 `externalOwnershipPresent`；同一 platform/scope 下的所有 Codex project targets 都逐项 skipped。
- `externalOwnershipUnknown` 只用于 user config 已可读取和解析，但 external ownership / project trust 仍无法可靠判定的 target，例如 user native marketplace identity 或 plugin enablement 状态处于 degraded / unsupported 形态。不能把 user config 语法损坏归到这个 code。
- `externalOwnershipPresent` 只用于 user config 可读且确认存在同名 user-native 外部 marketplace plugin，会让 Codex project repo-managed artifact 与外部 native plugin 产生运行时歧义的 target。显式 install / upgrade 遇到同类情况仍整条拒绝；只有 `upgrade --all` 使用 per-target skipped。
- `trackingIntegrityError` 只用于 AW tracking 已声称当前 target 受管，但 identity 不完整或损坏，导致不能安全刷新、prune、historical cleanup 或 rollback baseline，例如 `kind: "skill"` / `"mcpServer"` 缺少必要 `artifactKey`、tracking entry 格式损坏、scope identity 无法和当前 repo root 可靠绑定。它不同于 `scopeNotInitialized`：前者是“有受管证据但身份坏了”，后者是“历史候选没有当前 scope 受管证据”。
- `installOptionsUnavailable` 只用于 `skillTriggerApplicability === "overridable"` 且 ledger 无法恢复偏好的 target；`none` / `fixed` target 不能使用这个 skip code，也不能因此被跳过。
- `catalogNotCurrent` 只用于 current catalog 已经解析成功、但 historical fallback 发现的已安装插件已不在 current catalog 里时。catalog 整体不可加载属于 target 外 fatal error，不产生 `skipped[]`。
- `catalogNotProjectInstallable` 只用于 current catalog 已经解析成功、且能找到该插件，但该版本不能作为 Codex project target 刷新时；例如 manifest 新增 `apps`，或 current catalog 不再包含任何 project managed kind。不要复用 `catalogNotCurrent`。
- `projectConfigUnreadable` 只用于 current catalog target 可 project 安装、且本次刷新必须读取或改写 project `.codex/config.toml`，但该 TOML 无法解析的 target。skills-only target 不触达 project config layer，不能使用这个 code；若 current catalog 已缺失或已不再 project-installable，先使用对应 catalog code。
- `unmanagedRepoArtifactConflict` 用于写入前发现同名无 AW tracking 的 repo artifact 冲突，包括 `.codex/config.toml [mcp_servers.*]` orphan、无 tracking 的同名 `.agents/skills/<skill>`，或其它 project repo-managed surface 的 unmanaged 同名冲突。显式 upgrade 遇到同类冲突仍 deterministic refusal；只有 `upgrade --all` 把它放入 per-target `skipped[]`。
- `plugins[]` 只列实际升级成功的插件；被 skipped 的 target 只出现在 `skipped[]`。
- CLI `mergeCommandResults()` 和 `writeCommandReceipt()` 要透传并渲染 `skipped[]`。当 mixed 命令有成功也有 skipped 时，receipt 先写成功摘要，再列跳过摘要；当全部 target 都 skipped 时，不能输出“已升级 无”，要输出“未升级任何插件，已跳过 ...”并给出原因摘要。
- CLI entry 退出码是合同的一部分：部分 target 成功、部分 target skipped 时固定退出 `0`；没有任何 target 成功、全部 target skipped 时固定退出 `1`。target 外 fatal error 继续按现有错误通道非零退出。
- 首版不新增写命令 `--json`；测试锁 direct command 返回值里的 `skipped[]`、CLI human receipt 和 CLI entry 退出码。warning 文案可以作为辅助断言，但不能作为 skipped target 的唯一可机读合同。
- `runUpgradeAll()` 不能在收集到第一个 blocking reason 后整命令 throw。对 target-scoped refusal 使用 `skipped[]`，继续处理其它不受影响 target；对 target 外 fatal error 才中止整命令。

### 4. 新增 Codex project repo-managed installer

现有 `installExtensions()` 只覆盖 extensions 产物。需要让 Codex project scope 在同一条 repo-managed 链路里处理 skills 和 MCP。

建议拆出或扩展为：

- `installCodexProjectManagedArtifacts(plugin, options)`
- `uninstallCodexProjectManagedArtifacts(plugin, options)`
- `collectCodexProjectManagedArtifacts(plugin, options)`

#### Skills

输入：

- pristine bundle 中的 `plugins/<plugin>/codex/skills/<skill>`
- 当前命令解析出的 skill trigger preference
- source manifest 的 `skillTriggers` / `allowInstallOverride`

写入：

- `.agents/skills/<skill>/...`

规则：

- 保留 skill 原目录名。
- 每个写入的 skill 都要进入 project tracking manifest，artifact 形态为 `kind: "skill"`、`path: "<absolute repo root>/.agents/skills/<skill>"`、`artifactKey: "<skill>"`。
- 目标目录不存在：复制完整 skill 目录。
- 目标目录由当前插件的 AW tracking 管理：允许替换为当前版本。
- 目标目录由其它 AW 插件 tracking 管理：fail fast，提示同名 repo skill 已被另一个插件占用。
- 目标目录存在但不是 AW 管理：fail fast，提示同名 repo skill 已存在。
- 显式 `--skill-trigger manual|auto|default` 在复制后的 repo skill 上物化。
- 未指定 trigger preference 时，沿用现有 install / upgrade 的偏好解析规则，但 project scope 的 runtime 目标是 repo `.agents/skills`。
- project scope 不修改 `~/.aw/plugins/<plugin>/codex/skills`，也不参与共享 marketplace sibling preference 选举。

#### Slash commands 生成的 Codex skills

公共 `slashCommands` 在 Codex 侧先在 build 阶段生成为普通 skill，再复用上面的 repo skill materializer。

额外规则：

- 生成 skill 的目录名必须等于公共 command 名，保持 Claude `/name` 与 Codex `$name` 的可预测映射。
- 生成 skill 的 `SKILL.md` / `agents/openai.yaml` 必须表达 manual-only 语义：Codex `policy.allow_implicit_invocation: false`；Claude 原生命令侧也不得把同一公共命令配置成模型自动调用。
- `--skill-trigger` 只作用于显式 `skills` 中允许 override 的 skill；不得把公共 slash command 生成的 Codex skill 改成 auto。
- tracking、status、uninstall、upgrade prune 和 rollback 都把这类产物当作 `kind: "skill"`，`artifactKey` 使用 command 名。实现不能因为源码来源是 `slashCommands` 就新增一套清理逻辑。
- status human 输出可以把来源标成 slash command equivalent，但 JSON 的稳定身份仍是 `kind: "skill"` + `artifactKey`，避免与现有 repo skill cleanup 分叉。

#### Skill trigger policy inventory

公共 `slashCommands` 会形成天然的非对称 bundle：Claude 侧是 `commands/<name>.md`，Codex 侧是 `skills/<name>/...`。现有 `resolveSkillTriggerPolicies()` 不能继续把 `codex/skills` 和 `claude/skills` 的目录名做并集，再让两个平台都读取同一组 skill。

需要把 skill trigger policy inventory 改成 platform-scoped：

- `resolveSkillTriggerPolicies()` 或等价 helper 接受目标 `platform`，只枚举该平台真实存在的 `skills/` artifact。
- Codex status / install / upgrade / materialize 只读取 Codex skill metadata；Claude status / install / upgrade / materialize 只读取 Claude skill metadata。
- 公共 `slashCommands` 生成的 Codex skill 只参与 Codex skill-trigger 适用性和 runtime drift 计算，不进入 Claude skill-trigger 解析路径。
- 同一插件若同时包含 Claude 显式 skill 和公共 `slashCommands`，Claude 侧只读取 `claude/skills/*`，Codex 侧只读取 `codex/skills/*`；任一平台都不能因为另一平台的非对称 artifact 缺失而产生 `unknown` / drift。
- manifest `skillTriggers` 仍只能声明显式 source skill 的 override 权限；公共 `slashCommands` 生成 skill 固定归为 `fixed`，不接受 install override。

#### MCP

输入：

- plugin manifest 的 `mcpServers` 路径。
- Codex plugin loader 支持的 `.mcp.json` 结构，需要兼容当前 bundle 生成形态。

写入：

- `.codex/config.toml [mcp_servers.<server>]`。这里的 `<server>` 是 rendered `.mcp.json` 中 `mcpServers` 的原始 key；如果 key 需要 TOML quoted key，必须写成单个 quoted 子表，例如 `[mcp_servers."acme.tools v1"]`，不能拆成 `[mcp_servers.acme.tools]`。

规则：

- 复用或扩展 `packages/cli/src/utils/codex-config.ts`，保持 TOML round-trip，不重排无关配置。
- rendered `.mcp.json` 的 `mcpServers` 必须是 object；每个 `mcpServers.<server>` 必须是 object。server object 内所有 TOML 可表达 JSON 值都要完整转写：string、boolean、number、array、object。遇到 `null`、非 object server config 或无法稳定转成 TOML 的值时，必须在写入前 fail fast，且不产生半写入状态。
- server key 身份按 JSON 原始字符串保存和比较，不做 path segment 拆分。TOML 读写必须经过能区分 bare key path 与 quoted key 的结构化 parser / serializer；status、orphan 检测、同名冲突、upgrade replace、uninstall delete 和 drift comparator 都以解析后的同一个 key identity 为准。
- JSON object 要转成对应的 TOML table / nested table；array 要保留顺序并递归转写元素；number 要保留数值语义。实现可以对 AW 管理的 server 子树做确定性排序和格式化，但不能修改同一 `.codex/config.toml` 中非当前 server 的用户配置、注释或其它插件管理的 server。
- 刷新同名 server 时，必须把旧 `[mcp_servers.<server>]` 及所有 `[mcp_servers.<server>.*]` 后代子表视为一个受管子树整体替换，避免新版删除 `tools.*`、`env`、`http_headers`、timeout 等字段后旧子表残留。
- 删除 server 时，同样删除 `[mcp_servers.<server>]` 及所有后代子表；`[mcp_servers.<sibling>]`、`[mcp_servers.<sibling>.*]` 和外部配置必须保留。
- 每个写入的 server 都要进入 project tracking manifest，artifact 形态为 `kind: "mcpServer"`、`path: "<absolute repo root>/.codex/config.toml"`、`artifactKey: "<serverKey>"`。
- 若同名 server 已由 AW 当前插件管理：允许替换。
- 若同名 server 已由 AW 其它插件管理：fail fast，避免两个插件争同一 runtime key。
- 若同名 server 已存在但没有 AW tracking：fail fast，不覆盖用户或其它工具配置。
- uninstall 只删除当前插件 tracking 到的 server；其它 server 保留。
- 如果 `.codex/config.toml` 因语法错误无法解析：所有需要读取或改写该文件的 install / status / uninstall / explicit upgrade / `upgrade --all` 都 fail fast，提示用户修复项目配置。写入型命令必须在任何 repo artifact、tracking manifest、installed ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前完成这项预检；不触达该文件的 skills-only 路径不做这项预检。

#### Project config-backed artifacts

MCP servers 和 managed `developer_instructions` 都落在同一份 `.codex/config.toml`。实现不能让两个 helper 各自 read-modify-write 同一个文件；同一插件同时声明 MCP 和 instructions，或 upgrade / uninstall 同时需要刷新一种、prune 另一种时，必须走同一个文档级事务：

- 命令开始写入前读取一次 `.codex/config.toml` baseline；文件不存在时 baseline 是“不存在”。
- 先完成所有 config-backed validation：TOML 可解析、MCP server JSON 可转 TOML、同名 unmanaged server 冲突、managed instruction block 身份、stale prune identity 和 tracking `artifactKey` 完整性。
- 在内存中的同一份 TOML 文档上合并所有变更：upsert / remove 当前插件的 managed `developer_instructions` block，replace / delete 当前插件 tracking 到的 `[mcp_servers.<server>]` 整棵子树，并保留其它插件和用户手写配置。
- 只有所有 repo artifact validation 都通过后，才把合并后的 `.codex/config.toml` 写回一次。后续写 tracking 或 ledger 失败时，回滚必须恢复 baseline 文件的精确内容或恢复到“不存在”。
- install、explicit upgrade、`upgrade --all` prune、uninstall 和 stale cleanup 都必须复用这条事务边界；不能出现先写 instruction 后写 MCP 失败，或先删 MCP 后 instruction 回滚不完整的半状态。

#### Extensions

现有以下产物继续按原 repo-managed 逻辑处理，但要纳入新的 managed kinds：

- instructions
- permissions / `.codex/rules/*.rules`
- hooks / `.codex/hooks.json`
- agents / `.codex/agents/*.toml`

如果当前实现里 `extensions.instructions` 仍有旧落点，需要在实施时确认它不会回写用户级 native 状态；若要改成 repo skill，应单独拆任务，不混在本次 project native 隔离里。

### 5. 调整 skill trigger preference 物化边界

当前 `packages/cli/src/utils/skill-trigger-preferences.ts` 面向共享 `~/.aw` runtime，并默认每个 target 都有可恢复的 `skillTriggerPreference`。需要同时增加 Codex project scope 的目标类型和适用性模型。

建议引入适用性抽象：

```ts
type SkillTriggerApplicability = 'none' | 'fixed' | 'overridable';

type ResolvedInstallOptions =
  | { skillTriggerApplicability: 'none'; skillTriggerSource: 'notApplicable'; ledgerTrust: ResolvedInstallOptionsLedgerTrust }
  | { skillTriggerApplicability: 'fixed'; skillTriggerSource: 'fixed'; ledgerTrust: ResolvedInstallOptionsLedgerTrust }
  | {
      skillTriggerApplicability: 'overridable';
      skillTriggerPreference: SkillTriggerPreference;
      skillTriggerSource: 'cli' | 'ledger' | 'default';
      ledgerTrust: ResolvedInstallOptionsLedgerTrust;
    };
```

`ResolvedInstallOptions` 不再是强制携带 `skillTriggerPreference` 的单一形态；调用方必须先看 `skillTriggerApplicability`，不能为 `none` / `fixed` 伪造 `default`。

建议引入目标抽象：

```ts
type SkillTriggerMaterializationTarget =
  | { platform: 'codex'; scope: 'user'; kind: 'localMarketplaceRuntime'; root: string }
  | { platform: 'codex'; scope: 'project'; kind: 'repoSkill'; root: string }
  | { platform: 'claude'; scope: Scope; kind: 'localMarketplaceRuntime'; root: string };
```

Codex project scope 行为：

- 从 embedded / pristine bundle 读取默认 skill。
- 先复制到 `.agents/skills/<skill>`。
- 再 patch `.agents/skills/<skill>/agents/openai.yaml`。
- 只改当前 repo，不读写共享 `~/.aw`。
- status drift 对比也用 repo skill 文件和 pristine bundle 比较。
- 即使 project-only status 的 current catalog 来自 embedded fallback，repo skill 也要继续和 embedded pristine bundle 比较，给出确定的 `visible` / `drifted` / `missing`，不能因为没有本地 `~/.aw` runtime 或 `currentCatalog.source !== 'local'` 退回 `unknown`。
- `install`、显式 `upgrade` 和 `upgrade --all` 为 Codex project scope 解析偏好时，先计算 target 的 `skillTriggerApplicability`；只有 `overridable` target 读取当前 scope 的 ledger scope record 和本次 CLI 输入。tracking 只用于确认 artifact 归属与 identity，不能作为偏好来源，也不能调用共享 runtime sibling winner 选举。
- `overridable` 的 skill trigger preference 来源优先级固定为：本次 CLI 显式 `--skill-trigger` 优先，其次是当前 project scope 的可用 ledger scope record；tracking artifact 只证明文件归属，不是偏好来源。ledger scope record 缺失、degraded 或不能恢复 install options 时，偏好状态是 `unknown`，不能回落到 `default`。
- `none` target 没有 skill trigger runtime，例如 `mcp-only` / extensions-only；status 和 ledger 不能写出伪造的 `skillTriggerPreference: "default"`。
- `fixed` target 有 skill artifact 但 runtime 固定，例如公共 `slashCommands` 生成的 manual-only skill，或所有有效 skill 都 `allowInstallOverride = false`。它不需要 ledger 偏好来源，`--skill-trigger` 不得改变 runtime；status 若保留旧 skill-trigger 字段，必须通过 `skillTriggerApplicability = "fixed"` 明确这些字段描述的是固定 runtime drift，不是用户可切换偏好。
- Codex project scope 不参与 `collectSkillTriggerSiblingConflictWarnings()` 这类共享 runtime conflict warning；repo A 和 repo B 的 project skill 偏好彼此独立。

Codex user scope 和 Claude 维持现有共享 marketplace runtime 模型。

#### `aw init` / local marketplace rebuild / uninstall 重选

现有 `selectEffectiveSkillTriggerRecord()` 会把 `platformRecord.projectScopes` 一并纳入共享 winner 候选；`initializeLocalMarketplace()` 又会把这个 winner replay 到 `~/.aw`。新语义下必须拆清楚：

- 用于共享 marketplace runtime 的 winner 选举不能包含 `platform=codex && scope=project` 的 scope record。
- `replaySkillTriggerPreferencesFromLedger()` 在 `initializeLocalMarketplace()` / `aw init` / stale rebuild 中，只能重放 Codex user scope 和 Claude 现有共享 runtime 记录；Codex project scope 的偏好只能由对应 repo 的 `.agents/skills` 表达，`aw init` 没有 repo 上下文，不能 replay。
- `rematerializeSkillTriggerPreferenceAfterUninstall()` 对 Codex project scope 必须跳过共享 runtime 重选；卸载 project scope 只删除 repo-managed skill/MCP/extensions 和 ledger/tracking，不修改共享 `~/.aw` runtime。
- Codex user scope 卸载后的共享 runtime 重选也不能让剩余 Codex project record 成为 winner；如果没有 Codex user winner，应恢复 Codex embedded pristine runtime。
- status 的 Codex project skill drift 只比较 repo `.agents/skills` 与 pristine bundle；共享 `~/.aw` runtime 不作为 project scope 真值。

对应测试要覆盖：

- `aw init --force` 面对只含 Codex project scope 的 ledger，不会把 project trigger replay 到 `~/.aw`。
- stale / bundle refresh rebuild 面对 Codex user + Codex project 冲突偏好时，只按 Codex user 记录物化共享 runtime，不因 project record 改变 `~/.aw`。
- 卸载 Codex project scope 不调用共享 runtime rematerialize，不改变已有 `~/.aw/plugins/<plugin>/codex/skills`。
- 卸载 Codex user scope 后，即使 ledger 里还剩 Codex project scope，也不会把 project 偏好选为共享 runtime winner。

### 6. 调整 ledger 和 tracking

#### Ledger

停止为 Codex project scope 写入 `sharedNativeRefs.projects`。

建议：

- user scope：
  - 继续使用 `sharedNativeRefs.user` 表达用户级 native plugin 引用。
  - `skills`、公共 `slashCommands` 生成的 Codex skill、`mcpServers`、`apps` 都属于 user native runtime 能力；`slashCommands-only` 插件安装到 Codex user scope 时也必须写入 capability snapshot 和 `sharedNativeRefs.user`，供 status / discovery / upgrade / uninstall 在 current catalog 缺失时恢复 native managed evidence。
- project scope：
  - 只记录 project managed target、managed kinds、安装选项和 project key。
  - 不记录 native ref。
  - 对 `overridable` target，ledger scope record 是 project upgrade 隐式恢复 skill trigger preference 的唯一持久化来源；tracking manifest 不保存、也不补推偏好。若 tracking 和 ledger 不一致，upgrade 执行路径必须把偏好视为 unknown，并按 tracking-only upgrade 拒绝合同处理。
  - 对 `none` / `fixed` target，ledger 可以记录 managed kinds 和 install history，但不能要求 install options 存在，也不能为了兼容旧形态写入伪造 `skillTriggerPreference: "default"`。

因为旧 Codex project scope 尚未上线，不需要写迁移器。实现可以保留旧字段读取的容错，但新写入不再生成旧 project native ref。

#### Tracking manifest

需要让 `.codex/.agent-workflows-manifest.json` 能追踪新增 artifact，并能表示同一个物理文件里的多个受管子项：

```ts
export interface GeneratedArtifact {
  path: string;
  kind: 'instruction' | 'permission' | 'hook' | 'agent' | 'skill' | 'mcpServer';
  platform: PlatformName;
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
}
```

字段约定：

- `path` 是持久化合同字段，必须写绝对文件系统路径。skill 使用 `path.join(resolveRepoRootSync(cwd), '.agents/skills/<skill>')` 等价结果；MCP 使用 `resolveCodexPaths(cwd, 'project').configTomlPath`。不要把 repo-root-relative 路径写入 tracking manifest。
- 现有 tracking 记录里的绝对路径继续视为规范格式；实现不需要引入“相对路径和绝对路径混读”的新语义分叉。
- status、uninstall、upgrade prune、rollback 和 artifact merge 都应直接使用这个绝对 `path` 做文件系统操作或 identity 计算。若 human 输出需要更短路径，可以另行格式化展示，但不能改变 tracking / JSON 合同。
- `kind: "skill"` 记录 `.agents/skills/<skill>`，`artifactKey` 使用 skill 目录名。
- 公共 `slashCommands` 在 Codex 侧生成的 manual-only skill 也记录为 `kind: "skill"`，`artifactKey` 使用 command 名；tracking 不新增 `slashCommand` kind。
- `kind: "mcpServer"` 记录 `.codex/config.toml`，`artifactKey` 使用 rendered `.mcp.json` 中的原始 MCP server key。需要 TOML quoted key 的名字仍原样写入 `artifactKey`，例如 `acme.tools v1`；所有 status / uninstall / upgrade / drift 操作都通过 TOML parser 定位该 quoted key 对应的单个 server。
- 现有 hook / rule / agent 等 kind 保持兼容；没有子项身份的 artifact 可以不写 `artifactKey`。
- `mergeGeneratedArtifacts()`、tracking 读写、generated artifact filter 和 rollback evidence 的 identity key 必须包含 `artifactKey`。同一插件写入多个 MCP server 时，即使 `path` 和 `kind` 相同，也不能被合并成一个 artifact。
- `GeneratedArtifactStatus` 对 `mcpServer` 不能只检查 `path` 是否存在；必须解析 `.codex/config.toml` 并判断 `artifactKey` 对应的 `[mcp_servers.<server>]` 是否还在。
- `kind: "skill"` 或 `kind: "mcpServer"` 缺少必要 `artifactKey` 时，属于 tracking integrity error。`status` 可以把对应 item 报为 `unknown` 并暴露诊断，但 uninstall、显式 upgrade、historical cleanup、upgrade stale prune 和 rollback baseline 计算都必须 deterministic refusal，不能退回到 `path + kind` 清理或把损坏 tracking 降级成 unmanaged 后继续删除。

status 的公开 artifact schema 也要同步带上同一个身份字段，不能只把它留在 tracking 内部：

```ts
export interface GeneratedArtifactStatus {
  path: string;
  exists: boolean;
  kind: GeneratedArtifact['kind'];
  artifactKey?: string;
}
```

约束：

- 从 tracking 生成 `GeneratedArtifactStatus` 时原样传递 `artifactKey`。
- `GeneratedArtifactStatus.path` 原样输出 tracking 中的绝对 `path`；`repoManagedSessionState.items[].path` 也使用同一合同，避免 status JSON 和 tracking manifest 对同一 artifact 出现不同格式。
- `kind: "skill"` 和 `kind: "mcpServer"` 的 `GeneratedArtifactStatus` 必须带 `artifactKey`；缺失时视为 tracking 诊断问题，不能退回到只用 `path + kind` 判断。
- `kind: "mcpServer"` 的 `exists` 表示对应 `[mcp_servers.<artifactKey>]` 是否存在，不表示 `.codex/config.toml` 文件是否存在。若 `artifactKey` 需要 quoted key，判断时必须匹配 quoted key 的解析身份，而不是按点号拆分路径。
- `status --json` 中同一插件的多个 MCP server 必须表现为多条可区分记录，例如 `foo` 为 `exists: false`、`bar` 为 `exists: true`，两条记录都带相同 `path` 但不同 `artifactKey`。

tracking 需要满足：

- uninstall 能按 tracking 精确删除当前插件拥有的 skill 目录和 MCP server。
- status / discovery 能从 tracking 恢复 project managed kinds。
- install / upgrade 写入 skill 或 MCP 前，必须扫描 tracking manifest 中所有插件记录，区分“当前插件已管理”“其它 AW 插件已管理”和“未受管/外部存在”。
- 如果 tracking 缺失但文件存在，不把文件当作 AW 管理；status 可以把它作为 `tracked: false` 的 orphan / unmanaged evidence 暴露，但 discovery、interactive uninstall / upgrade 和 historical fallback 不能据此推断 AW 管理关系。

### 7. 调整 discovery / status

`aw status` 和交互式 uninstall / upgrade 的发现逻辑要跟新语义一致：

- Codex project scope 的 installed evidence 来自 repo-managed artifacts，而不是 user native plugin state。
- user `~/.codex/config.toml [plugins]` 不能让某个 project scope 显示为 installed。
- user `~/.codex/config.toml [plugins]` 中启用的同名外部 marketplace 插件只作为 `externalOwnership` 冲突诊断，以及 install / explicit upgrade 的拒绝依据；不得计入 project installed evidence，也不得让 interactive uninstall / upgrade 把 project scope 误判为已安装。uninstall 只看当前 project scope 的 repo-managed evidence，不能因为外部同名 native 插件存在而拒绝清理 AW 自己管理的 repo artifact。
- user `~/.codex/config.toml` 无法解析时，Codex project scope status / discovery 不能因此跳过 repo tracking、ledger 和 artifact 扫描。status 要继续报告 repo-managed item 真值，同时把 `externalOwnership` 检查标为 `unknown`；需要 trust-gated artifact 时，`projectTrust` 为 `unknown` 并按 `projectTrustUnknown` 影响对应 item。skills-only 的 item / kind summary 仍由 repo skill 真值决定，但 cell health 至少为 `unknown`，因为无法排除 user-native 同名冲突。
- Codex project scope status 只有在当前插件或 historical tracking 需要读取 `.codex/config.toml` 时，才因该文件解析失败而整命令失败并输出明确修复提示；不把受影响 MCP / managed instruction item 降级成 `unknown`。skills-only status 不触达 project config layer，不因无关 TOML 损坏失败。
- project scope 下展示：
  - `.agents/skills` 是否存在、是否 tracking 管理、trigger runtime / drift。
  - `.codex/config.toml` 中 AW 管理的 MCP server 是否存在。
  - hooks / rules / agents 等现有 artifacts。
  - project trust 状态：`.codex/config.toml`、hooks、rules、agents 可能受 trust gating；status 需要继续提示 `blockedByProjectTrust` 或等价诊断。
- config/script health 是 status matrix cell 的只读派生信息。Codex project scope 有安装快照时，必须用 ledger scope record 中的 `lifecycleConfigSnapshot` 读取旧版本的 `scripts` / `config` 真值；没有快照时再按 current catalog / historical fallback 降级并标出 `healthSource`。status 不能因为展示 config/script health 而执行 lifecycle、创建 config 目录、刷新 local marketplace、写 install snapshot，或用 config store 反推插件已安装。
- 从 repo 子目录运行时，Codex project scope 仍锚定 repo root realpath，保持现有 `resolveCodexPaths(cwd, 'project')` 语义。
- `PluginStatusReport.projectManagedKinds?: GeneratedArtifact['kind'][]` 作为摘要字段，用于表达当前 project scope 已知的 repo-managed kind；它不能替代逐项状态。
- `generatedArtifacts[]` 和 `repoManagedSessionState.items[]` 是 `--json` 的逐项状态合同；新增字段必须保持旧字段兼容读取。

#### Status 输出合同

`ExternalOwnershipStatus` 需要能区分“已确认不存在外部同名插件”和“因为 user config 不可读而无法判断”。保持现有 `present: boolean` 兼容字段，但新增稳定诊断字段，例如：

```ts
export interface ExternalOwnershipStatus {
  present: boolean;
  checkState: 'known' | 'unknown';
  marketplace?: string;
  owner?: string;
  details?: string;
}
```

正常读取 user config 时 `checkState = "known"`；user config 语法损坏时，Codex project scope status 使用 `present = false`、`checkState = "unknown"`，并在 `details` / `driftWarnings` / verbose JSON 中说明无法完成 external ownership 检查。写入型命令不能把这个状态当作安全通过。

Codex project scope 的 `repoManagedSessionState` 要从旧的四类 extension 摘要扩展为可机读的 per-kind / per-item 模型。旧字段继续保留，供已有调用方读取；新增字段承载 skill / MCP / instructions / hooks / rules / agents 的稳定状态与 drift 诊断。

```ts
export type RepoManagedProjectItemState =
  | 'visible'
  | 'missing'
  | 'drifted'
  | 'orphan'
  | 'blockedByProjectTrust'
  | 'projectTrustUnknown'
  | 'absent'
  | 'unknown';

export interface RepoManagedKindStateSummary {
  state: RepoManagedProjectItemState | 'mixed' | 'not_applicable';
  managed: number;
  visible: number;
  missing: number;
  drifted: number;
  orphan: number;
  blocked: number;
  unknown: number;
  absent: number;
}

export interface RepoManagedSessionItem {
  kind: GeneratedArtifact['kind'];
  path: string;
  artifactKey?: string;
  tracked: boolean;
  exists: boolean;
  state: RepoManagedProjectItemState;
  drift?: 'yes' | 'no' | 'unknown';
  diagnostics?: string[];
}

export interface RepoManagedSessionStateReport {
  instructions: InstructionsSessionState;
  rules: RepoManagedSessionVisibility;
  hooks: RepoManagedSessionVisibility;
  agents: RepoManagedSessionVisibility;
  skills: RepoManagedKindStateSummary;
  mcpServers: RepoManagedKindStateSummary;
  items: RepoManagedSessionItem[];
  diagnostics: string[];
}
```

`not_applicable` 只用于 `RepoManagedKindStateSummary.state`，不用于 `RepoManagedSessionItem.state`。当某个 kind 未声明、未被 historical tracking 证明、也没有 orphan evidence 时，summary 为 `state: "not_applicable"`，`managed / visible / missing / drifted / orphan / blocked / unknown / absent` 全部为 `0`。summary 层的 `absent` 表示“已声明或有期望，但当前 scope 没有对应受管项”，不能和“插件根本没有声明该 kind”混用。

全产物 drift 判定基线：

- 所有 `tracked: true` item 都先用 tracking 中的 `kind + path + artifactKey + hookGroups` 建立身份，再和当前 catalog / embedded fallback 生成的期望产物比较。只有当前 catalog 与 embedded pristine 都无法提供可比较基线时，才把 `drift` 置为 `unknown`。
- `skill` 的 drift 真值来自 repo `.agents/skills/<skill>` 与 pristine skill bundle 的 trigger runtime 签名比较；plugin 级 `skillTrigger*` 聚合继续使用下文规则。
- `mcpServer` 的 drift 真值来自 `.codex/config.toml [mcp_servers.<artifactKey>]` 子树。实现需要把当前 TOML 子树转换成规范 JSON 值，再和 rendered `.mcp.json` 中 `mcpServers.<artifactKey>` 经过同一 TOML 可表达性转换后的规范值做深比较；任意 key / nested table / array / scalar 差异都算 `drifted`。`.codex/config.toml` 无法解析时，命令按“损坏的 project config”规则 fail fast，不把 MCP item 降级成 `unknown`。
- `instruction` 的 drift 真值来自 `.codex/config.toml developer_instructions` 中当前插件的 AW managed block。block 缺失为 `missing`，block 存在但内容不等于 `renderCodexManagedInstructionBlock()` 的输出为 `drifted`；无关插件 block 和用户手写 developer instructions 不参与当前 item 比较。
- `permission` / rules 的 drift 真值来自 tracking 指向的 `.codex/rules/*.rules` 文件内容和 `generateCodexPermissionArtifacts()` 生成内容的字节级比较；文件缺失为 `missing`，存在但内容不同为 `drifted`。
- `hook` 的 drift 真值来自 `.codex/hooks.json` 中 tracking `hookGroups` 对应的 handler group。实现要用现有 hooks parser 规范化当前 JSON，再和 `renderCodexHooks()` / `extractCodexHookGroups()` 生成的期望 group 比较；group 缺失为 `missing`，matcher / command / handler 结构不同为 `drifted`，文件不可解析时相关 item 为 `unknown` 并带诊断。
- `agent` 的 drift 真值来自 tracking 指向的 `.codex/agents/*.toml` 文件内容和 `generateAgentArtifacts(..., 'codex')` 生成内容的字节级比较；文件缺失为 `missing`，存在但内容不同为 `drifted`。
- 状态优先级按内容/归属事实先行：`missing`、`drifted`、`orphan` 优先于 trust gating；只有 item 存在、受 AW tracking 管理且内容等于期望产物时，才根据 project trust 报 `visible` / `blockedByProjectTrust` / `projectTrustUnknown`。若内容 drifted 且 repo 未 trusted，item state 仍为 `drifted`，diagnostics 可以同时提示 trust 影响运行时加载。

旧的 plugin 级 skill trigger 字段继续作为稳定 JSON 合同保留，但必须先输出稳定的 `skillTriggerApplicability: "none" | "fixed" | "overridable"`，避免把不适用场景伪装成 `default` 偏好：

- `none`：目标没有 skill trigger 面，例如 `mcp-only`。`installOptions`、`skillTriggerPreference`、`skillTriggerRuntimeState`、`skillTriggerRuntimeMatches`、`skillTriggerDrift` 不输出；JSON 通过 `skillTriggerApplicability = "none"` 明确这是不适用，不是缺失诊断。
- `fixed`：目标有 skill artifact 但 runtime 固定，例如公共 `slashCommands` 生成的 manual-only skill，或所有有效 skill 都不允许 install override。`installOptions` / `skillTriggerPreference` 不要求 ledger 来源；`skillTriggerRuntimeState` 和 `skillTriggerDrift` 可按固定 pristine skill 集合计算，但 human / JSON 必须说明这是固定 runtime drift，不是用户可切换偏好，`skillTriggerRuntimeMatches` 不表达可选偏好集合。
- `overridable`：沿用旧字段语义。`PluginStatusReport.skillTriggerPreference` 表示当前 `platform / scope / projectKey` ledger 或本次解析出的期望偏好。
- `overridable` 的 `skillTriggerRuntimeState`、`skillTriggerRuntimeMatches`、`skillTriggerDrift` 在 Codex project scope 下按整个插件的 repo skill 集合聚合，真值来自 repo `.agents/skills/<skill>`，不能读取或比较共享 `~/.aw/plugins/<plugin>/codex/skills`。
- `overridable` 候选签名按 `default`、`manual`、`auto` 三种偏好分别从 embedded / pristine bundle 生成，且必须逐个 skill 应用 manifest 的 `skillTriggers.<skill>.allowInstallOverride`。如果某个 skill 不允许 install override，则三种候选里该 skill 都保持 pristine 语义。
- `overridable` runtime 签名按同一 policy skill 集合读取 repo `.agents/skills/<skill>/agents/openai.yaml`。同一插件下所有 tracked skill 都存在，且整个 runtime 签名等于一个或多个候选签名时，`skillTriggerRuntimeState = "matched"`，`skillTriggerRuntimeMatches` 按 `default` / `manual` / `auto` 顺序列出全部匹配偏好；期望偏好在 matches 中则 `skillTriggerDrift = "no"`，否则为 `"yes"`。
- runtime evidence 能被确定为不匹配任何完整候选签名时，`skillTriggerRuntimeState = "mixed"`、`skillTriggerRuntimeMatches = []`、`skillTriggerDrift = "yes"`。这包括“一个 tracked skill 可见、另一个 drifted”、“一个 tracked skill 可见、另一个 missing”、以及手工编辑后不同 skill 分别像不同偏好的 mixed 状态。
- 只有在无法可靠建立候选或 runtime 签名时才返回 `unknown`，例如 embedded / pristine policy 不可读、repo `openai.yaml` 语法损坏、必要 `artifactKey` 缺失导致 skill 身份不可判定、`overridable` target 的 ledger degraded 导致期望偏好不可判定。此时 per-item `repoManagedSessionState.items[]` 仍要尽量报告已知的 `visible` / `missing` / `drifted` / `orphan` 事实。
- project-only status 使用 embedded fallback catalog 时，只要 embedded pristine bundle 可读，就必须继续计算适用 target 的上述字段；不能因为 `currentCatalog.source !== "local"` 或共享 `~/.aw` 缺失而把 `skillTriggerRuntimeState` / `skillTriggerDrift` 降成 `unknown`。
- orphan skill 不参与当前插件的 plugin 级 `skillTrigger*` 聚合；它只作为 `repoManagedSessionState.items[]` 中 `tracked: false` 的 unmanaged evidence 和 health 诊断出现。
- default human、verbose human 和 JSON 必须使用同一套聚合结果。human 输出可以摘要成 `skillTriggerApplicability=fixed`、`skillTriggerRuntime=mixed` / `skillTriggerDrift=yes`，JSON 必须保留 `skillTriggerApplicability` 和适用的 runtime 字段，不能依赖文案表达 mixed 细节。

状态语义：

- `tracked: true` 的 skill 目录存在且 trigger runtime 与当前 scope ledger 期望一致时，item 为 `visible`；目录缺失为 `missing`；目录存在但 trigger 语义不一致为 `drifted`。
- `.agents/skills/<skill>` 存在但 tracking 缺失时，item 为 `orphan`，只能作为 unmanaged evidence 展示，不能让 discovery / uninstall 把该插件当成已受管安装。
- `tracked: true` 的 MCP server 在 `.codex/config.toml` 中存在、内容等于当前期望子树且 repo trusted 时，item 为 `visible`；server 条目缺失为 `missing`；server 存在但内容与期望子树不同为 `drifted`；内容匹配但 repo untrusted 时为 `blockedByProjectTrust`；内容匹配但 trust 无法判断时为 `projectTrustUnknown`。
- `.codex/config.toml` 中存在当前插件 manifest 声明的 `[mcp_servers.<server>]`，但 tracking manifest 没有当前插件对应的 `kind: "mcpServer"` / `artifactKey: "<server>"` 记录时，status 要把它作为 `kind: "mcpServer"`、`tracked: false`、`exists: true`、`state: "orphan"` 的 unmanaged item 暴露，`path` 使用 repo `.codex/config.toml` 的绝对路径，`artifactKey` 使用 server key。这个 orphan item 不进入 `generatedArtifacts[]`，因为 `generatedArtifacts[]` 仍只表示 AW tracking 证明拥有的产物。
- MCP orphan 不能计入 `projectManagedKinds`、`scopeManagedEvidence` 或 installed evidence，不能让 interactive uninstall / upgrade 把该插件列为已受管候选，也不能被 historical fallback 当成可清理目标。
- tracking 中 `kind: "skill"` 或 `kind: "mcpServer"` 缺少 `artifactKey` 时，status 报 `unknown`，但 discovery / interactive uninstall / interactive upgrade 不能把这个损坏条目当成可清理 target；显式 uninstall / upgrade / historical cleanup 必须先拒绝并提示修复 tracking manifest，不能执行 path-only 删除。
- 存在 MCP orphan 时，status health 为 `needsAttention`，default human 输出和 next steps 要说明同名 MCP server 已存在但不归 AW 管理；install / explicit upgrade 遇到同名 MCP orphan 必须在写任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 前 deterministic refusal；uninstall 即使命中同名 orphan 也不得删除该 server。
- instructions / hooks / rules / agents 继续用现有摘要字段，同时也要进入 `items[]`；内容存在且等于期望产物时，再与 MCP 使用同一套 `blockedByProjectTrust` / `projectTrustUnknown` 状态；内容不同必须报 `drifted`，不能只停留在 presence / trust gating。
- project trust 只影响 MCP / instructions / hooks / rules / agents 这些 trust-gated artifact。若插件只有 skill，且所有 tracked skill item 都是 `visible` 且无 drift，`untrusted` / `projectTrustUnknown` 不能单独产生 warning、next step 或 health 降级。
- `items[].state = "unknown"` 时，`drift` 也应为 `"unknown"`，`diagnostics[]` 必须说明来源。默认 human 输出要点名具体 kind / `artifactKey` / path 处于 unknown，verbose human 输出保留解析失败或 tracking 身份问题细节，JSON 原样输出 `state`、`drift` 和 `diagnostics`；next steps 指向先修复不可判定来源再重跑 `aw status`。这个分支不能只落到旧的 `driftWarnings` 文案里，也不能和 `missing` / `drifted` 混报。
- default human 输出在 Codex project scope 下优先展示 repo-managed 摘要，例如 `skill commit visible`、`mcp foo missing`、`mcp bar visible`，不要把 user native marketplace 注册/缺失作为主诊断。
- 若同一插件在 project scope 已有 repo-managed evidence，同时 user native 层存在同名外部 marketplace 插件，default human 输出仍保留 repo-managed installed signal 和逐项摘要；外部同名冲突只追加为诊断、summary warning 和 next step，不替换主状态。
- verbose human 输出要展示 `artifactKey`、`tracked`、`state` 和 drift；JSON 输出要能直接断言这些字段，不能依赖数组顺序或文案字符串识别具体 MCP server。
- health 映射采用“可操作问题优先”：`missing`、`drifted`、`orphan`、`blockedByProjectTrust` 进入 `needsAttention`；project scope 已有 repo-managed evidence 且命中 `externalOwnership.present = true` 时也进入 `needsAttention`，不能沿用当前实现里的 `external` 短路；若没有这些可操作问题，`items[].state = "unknown"`、`projectTrustUnknown`、`externalOwnership.checkState = "unknown"` 或 ledger / catalog / runtime 签名无法判定时进入 `unknown`；`not_applicable` summary 不参与 health 降级；全部 managed item 可见、无 drift，且 external ownership / trust 等诊断都可判定时为 `ready`。

#### legacy `scopeInitialized` 兼容字段

`scopeInitialized` 仍会被 status 健康聚合、执行型命令的 `--platform auto` 推断和 upgrade preflight 消费，因此实现必须把旧字段从 repo-managed 新模型中确定性派生出来，不能让调用方各自解释。

Codex project scope 的旧字段派生规则固定为：

- `yes`：
  - 当前 `platform / scope / projectKey / plugin` 有可用 ledger scope record，且 `managed === true`。
  - 或当前 repo tracking manifest 中存在属于当前插件、当前 Codex project scope、identity 完整的 AW-managed artifact；`kind: "skill"` / `"mcpServer"` 必须带 `artifactKey`，共享文件子项必须能建立稳定身份。
- `no`：
  - ledger 可读且当前 scope record 不存在或 `managed !== true`，同时没有完整 AW tracking managed artifact。
  - 只有 orphan skill / MCP、用户手写同名文件、其它插件管理的同名 artifact、或 user-native external ownership 证据。
- `unknown`：
  - ledger degraded / 不可读，且没有完整 tracking managed artifact 能证明当前 scope 归属。
  - tracking manifest 不可读、repo root / project key 无法建立，或 tracking 记录损坏到无法确认 artifact 属于当前插件。

`scopeInitialized` 不表达健康度：tracking-only 但 ledger scope record 缺失时仍是 `yes`。只有 `skillTriggerApplicability === "overridable"` 的 target 才把 `skillTriggerPreference` / install options 视为 `unknown`，并让显式 upgrade / `upgrade --all` / 重复 install 按偏好恢复合同拒绝或 skip；`none` / `fixed` target 不需要偏好恢复。project trust unknown、external ownership check unknown、catalog embedded fallback、managed item missing / drifted 也不改写 `scopeInitialized`，只影响 `repoManagedSessionState`、health、warnings 和 next steps。

#### Historical fallback

current catalog 缺失时，status / interactive uninstall / upgrade 仍要能从 tracking 和 ledger 安全恢复“足够执行清理”的历史插件占位信息。新增 skill / MCP 后，不能只把 tracking kind 加到 manifest 类型里，还要同步改 discovery evidence、historical placeholder 和受控卸载路径。

要求：

- `GeneratedArtifact['kind']` 增加 `skill` / `mcpServer`；`isGeneratedArtifact()`、tracking 读写、artifact merge / filter 都要识别它们。
- `DiscoveryEvidenceSummary.trackingKinds` 和 `commands/common.ts` 的 historical kind 集合要能保存 skill / MCP evidence。
- historical placeholder 要能表达“这个 Codex project 插件拥有 repo skill / MCP server”，让 status 能展示受管证据，让 uninstall 能进入 repo-managed cleanup，而不是退化成 `Unknown plugin` 或 native-only placeholder。
- `requiresNativePlugin` / `platformNativeFallbackEvidence` 的粗粒度 fallback 只能代表 user native 遗留证据；其中 Codex user scope 的 `slashCommands-only` 插件也要凭 snapshot / `sharedNativeRefs.user` 恢复成 native placeholder。Codex project 的 skill / MCP tracking evidence 必须走 project repo-managed evidence，不得被误判为 user native fallback。
- `uninstallTargetsOnPlatforms()` 对 historical target 要能把 tracking 里的 skill / MCP artifacts 传给 repo-managed remover；current catalog 不存在时，也只能删除 tracking 证明属于当前插件的 `.agents/skills/<skill>` 和 `.codex/config.toml [mcp_servers.*]` 条目。
- historical target 中如果存在 `kind: "skill"` 或 `kind: "mcpServer"` 但缺少 `artifactKey` 的 tracking artifact，uninstall / cleanup 必须 deterministic refusal，并提示 tracking manifest 损坏；不能按 `path` 删除整个 skill 目录或共享 `.codex/config.toml` 子树。

### 8. 调整安装校验和交互式 UX

安装前 validation：

- Codex project scope 且 `manifest.apps` 存在：fail fast。
- Codex project scope 且没有任何 project managed kind：fail fast，提示该插件没有 Codex project 可安装内容。
- Codex project scope 且只有公共 `slashCommands`：允许安装，因为 Codex bundle 会把它们生成为 manual-only repo skills。
- Codex project scope 的公共 `slashCommands` 生成 skill 若与显式 skill、其它 AW 插件管理的 skill 或未受管 `.agents/skills/<name>` 冲突，按 repo skill 冲突规则 fail fast。
- Codex project scope 且 user `~/.codex/config.toml [plugins]` 已启用同名外部 marketplace 插件：fail fast。这个拒绝不表示 project scope 依赖 user native state，而是避免 repo skill / MCP 与 user-native 同名插件同时进入 Codex 运行时后产生歧义。
- Codex project scope 且 user `~/.codex/config.toml` 无法解析：fail fast。不能把 external ownership 检查失败当作无冲突，也不能先写 repo skill / MCP / tracking / ledger。
- Codex project scope 且本次安装需要写 MCP / managed `developer_instructions`，同时 project `.codex/config.toml` 语法损坏：fail fast；不得先复制 skill、写 MCP、写 tracking、写 ledger、写 AW config / install snapshot bookkeeping 或初始化共享 runtime。skills-only 安装不触达 project config layer，不因无关 TOML 损坏失败。
- Codex project scope skills-only：允许安装。
- Codex project scope slashCommands-only：允许安装。
- Codex project scope mcp-only：允许安装。
- Codex project scope skills + MCP + extensions：允许安装。

显式 upgrade 的 validation：

- 同样执行 `externalOwnership` 预检；若存在外部同名 user-native 插件，必须在 uninstall、artifact inventory 计算后的实际写入、stale prune、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前 fail fast。
- 若 user `~/.codex/config.toml` 无法解析，显式 upgrade 必须在 uninstall、artifact inventory 计算后的实际写入、stale prune、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前 fail fast。
- 若 repo tracking 证明当前 Codex project scope 已受管，先计算 target 的 `skillTriggerApplicability`。只有 `overridable` target 在 ledger scope record 缺失、degraded、未标记 managed，或无法恢复 install options 时，显式 upgrade 未传 `--skill-trigger` 才必须 fail fast；不能把 `resolveInstallOptionsForTargets()` 的结果静默回落到 `default`。传入显式 `--skill-trigger` 时，仍要先验证 tracking artifact 身份完整，成功后写回新的 ledger scope record。`none` / `fixed` target 不因缺失 install options 而 fail fast。
- 若当前 project `.codex/config.toml` 语法损坏，且本次 upgrade 需要读取或改写 config-backed artifact，必须在任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前 fail fast；不能先卸载旧 skill / MCP 再报错。skills-only upgrade 不触达 project config layer 时不做这项预检。
- `catalogCompatibility === 'capabilityChanged'` 时，必须先对当前 catalog 版本执行同一套 Codex project scope validation，再进入 uninstall / install。
- 新版本含 `apps` 或缺少 project managed kind 时，命令早失败；旧 repo-managed artifacts、tracking、ledger 和 skill trigger preference 都保持原状。
- 预检通过、进入 uninstall 前，必须捕获旧安装恢复快照；如果 uninstall 成功但后续 install 任一阶段失败，按“回滚和失败处理”里的 `capabilityChanged` 恢复合同还原旧版本。
- `catalogCompatibility === 'current'` 也不代表 artifact inventory 完全一致。显式 Codex project upgrade 必须在成功生成新版 artifact 后，对“旧 tracking 中当前插件拥有的 artifact 集合”和“新版期望 artifact 集合”做差集清理。
- 这组预检需要覆盖 `aw upgrade <plugin> -p codex -s project`、interactive upgrade 选中单插件后的执行路径，以及 `platform=auto|both` 最终解析到 Codex project 的路径。
- `upgrade --all` 因首版不允许传 `--skill-trigger`，遇到 tracking-only / ledger scope record 不可用的 `overridable` Codex project target 时只能把当前 target 记为 skipped，code 固定为 `installOptionsUnavailable`，并让其它不受阻 target 继续按各自 platform/scope 规则执行；`none` / `fixed` target 继续执行其它 preflight。

#### Upgrade artifact 差集清理

Codex project scope 的 upgrade 不再把“仍然有 skill / 仍然有 MCP”视为足够完整的升级合同。每次 project upgrade 都必须计算 artifact inventory：

- `previousArtifacts`：升级前 tracking manifest 中属于当前插件、当前 platform/scope 的 artifact 集合。
- `desiredArtifacts`：本次从新版 catalog / bundle 成功生成并准备写入 tracking 的 artifact 集合。
- artifact identity：`platform + kind + path + artifactKey + hookGroups`。`artifactKey` 为空只适用于现有无需子项身份的单文件 artifact；`kind: "skill"` / `kind: "mcpServer"` 缺少 `artifactKey` 是 tracking integrity error，不能参与 identity 计算或 stale prune。
- identity 中的 `path` 使用 tracking 中的绝对路径；从 repo 子目录执行 install / status / upgrade / uninstall 时，必须先锚定同一个 repo root，再生成相同的绝对 artifact path。
- `staleArtifacts = previousArtifacts - desiredArtifacts`，只包含旧版受管、新版不再声明的内容。

清理规则：

- 新版 artifact 写入和冲突校验成功后，再 prune `staleArtifacts`；任一步失败都保留旧 tracking，不留下半升级状态。
- `kind: "skill"` 的 stale artifact 只删除 tracking 证明属于当前插件的 `.agents/skills/<skill>` 目录；路径不存在时视为 no-op。
- `kind: "mcpServer"` 的 stale artifact 只删除 `.codex/config.toml` 中 `artifactKey` 对应的 `[mcp_servers.<server>]`；其它 server、用户手写配置和其它插件管理的 server 必须保留。
- 若 `previousArtifacts` 或 `desiredArtifacts` 中的 `skill` / `mcpServer` 缺少 `artifactKey`，upgrade 必须在写新版 artifact 或 prune 前 deterministic refusal；不能把损坏条目当作单文件 artifact，也不能按 path-only 删除共享文件内容。
- prune 也要纳入 upgrade rollback baseline：如果删除旧 skill / MCP 后写 tracking 或 ledger 失败，要恢复被删除的目录、TOML 内容和旧 tracking。
- tracking manifest 只能在新版写入和 stale prune 都成功后，用 `desiredArtifacts` 覆盖当前插件记录；不能先覆盖 tracking 再清理旧文件。

交互式安装：

- `-p codex -s project -i` 候选列表应包含 skills-only / mcp-only 插件。
- apps-only 插件在无插件名交互安装里不进入候选；skills / MCP / slashCommands + apps 等 mixed apps 插件进入候选但 disabled，并显示 Codex project scope 不支持 apps、需要改用 user scope 或拆分插件的原因。显式点名 apps-only 或 mixed apps 时都给出清晰错误，不能做部分安装。
- 如果候选插件命中 user-native 外部同名冲突，交互候选应禁用或在执行前给出同一条 deterministic refusal；fake prompt 返回该插件时仍必须被运行时 validation 拒绝。
- 候选说明里不要再暗示会启用 Codex native plugin。

命令输出：

- project scope 成功时说明写入 repo-managed artifacts，例如 `.agents/skills`、`.codex/config.toml`。
- 不输出 native marketplace add 或 plugin enabled 成功信息。
- 若项目未 trusted，安装仍可写文件，但输出应提醒 Codex 可能不会加载 `.codex/config.toml` / hooks / rules / agents，用户需要在 Codex 中 trust 当前项目。`.agents/skills` 的可见性按上游 repo skill loader 行为展示，不把它和 native plugin enabled 混为一谈。
- `codex + project` 的 install / uninstall / upgrade / status 默认输出，不得把“Codex 原生 plugin / marketplace 仅支持 user scope，已回退到 user config”当成当前 scope 的常规说明。
- `collectCommandWarnings()`、status human formatter 和 post-command receipt 都要 scope-aware：只有 user scope 遗留证据、明确的 historical native fallback 诊断或显式 debug/verbose 诊断需要展示 native marketplace 状态；纯 repo-managed project 正常场景不渲染 user marketplace 注册/缺失/回退文案。

### 9. 回滚和失败处理

project scope 安装会同时写多个 repo 文件，必须纳入现有 generated artifacts 回滚模型：

- required AW config 已在安全预检之后、repo artifact 写入之前处理；它不是安装事务的一部分。配置写入成功后若后续 lifecycle 或 artifact 提交失败，配置按 AW config 合同保留，用户可用 `aw config reset` 清理。
- install / upgrade 开始写 repo artifact 前要先准备 scope-owned lifecycle/config 安装快照；若后续未写入 ledger 就失败，必须删除本次未引用的 snapshot，避免留下悬空旧真值。
- 写 `.agents/skills/<skill>` 前记录目标目录状态。
- 写 `.codex/config.toml` 前保留原文件内容；MCP servers 和 managed `developer_instructions` 必须共享同一份 baseline 和同一次文档级 read-modify-write 事务。
- hooks / rules / agents 沿用现有回滚。
- 任一步失败时，回滚本次命令已经写过的 repo-managed artifacts。
- native path 对 project scope 是 no-op，因此失败时不需要清理 user config。

`.codex/config.toml` 的恢复边界要精确：

- 事务 commit 前的 validation 或渲染失败，不得改写 `.codex/config.toml`，也不得写 tracking / ledger。
- 事务 commit 后、tracking 或 ledger 写入前后发生失败，都要恢复整份 `.codex/config.toml` baseline，而不是只尝试反向 patch 某个 MCP server 或 instruction block。
- 如果同一命令同时新增 / 刷新 managed instructions、替换 MCP server、prune stale MCP server，任何一步失败后的最终文件都必须等于命令开始前的 baseline。
- 回滚失败时，错误信息必须点名 `.codex/config.toml` 可能需要人工检查，不能只泛化成 generated artifact rollback failed。

install 的晚失败也必须按现有主链路合同处理，不能只停在 repo 文件回滚：

- 安装开始前读取 tracking manifest baseline 和 installed ledger baseline；写 repo artifact 前继续捕获各 artifact 自己的文件快照。
- 成功路径的提交顺序固定为：先写 repo-managed artifacts，再执行 install / upgrade lifecycle，再写 tracking manifest，最后写 `installed.json` 并把 lifecycle/config snapshot metadata 写入对应 scope record。lifecycle 失败时视同 artifact 提交前失败，要回滚 repo artifacts 并删除未引用 snapshot。
- repo artifact 已写入后，如果失败发生在 lifecycle、写 tracking manifest、计算/写 ledger，或 ledger 写入后的错误路径，回滚顺序为：
  1. 先恢复本次 install 写过的 repo artifacts：`.agents/skills/<skill>`、`.codex/config.toml [mcp_servers.*]`、hooks / rules / agents / managed instructions。
  2. 再恢复 tracking manifest baseline；如果 tracking 写入在替换前失败且 baseline 仍未改变，这一步可以是 no-op，但实现不能依赖“失败一定未写入”的假设。
  3. 删除未被 ledger 引用的 install snapshot；如果删除失败，错误诊断必须说明 snapshot 可能悬空。
  4. 最后基于 installed ledger baseline 写入 degraded 状态。Codex project scope 没有 native write，因此 reason 应表达 artifact / lifecycle / tracking / ledger bookkeeping 被中断，而不是 native plugin 已写入。
- 如果 degraded ledger 写入也失败，最终错误必须同时暴露原始失败和 degraded 写入失败；如果 repo artifact 或 tracking baseline 回滚失败，也要说明需要人工检查的 surface，至少区分 repo artifacts、tracking manifest 和 `installed.json`。

project scope 卸载也要纳入同一套失败恢复模型，不能只覆盖旧的 instruction / hook / rule / agent 产物：

- 卸载前读取 tracking record，捕获当前插件名下所有 repo-managed artifacts 的快照：
  - `.agents/skills/<skill>` 目录存在性和目录内容。
  - `.codex/config.toml` 原始文件内容，至少要能恢复被删除的 `[mcp_servers.*]` 条目并保留其它用户配置。
  - hooks / rules / agents / managed instructions 沿用现有快照。
  - tracking manifest baseline 和 installed ledger baseline。
- 卸载 lifecycle 必须在 repo-managed remover 之前执行，并优先使用 ledger scope record 中的 install snapshot 解析旧版本脚本与 config schema。lifecycle 失败时，中止卸载，不删除 repo artifacts、tracking 或 ledger。
- repo-managed remover 只删除 tracking 证明属于当前插件的 skill 目录和 MCP server 条目；未受管同名内容不碰。
- 卸载过程中如果在删除 repo skill、删除 MCP server、写 tracking 或写 ledger 的任一步失败，回滚顺序为：
  1. 先恢复 repo artifacts：skill 目录、`.codex/config.toml`、hooks / rules / agents / managed instructions。
  2. 再恢复 tracking manifest baseline。
  3. 最后按现有策略恢复或标记 ledger degraded；如果无法写 degraded 状态，需要把原始错误和 ledger 写入错误一起暴露。
- 回滚本身失败时，错误信息必须说明哪些状态可能需要人工检查，避免用户误以为卸载已经完整成功。

`capabilityChanged` 显式 upgrade 必须把 uninstall 和 install 包在同一份旧安装恢复快照里：

- 进入 uninstall 前先完成新版 project installability、external ownership、project/user config、tracking identity、skill trigger 偏好预检和 required AW config preflight；任一预检失败时，不捕获破坏性写入、不调用 uninstall，也不改旧安装。required AW config preflight 必须排在 Codex project 安全预检之后。
- 预检通过后，在调用 uninstall 前捕获旧安装 baseline：
  - 当前插件在 tracking manifest 中声明的全部 repo-managed artifacts，包括 `.agents/skills/<skill>`、`.codex/config.toml` 里的 MCP servers / managed instructions，以及 hooks / rules / agents。
  - tracking manifest 原文或结构化 baseline。
  - `installed.json` 中当前 platform/scope 的 ledger record、skill trigger preference、lifecycle/config snapshot metadata 和相关 bookkeeping。
  - 旧安装快照引用的 bundle 路径和存在性诊断；恢复旧 ledger 时不能把新版 snapshot 写回旧 scope record。
- capabilityChanged 内部 uninstall 不触发插件 `uninstall` lifecycle；旧版 lifecycle 只属于用户显式卸载。uninstall 成功后，新版 install 的提交顺序仍是“写新版 repo artifacts、执行 upgrade lifecycle、写 tracking、写 ledger”。只要失败发生在 repo artifact 写入、`.codex/config.toml` transaction commit 后、upgrade lifecycle、tracking 写入、ledger 写入，或 install 自身回滚链路中的任一点，都先恢复旧安装 baseline，而不是只清理新版残留。
- 恢复旧安装成功后，最终文件系统、tracking manifest 和 ledger 必须等于 upgrade 命令开始前的状态；命令仍返回失败，并说明新版 upgrade 未完成但旧版本已恢复。
- 如果旧安装恢复本身失败，错误必须同时暴露原始 upgrade 失败和恢复失败，并点名需要人工检查的 surface：repo artifacts、`.codex/config.toml`、tracking manifest 和 `installed.json` 至少要区分。能写 ledger degraded 状态时，reason 要表达 `capabilityChanged` upgrade 中断且旧安装恢复不完整。
- 这条恢复合同必须覆盖 skills-only、MCP-only，以及 skill + MCP / managed instructions 混合旧版本；不能只依赖 install 自己的晚失败回滚，因为旧版本已经先被 uninstall 删除。

重复安装：

- tracking 中已有当前插件拥有的 skill / MCP，且 target 的 `skillTriggerApplicability` 为 `none` / `fixed`：不要求 ledger install options，允许在其它 preflight 通过后刷新。
- tracking 中已有当前插件拥有的 `overridable` skill，且 ledger scope record 可用、`managed === true` 并能恢复 install options：允许沿用 ledger 偏好刷新。
- tracking 中已有当前插件拥有的 `overridable` skill，但 ledger scope record 缺失、不可用、`managed !== true` 或不能恢复 install options：
  - 未传 `--skill-trigger` 时必须 deterministic refusal，拒绝发生在 repo artifact 写入、stale prune、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前。
  - 传入显式 `--skill-trigger default|manual|auto` 且 tracking artifact identity 完整时，允许刷新当前插件已受管 repo artifacts，并在成功后重建 ledger scope record。
  - tracking identity 损坏，例如 `kind: "skill"` / `"mcpServer"` 缺少 `artifactKey`，即使传入 `--skill-trigger` 也必须先拒绝并要求修复 tracking，不能按 path-only 覆盖或删除。
- tracking 缺失但目标文件存在：按 unmanaged 冲突 fail fast。
- ledger degraded 时，只有 `overridable` target 沿用同一条规则：不能从不可信 ledger 隐式恢复 skill trigger preference；若 tracking identity 完整，用户显式传入 `--skill-trigger` 后才可刷新并写回新的可用 scope record。`none` / `fixed` target 不需要从 degraded ledger 恢复偏好。
- 这条重复安装合同同样适用于 interactive install dispatch 后的普通命令路径；prompt 层不能把缺失 ledger 偏好静默补成 `default`。

## 测试计划

### 单元测试

- `hasCodexProjectManagedArtifacts()`：
  - skills-only 为 true。
  - slashCommands-only 为 true。
  - mcp-only 为 true。
  - extensions-only 为 true。
  - apps-only 为 false，因为它没有 project 可写 repo-managed kind。
  - skills + apps 仍为 true，因为 helper 只回答是否存在 project-managed kind，不承载 apps 拒绝语义。
- `requiresCodexNativePlugin(plugin, scope)`：
  - user scope skills / slashCommands / MCP / apps 为 true，`slashCommands-only` 也必须为 true。
  - project scope 始终 false。
- Codex project installability validation：
  - apps-only 插件显式安装时 fail fast，错误说明 Codex project scope 不支持 apps，并提示改用 user scope。
  - skills + apps、MCP + apps、slashCommands + apps 等 mixed apps 插件显式安装时同样 fail fast，不能做部分安装，也不能退化成“没有可安装内容”。
  - 没有 project-managed kind 的 native-only 插件显式安装时 fail fast，错误说明该插件没有 Codex project 可安装内容。
  - interactive candidate 策略区分 apps-only、mixed apps 和没有 project-managed kind：apps-only 在无插件名候选里隐藏；mixed apps 因包含 project-managed kind 仍保留为 disabled，并显示 apps 不支持原因；没有 project-managed kind 的 native-only 插件不进入候选或显示为没有 Codex project 可安装内容，不能和 apps 不支持混成同一个原因。
- platform resolution / availability：
  - PATH 缺少 `codex` executable 且 `AW_FORCE_CODEX_AVAILABLE` 未设置时，Codex project repo-managed install / explicit upgrade / `upgrade --all` target 仍能解析为可执行目标。
  - 同一环境下，Codex user scope 或任何实际需要 native runner 的 target 仍按“Codex 当前环境不可用”失败。
- Codex project install 不调用 native runner。
- Codex project install 不调用 native marketplace add。
- Codex project install 不写 user `~/.codex/config.toml [plugins]` 或 `[marketplaces]`。
- Codex project install 遇到 user `~/.codex/config.toml [plugins]` 已启用同名外部 marketplace 插件时 fail fast；不写 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime。
- Codex project install 遇到 user `~/.codex/config.toml` 语法损坏时 fail fast；即使目标是 skills-only，也不能写 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime，并且错误要说明无法完成 external ownership 预检。
- Codex project install 不写 `sharedNativeRefs.projects`。
- command native bookkeeping：
  - Codex project install / upgrade 即使 manifest 声明 `skills` / `mcpServers`，也只产生 repo-managed 结果，不把插件计入 `nativePlugins.codex`。
  - `native:plan` / `native:applied` 事件基于 scope-aware 真实执行结果；Codex project scope 应记录 skipped 或等价诊断。
  - upgrade 结果合并不会把 Codex project scope 的 repo-managed 成功误报成 native success。
  - CLI receipt 对 Codex project install / upgrade 不输出 marketplace 注册或 plugin enabled 成功文案。
- command prepare / catalog loader：
  - Codex project-only install / explicit upgrade / `upgrade --all` 使用只读 catalog，不调用 `ensureLocalMarketplace()`。
  - `~/.aw` 缺失、stale、布局损坏或 ledger degraded 时，只读 catalog 回退 embedded bundle，且共享 marketplace/runtime 文件系统快照不变；成功命令只允许在提交阶段写 AW bookkeeping。
  - `platform=auto|both` 先解析真实 platform/scope 组合，再决定是否需要写入型 local marketplace 初始化。
  - 显式 `install <plugin> --platform auto|both --scope project` 必须先解析真实会执行的 platform/scope targets；当最终只有 Codex project repo-managed target 时，不得初始化、修复或重放共享 runtime。
  - 显式 `upgrade <plugin> --platform auto|both --scope project` 也使用同一准备顺序；当最终只有 Codex project repo-managed target 时，不得在 preflight 或 target 解析前触发 `ensureLocalMarketplace()`。
  - mixed 显式 install / upgrade 如果任一 Codex project target 未通过 preflight，整条命令失败，不执行其它 platform target，也不返回 `skipped[]`。
  - 对照路径必须保留：同一命令解析到 Claude project 或 Codex user、所有 Codex project preflight 通过、且实际需要 native/runtime 准备时，才允许执行写入型 local marketplace 初始化。
  - `upgrade --all --platform auto --scope project` 在 Codex project 只有 tracking evidence、ledger scope record 缺失时，平台推断仍能选中 Codex；随后只有 `overridable` target 因偏好不可恢复被 skipped，code 固定为 `installOptionsUnavailable`，`none` / `fixed` target 继续执行其它 preflight，而不是在平台推断阶段漏掉或报“双平台无法唯一推断”。
  - `upgrade --all --platform auto --scope project` 同时存在 Codex project tracking evidence 和 Claude managed evidence 时，继续要求显式 `--platform`，不能随机选择其中一侧。
  - `upgrade --all --platform auto --scope project` 遇到 Codex project tracking manifest 不可读或 tracking identity 损坏时，对 Codex 平台记为 `unknown` 并拒绝 auto 推断；错误说明需要先修复 tracking 或显式收窄平台。
  - project `.codex/config.toml` 语法损坏且目标包含 MCP / managed `developer_instructions` 时，Codex project install / explicit upgrade 在任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前失败；`upgrade --all` 将受影响 target 记为 `skipped[]`，code 固定为 `projectConfigUnreadable`，并继续处理同批 skills-only target 或 mixed 命令中的其它 target；skills-only 目标保持可安装、可升级。
  - user `~/.codex/config.toml` 语法损坏时，Codex project install / explicit upgrade 在任何 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前失败；mixed 显式命令也整条失败且不执行其它 target。`upgrade --all -p codex -s project` 将该 platform/scope 下所有 target 标记为 skipped，code 固定为 `codexProjectUserConfigUnreadable`，并在 direct command 返回值和结果诊断中逐项列出原因。
  - user config 可解析但 external ownership / project trust 不能可靠判定时，`upgrade --all` 将对应 Codex project target 标记为 skipped，code 固定为 `externalOwnershipUnknown`；同名 user-native 外部 marketplace plugin 已确认存在时，code 固定为 `externalOwnershipPresent`。两类用例都要断言 skipped target 没有 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入。
  - legacy AW bookkeeping 或 install snapshot 把插件放入 `upgrade --all` 候选，但当前 project scope 没有完整 ledger managed scope record 或完整 repo tracking evidence 时，target 记为 skipped，code 固定为 `scopeNotInitialized`；plain absence、orphan / unmanaged evidence 不能进入候选，也不能产生该 code。
  - tracking 中 `kind: "skill"` 或 `kind: "mcpServer"` 缺少必要 `artifactKey`，或 tracking identity 无法和当前 repo root / scope key 可靠绑定时，显式 upgrade / uninstall deterministic refusal；`upgrade --all` 记录 target skipped，code 固定为 `trackingIntegrityError`，并断言不做 path-only cleanup、stale prune 或 rollback baseline 写入。
  - `resolveInstallOptionsForTargets()` 面对 Codex project tracking-only `overridable` evidence、但 ledger scope record 缺失或不可用时，不返回 `skillTriggerPreference: "default"`；显式 upgrade 和重复 install 无 CLI 偏好时抛出 deterministic refusal，`upgrade --all` 记录 target skipped，code 固定为 `installOptionsUnavailable`。
  - `resolveInstallOptionsForTargets()` 面对 `mcp-only` / extensions-only 的 `none` target，以及 `slashCommands-only` / 全部 `allowInstallOverride = false` 的 `fixed` target 时，不要求 ledger install options，也不写出伪造的 `skillTriggerPreference: "default"`。
  - `upgrade --all` 遇到 current catalog 可解析但新版含 `apps`、或已经没有 project managed kind 的 Codex project target 时，将该 target 记为 `skipped[]`，code 固定为 `catalogNotProjectInstallable`，并继续处理其它 target。
  - `upgrade --all` 遇到无 AW tracking 的同名 repo artifact 冲突时，将该 target 记为 `skipped[]`，code 固定为 `unmanagedRepoArtifactConflict`；覆盖无 tracking 同名 MCP server orphan 和无 tracking 同名 repo skill 两类输入。
  - `upgrade --all` 的显式 mixed `platform=both` 路径中，Codex project target 因 user config 损坏或 `overridable` tracking-only 偏好缺失被 skipped 时，不影响 Claude 或 Codex user target 的准备和执行，也不因被跳过分支初始化共享 runtime。
  - `upgrade --all --platform auto --scope project` 在进入 mixed continuation 前必须先做 evidence-first 推断；若当前 scope 同时存在 Claude managed evidence 和 Codex project evidence，或任一候选平台 evidence 为 `unknown`，命令拒绝 auto，不产生 target-level `skipped[]`，也不触发任何平台的准备或写入。
- command preflight / status boundary：
  - `installTargetsOnPlatforms()` 不复用 `adapter.status()` 作为 Codex project 写入前 external ownership 判定；user config 不可读时通过 dedicated preflight 早拒绝，并断言 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 和共享 runtime 都未写入。
  - required AW config prompt 顺序要用 fake prompt 锁住：安全预检失败时 prompt 不被调用；安全预检通过但缺 required config 时才进入 prompt 或非交互 refusal。
  - required AW config 聚合要用 fake prompt / fake store writer 锁住：同一插件同一 schema source 在 mixed install / explicit upgrade 中只 prompt 一次、patch 一次，聚合键为 `pluginName + schema source manifest identity`；重复 target 只能复用写入后的 effective config。
  - required AW config 的 `selectedScope` 要有反向写层用例：命令 scope 为 `project` 但 prompt 选择 `user`、或命令 scope 为 `user` 但 prompt 选择 `project` 时，只写 prompt 选择的那一层，后续所有 target 都读取这次 effective config，不再按命令 scope 覆盖。
  - `aw config configure --scope user|project` 要有相反方向的硬约束用例：fake prompt 若返回另一层 `selectedScope`，命令必须拒绝，stdout / stderr 保持错误通道约定，并断言 user / project config store 都没有被创建或改写。
  - 显式 `runUpgradeTargets()` 不在 preflight 前调用 uninstall adapter、repo artifact remover、stale prune、tracking writer 或 ledger writer。
  - `uninstallTargetsOnPlatforms()` 在已有 Codex project repo-managed evidence 且 user-native 外部同名插件存在时不抛 external ownership refusal，仍清理受管 repo artifacts；没有 project evidence 时不触碰 user native state。
  - user config 语法损坏时，skills-only project `status` 产生 `externalOwnership.checkState = "unknown"` 的 cell；config-backed project `.codex/config.toml` 损坏时，`statusCommand()` 直接抛 fatal status error，JSON 模式 stdout 为空或不输出半截 JSON。
- lifecycle / config baseline：
  - Codex project install / upgrade 在 repo-managed artifacts 写完后、tracking / ledger 写入前执行 lifecycle；脚本 context 包含 `platform: "codex"`、`scope: "project"`、resolved config、repo artifact 列表和 manifest snapshot 真值。
  - install / upgrade lifecycle 失败时回滚 repo artifacts，删除未被 ledger 引用的 install snapshot，不写 tracking / ledger；若已发生 repo artifact 写入，ledger degraded reason 不能误写成 native plugin 已写入。
  - uninstall lifecycle 使用 ledger install snapshot 中的旧 manifest / config schema，在 repo artifact 删除前执行；脚本失败时不删除 repo artifact、tracking 或 ledger。
  - capabilityChanged 显式 upgrade 的内部 uninstall 不执行 uninstall lifecycle；新版路径只执行一次 `upgrade` lifecycle，且失败时恢复旧 repo artifacts、tracking、ledger 和旧 snapshot metadata。
  - `--script-timeout` 覆盖、manifest `scripts.timeoutMs` 和默认值的优先级在 Codex project scope 下与其它 scope 一致。
  - status 读取 config/script health 和 `healthSource` 时不执行 lifecycle、不创建 config store、不创建 install snapshot、不刷新 marketplace。
- upgrade all result contract：
  - `upgradeCommand(..., { all: true })` 返回 `skipped[]`，每项包含 `platform`、`scope`、`plugin`、`code`、`reason`；`plugins[]` 只包含实际升级成功的插件。
  - direct command 返回值必须分别正向断言全部 10 个稳定 code：`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`trackingIntegrityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`；这些 code 不能只藏在 warning 文案里，也不能退化成 target 外 throw。
  - mixed `upgrade --all` 中 Codex project target 被 skipped 时，Claude 或 Codex user target 仍可成功，direct command 返回值同时包含 `plugins[]` 和 `skipped[]`。
  - CLI receipt 对每个稳定 code 都有至少一条 human receipt 正向回归：部分 skipped 输出成功摘要和跳过摘要；全部 skipped 时不输出“已升级 无”。
  - CLI entry 对每个稳定 code 都覆盖退出码：mixed succeeded + skipped 时退出 `0`；全部 target skipped 且没有成功升级时退出 `1`。CLI 回归必须同时断言 receipt 和退出码。
- explicit upgrade preflight：
  - user-native 外部同名插件存在时早失败，并断言 uninstall adapter、repo artifact remover、ledger/tracking writer 都未执行。
  - user `~/.codex/config.toml` 语法损坏时早失败，并断言 uninstall adapter、repo artifact remover、ledger/tracking writer 都未执行。
  - repo tracking 仍有 Codex project `overridable` skill evidence，但 ledger scope record 缺失或不可用时，显式 upgrade 未传 `--skill-trigger` 早拒绝；传入 `--skill-trigger` 且 tracking artifact identity 完整时才进入写入流程。
  - repo tracking 只有 `none` / `fixed` evidence 时，显式 upgrade 不因为 ledger scope record 缺失或不可用而拒绝。
  - project `.codex/config.toml` 语法损坏且当前 scope tracking 含 config-backed artifact 时早失败，并断言旧 repo-managed artifacts、tracking 和 ledger 原状保留；tracking 只含 skill 时不因 TOML 损坏早失败。
  - capabilityChanged 分支先做 project installability validation，再调用 uninstall。
  - 新 catalog 含 `apps` 或没有 project managed kind 时早失败，并断言 uninstall adapter、repo artifact remover、ledger/tracking writer 都未执行。
- repo-managed upgrade prune：
  - 旧版本有 `skill-a` 和 `skill-b`，新版只保留 `skill-a` 时，upgrade 删除旧 tracking 拥有的 `.agents/skills/skill-b`，并保留 `skill-a`。
  - 旧版本把 skill 从 `skill-old` 改名为 `skill-new` 时，upgrade 写入 `skill-new` 并删除 `skill-old`，tracking 只留下新版集合。
  - 旧版本有 `mcp_servers.foo` 和 `mcp_servers.bar`，新版只保留 `foo` 时，upgrade 只删除 `[mcp_servers.bar]`，保留 `foo` 和外部 server。
  - 旧 tracking 或新版 desired artifact 中的 `skill` / `mcpServer` 缺少 `artifactKey` 时，explicit upgrade 在写新版 artifact 或 prune 前 deterministic refusal；`upgrade --all` 对该 target 记录 skipped，code 固定为 `trackingIntegrityError`，且不做 path-only 删除。
  - prune 后写 tracking 或 ledger 失败时，恢复被删除的旧 skill / MCP server 和旧 tracking manifest。
- repo skill materializer：
  - 复制 pristine skill 到 `.agents/skills/<skill>`。
  - tracking manifest 中的 skill artifact `path` 为绝对路径，不能写成 `.agents/skills/<skill>`。
  - 从 repo 子目录执行时，同一 skill 仍生成同一个 repo-root anchored 绝对路径。
  - 保留 skill 原名。
  - 当前插件已管理同名目录时可刷新。
  - 其它 AW 插件已管理同名目录时 fail fast。
  - 未受管同名目录 fail fast。
  - `manual` / `auto` / `default` 只 patch repo skill 的 `agents/openai.yaml`。
  - 不修改 `~/.aw/plugins/<plugin>/codex/skills`。
- 公共 slash command 协议：
  - `.agents-plugin/plugin.json` 支持 `slashCommands: "./slash-commands"`，路径校验与其它源码路径一致。
  - `slash-commands/` 目录存在但 manifest 未声明 `slashCommands` 时 validate 失败；声明路径缺失、越界、不是目录或没有 Markdown 命令时 validate / build 失败。
  - command 文件 basename 沿用 skill 名 / `artifactKey` 规则；非法命名、归一化后重复、与显式 `skills` 同名时 build 早失败。
  - `slashCommands` 首版只接受根目录直属 Markdown 和保留 `assets/` 资源目录。除 `assets/` 外的嵌套目录命令必须 deterministic failure；`assets/` 内的 Markdown 不生成 command；非 Markdown 文件不能生成 command，目录仅含非 Markdown 文件时按“没有可生成的 Markdown 命令”失败；两个路径归一化后落到同一 command name 时也要失败。
  - command frontmatter schema 覆盖公共必填 `description`、可选 `claude` / `codex` 分平台块，以及未知字段拒绝。缺失 frontmatter、缺失 `description`、顶层写入 `allowed-tools` / `argument-hint` / `model` / `shell` / `disable-model-invocation`、`codex` 块写入 Claude-only 字段、源码试图配置 `codex.policy` 都必须失败。
  - 生成的 Claude command frontmatter 使用 `claude.description ?? description`，保留 `claude.allowed-tools`、`claude.model`、`claude.argument-hint`、`claude.shell`，并固定写 `disable-model-invocation: true`。
  - 生成的 Codex `SKILL.md` 使用 basename 作为 `name`，使用 `codex.description ?? description` 作为 `description`；`agents/openai.yaml.interface` 接收 `codex.interface.*`，未写的 `display_name` / `short_description` 分别回退到 command name / Codex description。
  - `codex.interface.icon_small` / `icon_large` 正向用例使用 `./assets/review-16.png` / `./assets/review-64.png`，断言 build 从 `slashCommands` 根目录的 `assets/` 复制到 generated Codex skill 的 `assets/`，并且 `agents/openai.yaml` 中仍是 `./assets/...`。
  - icon 负向用例覆盖 `icons/review.png`、`../review.png`、绝对路径、反斜杠路径、目录目标和缺失文件，全部 deterministic failure；错误要点名 command、字段和资源路径，并断言没有写出半生成 bundle。
  - `.agents-plugin/plugin.json` 出现 `manifestOverrides.claude.commands`、旧式 `commands` 字段，或旧 `commands/` Claude-only 打包规则时，validate / build 直接失败，错误提示改用 `slashCommands`。
  - `buildConfig.templates` 命中 `slash-commands/*.md` 时，先分别渲染 Claude / Codex 内容，再生成 Claude command 和 Codex skill；测试要断言两个平台得到各自变量值。
  - 平台模板回归要覆盖 Claude 渲染结果可包含 `$ARGUMENTS`、`$1` 和命令结果填充，并由 `claude.argument-hint` / `claude.allowed-tools` 描述；Codex 渲染结果必须不含这些 Claude-only 语法。若 Codex 渲染结果仍残留 `$ARGUMENTS`、`$1` 或命令结果填充语法，build 早失败。
  - build 后 Claude manifest 得到原生 `commands`，Codex manifest 得到 generated skills；platform bundle 中不得出现原始 `slash-commands/` 源目录。
  - Codex generated skill 的 `agents/openai.yaml` 固定为 `allow_implicit_invocation: false`，且 `--skill-trigger auto` 不能改写它。
  - command 名与显式 skill 名冲突时 build 或 install 早失败，不能静默改名。
  - Codex project status / tracking 对 generated slash command skill 使用 `kind: "skill"` + `artifactKey: "<command>"`，不会出现新的 tracking kind。
  - `slashCommands-only` 插件安装到 Codex user scope 时，ledger capability snapshot 的 `requiresNativePlugin` 为 true，并写入 `sharedNativeRefs.user`；current catalog 缺失 / historical placeholder 场景下，status、discovery、uninstall、显式 upgrade 仍能把它识别为 Codex user native managed evidence。
  - authoring-tool 回归覆盖 `validate_plugin.js`：新 `slashCommands` 夹具通过，旧 `manifestOverrides.claude.commands` / 旧 `commands/` fileRules 夹具失败，隐藏 code-review 示例和参考文档同步改成新入口。
- skill trigger policy inventory：
  - `resolveSkillTriggerPolicies({ platform: 'codex' })` 只枚举 `codex/skills`，`resolveSkillTriggerPolicies({ platform: 'claude' })` 只枚举 `claude/skills`，不再对两个平台做 skill 名并集。
  - `slashCommands-only` bundle 在 Claude 侧只有 `commands/<name>.md` 时，Claude status / upgrade 不读取不存在的 `claude/skills/<name>/SKILL.md`，也不产生伪造的 skill trigger `unknown` / drift。
  - 同一插件同时有 Claude 显式 skill 和公共 `slashCommands` 时，Claude 侧只读取真实 `claude/skills/*`，Codex 侧只读取真实 `codex/skills/*`。
  - 公共 `slashCommands` 生成的 Codex skill 在适用性计算中归为 `fixed`，不会因为没有 `skillTriggers.<name>` 而被当成可 override 或异常。
- skill trigger shared runtime：
  - `selectEffectiveSkillTriggerRecord()` 或新的共享 runtime selector 不把 Codex project scope 纳入 winner 候选。
  - `initializeLocalMarketplace()` / replay 面对 Codex project scope record 不物化到 `~/.aw`。
  - uninstall 后重选不会让剩余 Codex project scope 成为共享 runtime winner。
- MCP config writer：
  - 写 `.codex/config.toml [mcp_servers.*]`。
  - tracking manifest 中的 MCP artifact `path` 为绝对 `.codex/config.toml` 路径，不能写成 `.codex/config.toml`。
  - round-trip 保留外部配置。
  - 结构化 server fixture 覆盖 string、boolean、number、array、nested object，例如 `args`、`env` / `http_headers`、`startup_timeout_sec` / `tool_timeout_sec`、`tools.<tool>.approval_mode`；写入 TOML 后能解析回等价结构。
  - 至少一个 fixture 使用需要 TOML quoted key 的 server 名，例如 `acme.tools v1`。install 后 TOML 中必须是单个 `[mcp_servers."acme.tools v1"]` identity，tracking `artifactKey` 原样为 `acme.tools v1`，解析回 JSON 时不能被拆成 `mcp_servers.acme.tools` 嵌套路径。
  - quoted key fixture 要覆盖 sibling 保护：同时存在 `acme`、`acme.tools v1`、`acme.tools v1-extra` 或其它外部 server 时，refresh / status / drift / uninstall 只命中同一个 quoted key 对应的受管 server。
  - 刷新同名 server 时，用新版 JSON 子树整体替换旧 `[mcp_servers.<server>]` 及所有后代子表；旧版独有的 nested table / nested key 不得残留。
  - 删除受管 server 时，一并删除 `[mcp_servers.<server>]` 和 `[mcp_servers.<server>.*]` 后代子表，同时保留 sibling server、sibling 后代子表、外部 server 和其它顶层配置。
  - rendered `.mcp.json` 中 `mcpServers.<server>` 不是 object，或 server 子树包含 `null` 时，writer 在写入前 fail fast，不改 `.codex/config.toml`、tracking 或 ledger。
  - 同一插件声明多个 MCP servers 时，tracking 写入多个 `kind: "mcpServer"` artifact，且每个 artifact 都有不同 `artifactKey`。
  - `mergeGeneratedArtifacts()` 不会把同 path / 同 kind / 不同 `artifactKey` 的 MCP server 折叠。
  - 同一插件同时声明 managed `developer_instructions` 和 MCP servers 时，writer 只对 `.codex/config.toml` 做一次文档级事务；模拟 MCP validation 失败、instruction render 失败、写文件失败时，文件、tracking 和 ledger 都保持 baseline。
  - status 能发现 `config.toml` 文件存在但某个受管 `[mcp_servers.<server>]` 被手动删除的 missing，并在 `generatedArtifacts[]` / `repoManagedSessionState.items[]` 中用 `artifactKey` 指出具体 server。
  - status 能发现某个受管 `[mcp_servers.<server>]` 子树被手动改动后的 `drifted`，包括 nested `env`、`tools.*`、数组或 scalar 值变化。
  - 同插件已管理 server 可更新。
  - 外部同名 server fail fast。
  - 其它插件管理的同名 server fail fast。
  - project `.codex/config.toml` 语法损坏时，writer / remover / status reader 都 fail fast，并且不会产生半写入状态。
  - uninstall 删除自己管理的 server，保留外部 server。
- status model：
  - `GeneratedArtifactStatus.path` 和 `repoManagedSessionState.items[].path` 原样输出 tracking 中的绝对路径。
  - `GeneratedArtifactStatus` 原样包含 `artifactKey`；`kind: "skill"` / `kind: "mcpServer"` 缺少 `artifactKey` 时返回诊断，不做 path-only 推断。
  - MCP `artifactKey` 为 quoted-key 形态时，status / drift comparator 仍按解析后的单个 server key 匹配。测试要覆盖 `artifactKey: "acme.tools v1"` 的 visible、missing、drifted、orphan 四类状态，并断言 human / JSON 都原样展示该 key。
  - `kind: "skill"` / `kind: "mcpServer"` 缺少 `artifactKey` 时，执行型命令覆盖同一拒绝合同：uninstall、explicit upgrade、historical cleanup 和 prune 都必须拒绝进入 cleanup，不能把 status 的 `unknown` 自动降级成 unmanaged。
  - legacy `scopeInitialized` 派生回归：ledger managed 为 `yes`；完整 tracking-only repo skill / MCP evidence 为 `yes`；只有 orphan skill / MCP 或 user-native external ownership 为 `no`；ledger degraded 且无完整 tracking 为 `unknown`；tracking identity 损坏为 `unknown`；project trust unknown、external ownership check unknown、embedded fallback、managed item missing / drifted 不改变 `yes`。
  - `repoManagedSessionState.items[]` 能同时表达 `skill commit visible`、`mcp foo missing`、`mcp bar visible`，并且 `repoManagedSessionState.skills` / `mcpServers` 汇总为稳定 summary。
  - skills-only 插件的 `repoManagedSessionState.mcpServers.state` 为 `not_applicable`，mcp-only 插件的 `repoManagedSessionState.skills.state` 为 `not_applicable`；这两个 summary 的各计数字段都为 `0`，health 不因此降级。
  - `mcp-only` / extensions-only target 的 JSON 输出 `skillTriggerApplicability = "none"`，不输出伪造的 `installOptions.skillTriggerPreference = "default"`。
  - `slashCommands-only` target、以及所有 skill 都 `allowInstallOverride = false` 的 target，JSON 输出 `skillTriggerApplicability = "fixed"`；ledger 缺失或 degraded 不会让 status 把 skill trigger 偏好标成 `unknown`。
  - 至少一个有效 skill `allowInstallOverride = true` 的 target，JSON 输出 `skillTriggerApplicability = "overridable"`，并沿用 `skillTriggerPreference` / runtime matches / drift 聚合。
  - 已声明但当前 scope 没有对应受管项时，summary 使用 `absent`；测试要断言它不会和未声明 kind 的 `not_applicable` 混用。
  - 多 skill 插件下，`skillTriggerRuntimeState` / `skillTriggerRuntimeMatches` / `skillTriggerDrift` 按完整 repo skill 集合聚合：两个 skill 都匹配 `manual` 时为 `matched + matches=["manual"] + drift=no`；一个 skill 匹配、另一个 drifted 或 missing 时为 `mixed + matches=[] + drift=yes`。
  - 多 skill 插件下，全部 tracked skill 都 visible 但 `allowInstallOverride` 不同时，候选签名必须逐 skill 应用 override 规则；若 `default` 与 `auto` 对某个组合等价，`skillTriggerRuntimeMatches` 要同时包含两个偏好，drift 只看当前 ledger 偏好是否在 matches 中。
  - 多 skill 插件下，runtime 整体匹配某个非 ledger 偏好时，`skillTriggerRuntimeState` 仍为 `matched`，`skillTriggerRuntimeMatches` 指出实际匹配偏好，`skillTriggerDrift=yes`。
  - project trust 未开启时，repo skill 仍可见，MCP / instructions / hooks / rules / agents 标成 `blockedByProjectTrust`，health 为 `needsAttention`。
  - project trust 无法判断时，受影响的 MCP / instructions / hooks / rules / agents 标成 `projectTrustUnknown`，health 为 `unknown`。
  - skills-only 插件没有 MCP / instructions / hooks / rules / agents 时，单纯的 project trust 未开启或无法判断不影响 skill item；只要 tracked repo skill 与 pristine bundle 匹配，且 external ownership 检查可判定，health 仍为 `ready`。
  - project-only status 使用 embedded fallback catalog 时，tracked repo skill 仍按 repo `.agents/skills` 与 embedded pristine bundle 计算 `visible` / `drifted` / `missing`，`skillTriggerRuntimeState` 和 `skillTriggerDrift` 不能仅因 `currentCatalog.source !== 'local'` 变成 `unknown`。
  - tracking 缺失但 `.agents/skills/<skill>` 存在时，status 标成 `orphan` / unmanaged evidence，不把该插件算作已受管安装，也不让 uninstall 清理它。
  - `.codex/config.toml` 存在当前插件声明的 `[mcp_servers.foo]` 但 tracking 缺失时，status 标成 `kind: "mcpServer"`、`artifactKey: "foo"`、`tracked: false`、`state: "orphan"`，`generatedArtifacts[]` 不伪造对应记录，health / summary health 为 `needsAttention`，next steps 指向删除、改名或重新受管该外部 server。
  - project `.codex/config.toml` 语法损坏且当前 status 目标含 MCP / managed `developer_instructions` evidence 时，`aw status -p codex -s project` 整命令失败；JSON 模式也不得输出半截 JSON。skills-only status 不因无关 TOML 损坏失败。
  - user-native 外部同名插件只报告为 `externalOwnership` 诊断，不让 project scope 变成 installed。
  - project scope 已有 repo-managed evidence 且命中 user-native 外部同名插件时，health / summary health 为 `needsAttention` 而不是 `external`；default status 仍展示 repo-managed item 状态，并在 next steps 中提示先解除同名外部 native 冲突。
  - user `~/.codex/config.toml` 语法损坏时，Codex project status 仍报告 repo skill / MCP / extensions 的 item 真值；JSON 中 `externalOwnership.checkState = "unknown"`，需要 project trust 的 item 报 `projectTrustUnknown`，cell health 为 `unknown`，default / verbose 输出提示先修复 user config 后才能确认外部同名 native 冲突。
- generated artifact path contract：
  - 读取已有绝对路径 tracking 记录时，status / uninstall / rollback 仍按原路径工作，不需要额外 resolver 或迁移。
  - 新增 skill / MCP artifact 写入 tracking 时断言 `path.isAbsolute(artifact.path)`，并断言不会出现 `.agents/...` 或 `.codex/...` 这类 repo 相对持久化值。
  - `mergeGeneratedArtifacts()` 使用绝对 `path + kind + platform + artifactKey + hookGroups` 去重；多 MCP server 共用同一个绝对 `.codex/config.toml` 时仍靠不同 `artifactKey` 保留多条记录。
  - `status --json` 的 `generatedArtifacts[].path` 和 `repoManagedSessionState.items[].path` 与 tracking manifest 中的绝对路径完全一致，可稳定断言。

### 集成测试

- `aw install git-commit -p codex -s project`
  - 成功。
  - 生成 `.agents/skills/git-commit/...`。
  - 不生成或修改 user native plugin enabled 状态。
  - 在 `~/.aw` 缺失 / stale / degraded 时，不创建、不修复、不重写共享 marketplace/runtime；成功后只允许出现 `installed.json`、install snapshot 等 AW bookkeeping。
  - PATH 缺少 `codex` executable 且未设置 `AW_FORCE_CODEX_AVAILABLE` 时仍可安装；断言没有调用 Codex native runner，也没有写 user native config。
  - tracking manifest 记录 skill artifact。
  - tracking manifest 中的 skill artifact `path` 是 repo-root anchored 绝对路径；`status --json` 中对应 `generatedArtifacts[]` 和 `repoManagedSessionState.items[]` 也保持同一绝对路径。
  - project `.codex/config.toml` 语法损坏时仍可安装 skills-only 插件；不生成或修改 `.codex/config.toml`，不创建或修复共享 marketplace/runtime。
  - user `~/.codex/config.toml` 语法损坏时早失败；不生成 `.agents/skills`，不写 tracking / ledger / AW config / install snapshot bookkeeping，不创建或修复共享 marketplace/runtime。
  - 重复 install 在 tracking 和 ledger scope record 都可用时沿用 ledger skill trigger 偏好刷新 `overridable` repo skill，不重置为 `default`。
  - 重复 install 在 tracking 仍证明当前插件管理 `overridable` repo skill、但 ledger scope record 缺失或不可恢复时，未传 `--skill-trigger` 早拒绝，不重写 `.agents/skills`、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime。
  - 若同一插件声明 required AW config 且同时存在 user-native 外部冲突或 user config 损坏，命令先报 Codex project 安全预检错误，fake config prompt 不调用，project/user config store 不变化。
  - 上一场景显式传入 `--skill-trigger manual|auto|default` 且 tracking identity 完整时允许刷新，并重建 ledger scope record；刷新后的 repo skill trigger 与显式偏好一致。
  - tracking identity 损坏，例如 skill artifact 缺少 `artifactKey` 时，重复 install 即使传入 `--skill-trigger` 也拒绝，不做 path-only 覆盖。
- `aw install <slash-command-plugin> -p codex -s project`
  - 插件源码只维护公共 `slashCommands`，不维护第二套 Codex 专用 skill。
  - fixture 的 command frontmatter 使用顶层 `description`，并同时包含 `claude` / `codex` 分平台块；Codex 生成物使用 `codex.description` 和 `codex.interface.*`，Claude 生成物使用 `claude.allowed-tools` / `claude.argument-hint`，两端字段映射可被断言。
  - fixture 的 `codex.interface.icon_small` / `icon_large` 使用 `./assets/...`；project install 后 `.agents/skills/<command>/assets/...` 存在对应文件，`agents/openai.yaml` 中的路径仍是 `./assets/...`，且 repo 中不出现原始 `slash-commands/` 目录。
  - fixture 通过 `buildConfig.templates` 让 Claude 版本包含 `$ARGUMENTS`，Codex 版本不包含 Claude-only 参数语义；安装后的 repo skill 正文不出现 `$ARGUMENTS` / `$1` / 命令结果填充残留。
  - 成功生成 `.agents/skills/<command>/SKILL.md` 和 `.agents/skills/<command>/agents/openai.yaml`。
  - 生成的 Codex skill 为 manual-only，`policy.allow_implicit_invocation` 为 `false`；安装时传 `--skill-trigger auto` 也不会让该 command 自动触发。
  - tracking manifest 记录 `kind: "skill"`、`artifactKey: "<command>"`，status / uninstall / upgrade prune 都按 repo skill 路径工作。
  - tracking-only 但 ledger scope record 缺失时，重复 install 和显式 upgrade 不因缺少 skill trigger 偏好拒绝；`upgrade --all` 也不会把该 target 记为 `installOptionsUnavailable`。
  - Claude 侧安装同一 `slashCommands-only` 插件后，`aw status -p claude` 不读取不存在的 `claude/skills/<command>/SKILL.md`，也不出现 skill-trigger unknown / drift。
  - 同一源码插件在 Claude 侧安装时生成原生 `/command`，Codex 侧只提供 `$<command>` / skill mention 等价入口，不输出 Codex 原生 `/command` 文案。
- `aw install <slash-command-plugin> -p codex -s user`
  - 插件源码同样只维护公共 `slashCommands`，不维护第二套 Codex 专用 skill。
  - native install 后，local marketplace runtime 中存在 `~/.aw/plugins/<plugin>/codex/skills/<command>/SKILL.md` 和 `agents/openai.yaml`。
  - native install 后，local marketplace runtime 中存在 generated skill 的 `assets/...` 图标文件，`agents/openai.yaml.interface.icon_small/icon_large` 指向合法 `./assets/...`，不引用源码 `slash-commands/assets/...`。
  - 生成的 Codex user scope skill 仍为 manual-only，`policy.allow_implicit_invocation` 为 `false`；安装时传 `--skill-trigger auto` 也不能把公共 slash command 改成 auto。
  - `status` 能把该插件识别为 Codex user scope native 安装，且不会把 generated slash command skill 误报成 project repo-managed artifact。
  - 显式 `upgrade <slash-command-plugin> -p codex -s user` 继续通过 native bundle/runtime 刷新 generated skill，并保持 manual-only 配置。
- `aw install <repo-managed-plugin> --platform auto --scope project` 在最终只解析到 Codex project target 时，成功写 repo-managed artifact，且 `~/.aw` 缺失 / stale / degraded 下的共享 marketplace/runtime 快照完全不变；AW bookkeeping 只按提交结果变化。
- `aw install <repo-managed-plugin> --platform auto --scope project` 在 PATH 缺少 `codex` executable、最终只解析到 Codex project repo-managed target 时，仍成功写 repo-managed artifact；同一 fixture 在 Codex user scope 下继续按平台不可用失败。
- `aw install <repo-managed-plugin> --platform auto --scope project` 在 Claude executable 可用、Codex executable 不可用、插件同时支持 Claude 和 Codex、Codex project repo-managed 可执行、且当前 scope 没有 managed evidence 时，拒绝自动推断并提示显式传 `--platform codex|claude|both`；断言 `.claude/`、`.agents/`、`.codex/`、tracking、ledger、AW config / install snapshot bookkeeping、native config 和共享 runtime 都保持命令前状态。
- `aw install <repo-managed-plugin> --platform auto --scope project` 在上述混合环境但当前 scope 只有完整 Codex project tracking / ledger evidence 时，稳定落到 Codex project repo-managed 路径；不能因为 Claude 可用而改写 Claude project，也不能因为 Codex native unavailable 失败。
- `aw install <repo-managed-plugin> --platform auto --scope project` 在上述混合环境且 Codex project evidence 为 `unknown` 时，拒绝自动推断并保持零写入；错误需说明 evidence unknown 或需要显式平台。
- `aw install <plugin-a> <plugin-b> --platform auto --scope project` 覆盖整组 evidence 聚合：一个插件只有 Claude project managed evidence、另一个只有 Codex project managed evidence 时拒绝自动推断；两个插件都只有 Codex project managed evidence 时统一落到 Codex project repo-managed 路径；任一插件 evidence 为 `unknown` 时整条命令拒绝。所有拒绝用例都断言 `.claude/`、`.agents/`、`.codex/`、tracking、ledger、AW config / install snapshot bookkeeping、native config 和共享 runtime 保持命令前状态。
- `aw install <repo-managed-plugin> --platform both --scope project` 必须先解析真实 targets 并完成 Codex project 写入前预检；若 Codex project 分支预检失败，整条命令失败且不执行 Claude 分支。所有预检通过后，Codex project 分支不初始化共享 runtime，只有同时落到 Claude project 或其它需要 native/runtime 的分支时才允许对应分支写入 local marketplace。
- 增加 install 对照用例：当 `--platform auto|both` 最终解析到 Claude project 或 Codex user 且目标需要 native/runtime 时，仍会按现有规则初始化或修复 `~/.aw`，防止把只读准备误扩散到所有平台。
- `aw install <mcp-plugin> -p codex -s project`
  - 写 `.codex/config.toml [mcp_servers.*]`。
  - tracking manifest 中的 MCP artifact `path` 是 repo-root anchored 绝对 `.codex/config.toml` 路径。
  - status JSON 输出 `skillTriggerApplicability = "none"`，不输出伪造的 `skillTriggerPreference: "default"`。
  - tracking-only 但 ledger scope record 缺失时，重复 install 和显式 upgrade 不因缺少 skill trigger 偏好拒绝；`upgrade --all` 也不会把该 target 记为 `installOptionsUnavailable`。
  - 至少有一个 fixture 使用结构化 `.mcp.json`，覆盖数组、嵌套对象、布尔和数字；install 后 `.codex/config.toml` 中的 `[mcp_servers.<server>]` 及后代子表与 rendered JSON 子树等价。
  - 至少有一个 fixture 使用需要 quoted key 的 server，例如 `acme.tools v1`；install 后写入 `[mcp_servers."acme.tools v1"]`，tracking / status JSON 的 `artifactKey` 原样为 `acme.tools v1`。
  - quoted key fixture 的 status、explicit upgrade replace、`upgrade --all` refresh 和 uninstall 都命中同一 server identity，并保留 `acme`、`acme.tools v1-extra` 等 sibling / 外部 server。
  - uninstall 后删除自己写入的 server 及其后代子表。
- `aw install <instructions-and-mcp-plugin> -p codex -s project`
  - 同一份 `.codex/config.toml` 中同时写入当前插件的 managed `developer_instructions` block 和 `[mcp_servers.*]`。
  - upgrade 同时刷新 instruction、替换 MCP 子树并 prune 旧 MCP server 时，文件中只出现新版受管内容，外部配置保持不变。
  - uninstall 同时删除当前插件的 instruction block 和 MCP server 子树，保留其它插件和用户手写配置。
  - 模拟 `.codex/config.toml` 写入后 tracking / ledger 失败时，instruction block、MCP 子树、tracking manifest 和 ledger 都恢复到命令开始前状态。
- `aw install <multi-mcp-plugin> -p codex -s project`
  - 同一个 `.codex/config.toml` 中写入多个 `[mcp_servers.*]`。
  - tracking manifest 对每个 server 都有独立 `artifactKey`。
  - 多 server fixture 同时覆盖 bare key 和 quoted key，断言 `mergeGeneratedArtifacts()` 不会因为同 path / 同 kind 或 key 中含点号而折叠记录。
  - 手动删除其中一个受管 server 后，status default / verbose / JSON 能报告该 server missing，`generatedArtifacts[]` 和 `repoManagedSessionState.items[]` 都带对应 `artifactKey`，而不是只报告 `config.toml` 存在。
  - 未删除的 sibling server 在同一份 JSON 中仍为 `visible` / `exists: true`，断言不能依赖数组顺序。
  - upgrade 用新版结构化 JSON 子树刷新同名 server 时，会删除旧版独有的后代子表；新版删除或改名 server 时，upgrade prune 会删除该 server 的整棵 TOML 子树，并保留 sibling / 外部 server。
  - uninstall 删除剩余受管 server 的整棵子树，并保留外部手写 server。
  - rollback 覆盖结构化 MCP：模拟写 tracking / ledger 失败后，`.codex/config.toml` 能恢复到安装或升级前的完整嵌套子树。
- `aw install <apps-plugin> -p codex -s project`
  - 早失败。
  - 不写任何 repo-managed artifact。
- `aw status -p codex -s project`
  - 只根据 repo evidence 显示 installed。
  - user native plugin enabled 不会污染 project status。
  - user native 外部同名插件不会污染 project installed evidence，但会在 verbose / JSON 诊断中作为 `externalOwnership` 暴露。
  - 已有 repo-managed project evidence 且命中 user native 外部同名插件时，default 输出继续展示 repo-managed item 状态；cell health、summary health 都是 `needsAttention`，next steps 指向解除外部 native 冲突。
  - user `~/.codex/config.toml` 语法损坏时，skills-only project status 仍显示 tracked skill `visible`、`skillTriggerDrift=no`，但 `externalOwnership.checkState=unknown`，cell health 为 `unknown`；不能把读失败当作 external ownership 不存在。
  - `.codex/config.toml` 语法损坏且当前 status 目标含 MCP / managed `developer_instructions` evidence 时整命令失败；default / verbose / JSON / debug 都给出明确错误通道，stdout 不输出不可解析 JSON。skills-only status 不因无关 TOML 损坏失败。
  - 从 repo 子目录运行仍定位 repo root。
  - 从 repo 子目录运行时，tracking、status JSON、uninstall 和 upgrade prune 都使用同一个绝对 artifact path 合同，不产生 repo 相对路径记录。
  - 覆盖 default / verbose / `--json` / `--debug` 四类输出合同。
  - `-j`、`-j --verbose`、`-j --debug`、`-j --verbose --debug` 的 stdout 都能直接 `JSON.parse`，人类诊断、warning 和 debug 信息不污染 JSON。
  - 只读 catalog 回退 embedded 时，`source=embedded` 和本地 catalog 不可用原因出现在 verbose JSON 或 stderr/debug 的正确通道。
  - 新增 `projectManagedKinds`、`GeneratedArtifactStatus.artifactKey`、`repoManagedSessionState.skills`、`repoManagedSessionState.mcpServers` 和 `repoManagedSessionState.items[]` 时保持 schema 稳定，并保留旧字段兼容读取；JSON 回归覆盖 `skills.state = "not_applicable"` 和 `mcpServers.state = "not_applicable"`。
  - project trust 未开启且内容匹配时，skill item 为 `visible`，MCP / instructions / hooks / rules / agents item 为 `blockedByProjectTrust`，默认输出点名被阻塞的 kind / artifact，health 为 `needsAttention`。
  - project trust 无法判断且内容匹配时，MCP / instructions / hooks / rules / agents item 为 `projectTrustUnknown`，health 为 `unknown`。
  - skills-only project 安装在 `~/.aw` 缺失或 stale、current catalog `source=embedded`、repo trust 未开启或无法判断时，只要 external ownership 检查可判定，status default / verbose / JSON 仍报告 skill item `visible`、`skillTriggerDrift=no`、cell health 和 summary health 都为 `ready`；输出中不出现 project trust warning 或 next step。
  - tracking 缺失但 `.agents/skills/<skill>` 存在时，JSON 中出现 `orphan` / unmanaged evidence，但 discovery 不把它当成 managed installed，uninstall 不会删除它。
  - tracking 缺失但 `.codex/config.toml [mcp_servers.foo]` 存在时，default / verbose / JSON 都显示 MCP orphan / unmanaged evidence；JSON 中该 item 带 `artifactKey`、`tracked: false`、`exists: true`，但 `generatedArtifacts[]` 不包含无 tracking 的 server。
  - tracking 缺失但 `.codex/config.toml [mcp_servers."acme.tools v1"]` 存在时，同样显示 MCP orphan / unmanaged evidence，`artifactKey` 原样为 `acme.tools v1`，不能把点号拆成 nested path。
  - skill trigger 漂移、tracked skill 目录缺失、tracked MCP server 缺失、MCP content drift、MCP orphan 分别有独立用例，覆盖 default / verbose / JSON 中的 `state`、`drift`、`artifactKey`、旧 `skillTrigger*` 聚合字段和 health。
  - instructions / hooks / rules / agents 分别覆盖“tracked 文件存在但内容被手改”为 `drifted` 的 default / verbose / JSON 输出；hooks 还要覆盖 group 缺失、group 内容变化和 hooks JSON 不可解析时的 `unknown` 诊断，并断言 item `state = "unknown"`、`drift = "unknown"`、summary unknown 计数、cell health / summary health 为 `unknown`、next steps 指向修复 hooks JSON。
  - tracking 诊断导致无法建立 item 身份时覆盖另一条 `unknown` 来源，例如 `kind: "mcpServer"` 或 `kind: "skill"` 缺少必要 `artifactKey`；断言 JSON 中保留诊断，human 输出不把它误报成 `missing` / `drifted`。
- discovery / status / historical fallback：
  - Codex project tracking 从 repo 子目录发现时锚定 repo root realpath。
  - 旧 Codex ledger-only `hasRepoManagedArtifacts: true` 不能恢复具体 skill / MCP / hook / rule / agent 能力。
  - user native config evidence 只让 user scope 可见，不让 project scope 误判为 installed。
  - current catalog missing + tracking 仍有 Codex repo skill 时，`aw status -p codex -s project` 仍展示受管 project evidence。
  - current catalog missing + tracking 仍有 Codex repo skill 时，`aw uninstall <plugin> -p codex -s project` 能按 tracking 删除对应 `.agents/skills/<skill>`。
  - current catalog missing + tracking 仍有 Codex MCP server 时，status / uninstall 不退化成 `Unknown plugin`，并且只清理 tracking 证明属于当前插件的 `[mcp_servers.*]`。
  - current catalog missing 或 historical placeholder 场景下，只有 tracking 证明拥有的 MCP server 才能进入 uninstall cleanup；裸 `[mcp_servers.foo]` orphan 只能作为 unmanaged evidence / conflict 诊断，不能补推成历史受管安装。
  - current catalog missing 或 historical placeholder 场景下，tracking 里的 `skill` / `mcpServer` 缺少 `artifactKey` 时，status 报 `unknown` 诊断，uninstall / cleanup deterministic refusal，并断言 repo skill 目录和 `.codex/config.toml` 都未被 path-only 删除。
- CLI entry：
  - 覆盖 PATH 缺少 `codex` executable 且未设置 `AW_FORCE_CODEX_AVAILABLE` 时，Codex project repo-managed `install`、显式 `upgrade` 和 `upgrade --all` 的 stdout/stderr/退出码；同一环境下 Codex user scope 或 native-only target 仍报平台不可用。
  - 覆盖 PATH 缺少 `codex` executable 且未设置 `AW_FORCE_CODEX_AVAILABLE` 时，interactive `install -i -p codex -s project` 不被“当前环境没有检测到可用平台”拦截，fake prompt 能看到并选择 Codex project repo-managed 候选。
  - 覆盖 PATH 同时缺少 `codex` 和 `claude` executable 且未设置任何强制可用环境变量时，interactive `install -i --scope project` 在默认 `--platform auto` 下仍能显示并安装 Codex project repo-managed 候选；同一环境下 `--scope user` 或 native-only / 无 project managed kind 插件仍按没有可用平台或不可安装内容失败。
  - 覆盖 PATH 缺少 `codex` executable、当前 project scope 已有 Codex repo-managed evidence 时，interactive `uninstall -i --scope project` / `upgrade -i --scope project` 的 platform prompt 仍包含 Codex，并能继续进入 plugin prompt 或 upgrade mode prompt。
  - 覆盖 Claude executable 可用、Codex executable 不可用的混合环境：interactive install / uninstall / upgrade 的 platform prompt 仍暴露 Codex project repo-managed 选项，不把 Codex 误判成不可选平台。
  - 覆盖 `codex + project` 下 apps 插件、native-only 插件和无 project managed kind 插件的显式校验错误、stdout/stderr 和退出码。
  - 覆盖 `codex + project` 下 user-native 外部同名插件对 install / explicit upgrade 的显式 refusal、交互候选处理和 fake prompt 旁路拒绝；同时覆盖 uninstall 在已有 project managed evidence 时允许清理并输出 warning。
  - 覆盖 `codex + project` 下 user `~/.codex/config.toml` 语法损坏时，install / explicit upgrade 的 deterministic refusal，以及 status / uninstall 继续基于 repo evidence 工作的 stdout/stderr/JSON 通道。
  - 覆盖 `codex + project` 下 repo `.codex/config.toml` 已有同名 unmanaged MCP server 的 install / explicit upgrade deterministic refusal；断言拒绝发生在 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 和共享 runtime 写入前。
  - 覆盖显式 `install --platform both|auto --scope project` 的 mixed refusal：Codex project target 因 user config 损坏、外部同名 native 冲突或其它写入前预检失败时，整条命令失败，不执行 Claude target，不返回 `skipped[]`，CLI 不输出部分成功 receipt。
  - 覆盖显式 `upgrade --platform both|auto --scope project` 的 mixed refusal：Codex project target 因 user config 损坏、`overridable` tracking-only 偏好缺失或其它写入前预检失败时，整条命令失败，不执行其它 target，不返回 `skipped[]`，CLI 走错误退出。
  - 覆盖 interactive install / uninstall / upgrade 的候选过滤，fake prompt 返回候选外插件时仍在 runtime 层拒绝。
  - 覆盖 `--skill-trigger` 在 install、显式 upgrade 中的透传，以及 `upgrade --all --skill-trigger` / `upgrade -a -t` 在入口层确定性拒绝。
  - 覆盖 Codex project install / upgrade 的 stdout 不含 native marketplace / plugin enabled receipt。
  - 覆盖 `aw install|uninstall|upgrade ... -p codex -s project` 的 warning 不再出现旧的 user native fallback 文案。
  - 覆盖 `aw status -p codex -s project` 默认输出在纯 repo-managed 正常场景下，不把 user marketplace 注册/缺失状态当作主诊断。
  - 覆盖 `aw upgrade --all --platform both --scope project` 的混合执行：user `~/.codex/config.toml` 损坏时，Codex project target 逐项 skipped，Claude project target 继续执行；由 Codex project skip 造成的分支不得创建、修复或重放共享 runtime，也不得为 skipped target 写 AW bookkeeping。
  - 覆盖同类混合 evidence 在 `aw upgrade --all --platform auto --scope project` 下的相反结果：平台推断阶段拒绝 auto，要求显式 `--platform`，不执行 Claude target，不产生 Codex project target-level `skipped[]`，也不写 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping、native config 或共享 runtime。
  - 覆盖 `upgrade --all` 全部 stable skipped code 的 CLI 集成矩阵：`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`trackingIntegrityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict` 都必须在 direct command 返回值、human receipt 和 CLI 退出码中有正向断言。
  - 覆盖同一 `upgrade --all` mixed 命令中 Codex project tracking-only `overridable` target 因 ledger scope record 缺失被 skipped，Codex user 或 Claude target 仍按自身规则完成或失败，最终 direct command 返回值和 human receipt 能同时表达 skipped 与 succeeded / failed target。
  - 覆盖同一 `upgrade --all` mixed 命令中 Codex project tracking-only `none` / `fixed` target 不因 ledger scope record 缺失被 skipped。
  - 覆盖同一 `upgrade --all` mixed 命令中 Codex project target 因 current catalog 新版含 `apps` 或没有 project managed kind 被 skipped，direct command 返回 `code: "catalogNotProjectInstallable"`，human receipt 点名该 target 被跳过，其它 target 继续。
  - 覆盖同一 `upgrade --all` mixed 命令中 Codex project target 因无 tracking 的同名 MCP orphan 被 skipped，direct command 返回 `code: "unmanagedRepoArtifactConflict"`，human receipt 提示需要人工处理该 repo artifact，其它 target 继续。
  - 覆盖 `upgrade --all` CLI 退出码：mixed succeeded + skipped 退出 `0`；全部 target skipped 且没有任何成功升级时退出 `1`。
- interactive install：
  - 保留共享 `resolveInstallPlatforms()` 旧合同：`marketplace.policy.products` 过滤、`both` 下单平台插件禁用 / 默认选择、显式多插件名共同兼容平台交集、无共同兼容平台时的 dispatch 前失败，以及 fake prompt 返回不兼容平台时的 runtime 拒绝都要有回归。
  - Codex project 候选包含 `git-commit`。
  - Codex project 候选包含 slashCommands-only 插件，因为它会生成 repo skill。
  - 缺少 `codex` executable 时，`-p codex -s project -i` 仍展示 repo-managed 候选并可完成安装；Codex user scope 或 native-only target 仍按平台不可用失败。
  - 同时缺少 `codex` 和 `claude` executable 时，默认 `-s project -i` / `--platform auto` 仍展示并可安装 Codex project repo-managed 候选；同一空平台环境下，user scope 或 native-only / 无 project managed kind 候选不能借 Codex project 分流绕过“没有可用平台 / 不可安装”失败。
  - Claude executable 可用、Codex executable 不可用时，平台 prompt 仍包含 Codex project repo-managed 选项；测试只锁住 Codex 可见性，不引入新的 `both` 展示要求。
  - apps-only 插件在无插件名交互安装里不进入候选；apps-mixed 插件进入候选但 disabled，并显示 Codex project scope 不支持 apps、需要改用 user scope 或拆分插件的原因。fake prompt 返回 apps-mixed candidate 仍必须被 runtime validation 拒绝；显式点名 apps-only / apps-mixed 都早失败且不写入。
- uninstall：
  - 显式 `aw uninstall <plugin> -p codex -s project` 只删除当前插件 tracking 到的 repo skill / MCP / extensions，不修改 user native plugin state 或共享 `~/.aw` skill runtime。
  - PATH 缺少 `codex` executable 且未设置 `AW_FORCE_CODEX_AVAILABLE` 时，显式 `aw uninstall <plugin> -p codex -s project` 仍按 repo-managed evidence 清理；同一环境下需要 Codex native runner 的 user-scope uninstall 仍按平台不可用失败。
  - `aw uninstall <plugin> --platform auto --scope project` 在只有完整 Codex project repo-managed evidence 时稳定落到 Codex；当前 scope 同时存在 Claude managed evidence 与 Codex project repo-managed evidence 时拒绝自动推断；任一候选平台 evidence 为 `unknown` 时也拒绝自动推断。
  - project `.codex/config.toml` 语法损坏且当前 scope tracking 含 MCP / managed `developer_instructions` 时，显式 uninstall 在删除 config-backed artifact、写 tracking 或写 ledger 前 fail fast，并保持 tracking / ledger 原状；skills-only uninstall 不因无关 TOML 损坏失败。
  - tracking 中 `kind: "skill"` 或 `kind: "mcpServer"` 缺少 `artifactKey` 时，显式 uninstall deterministic refusal；不得按 `path` 删除 `.agents/skills` 目录或共享 `.codex/config.toml` 内容。
  - `.codex/config.toml` 只有无 tracking 的同名 `[mcp_servers.foo]` 时，显式 uninstall 不删除该 server；若当前 scope 也没有其它 managed evidence，则按 unmanaged scope 处理。
  - user-native 外部同名插件存在时，显式 uninstall 仍允许清理当前 project scope 已有 tracking / ledger 证明的 repo-managed artifact；清理完成后保留 warning / next step，提示外部 native 同名插件仍存在。若当前 scope 没有 managed evidence，则不删除任何 user native state，并按“当前 scope 未受管”处理。
  - user `~/.codex/config.toml` 语法损坏时，显式 uninstall 在已有 project repo-managed evidence 时仍清理 AW 自己的 repo artifacts，并输出 external ownership / project trust unknown 诊断；没有 project repo-managed evidence 时不删除任何 user native state。
  - interactive uninstall 从 repo-managed project evidence 找到 skills-only / mcp-only 插件。
  - PATH 缺少 `codex` executable 时，interactive uninstall 仍从 Codex project repo-managed evidence 暴露 Codex 平台和对应插件候选。
  - interactive uninstall 在 project scope 已有 repo-managed evidence 且 user-native 外部同名插件存在时，仍把该 project 插件列为可卸载候选；执行后只清理 AW 管理的 repo artifact，并输出外部 native 同名插件仍存在的 warning / next step。
  - interactive uninstall 不把只有 MCP orphan / unmanaged evidence 的插件列为可卸载候选。
  - mixed `user + project` 状态下，卸载 project 不删除 user native ref；卸载 user 不因为剩余 project record 保留或重选共享 Codex runtime。
  - mixed `user + project` 加外部同名 user-native 冲突时，project uninstall 仍只按 project tracking 清理 repo artifact，不触碰 user/native state；user uninstall 仍按 user scope 规则处理，不误删 project artifact。
- upgrade：
  - 显式 `aw upgrade <plugin> -p codex -s project` 刷新 repo-managed skill / MCP / extensions，不触发 native marketplace add，不修复共享 marketplace/runtime。
  - PATH 缺少 `codex` executable 且未设置 `AW_FORCE_CODEX_AVAILABLE` 时，显式 `aw upgrade <plugin> -p codex -s project` 仍按 repo-managed 目标执行；Codex user scope upgrade 仍按平台不可用失败。
  - project `.codex/config.toml` 语法损坏且本次 upgrade 需要读取或改写 config-backed artifact 时，显式 upgrade 在 uninstall、stale prune、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入前 fail fast，并保持旧 repo-managed 安装原状；skills-only upgrade 不因无关 TOML 损坏失败。
  - `.codex/config.toml` 有无 tracking 的同名 MCP orphan 时，显式 upgrade 和 `upgrade --all` 都不能覆盖或删除该 server；显式 upgrade deterministic refusal，`upgrade --all` 跳过并报告需要人工处理。
  - repo tracking 仍有 Codex project `overridable` skill evidence 但 ledger scope record 缺失或不可用时，显式 upgrade 未传 `--skill-trigger` 早拒绝且不改 repo artifact；传入 `--skill-trigger` 且 tracking 身份完整时可刷新并重建 ledger scope record。
  - repo tracking 只有 `mcp-only` / `slashCommands-only` / 全部 fixed skill evidence 且 ledger scope record 缺失或不可用时，显式 upgrade 不因偏好缺失拒绝；仍会执行 external ownership、config、tracking identity、catalog compatibility 等其它 preflight。
  - user-native 外部同名插件存在时，显式 upgrade 早失败，不刷新或清理 repo artifact；`upgrade --all` 对该 target 记录 skipped，code 为 `externalOwnershipPresent`。
  - user config 可解析但 external ownership / project trust 无法可靠判定时，显式 upgrade 早失败，不刷新或清理 repo artifact；`upgrade --all` 对该 target 记录 skipped，code 为 `externalOwnershipUnknown`。
  - user `~/.codex/config.toml` 语法损坏时，显式 upgrade 早失败，不刷新或清理 repo artifact；`upgrade --all -p codex -s project` 将所有 Codex project target 标记为 skipped，code 为 `codexProjectUserConfigUnreadable`，不刷新或清理任何 repo artifact，并在最终输出中逐项列出 skipped 目标和原因。
  - tracking 中 `kind: "skill"` 或 `kind: "mcpServer"` 缺少 `artifactKey` 时，显式 upgrade 在写新版 artifact、stale prune、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 前 deterministic refusal；`upgrade --all` 对该 target 记录 skipped，code 为 `trackingIntegrityError`，不做 path-only cleanup。
  - current catalog 新版含 `apps` 或没有 project managed kind 时，显式 upgrade 早失败且保留旧 repo-managed 文件；`upgrade --all` 对同一 target 记录 `catalogNotProjectInstallable`，不刷新、不卸载、不 prune 旧 artifact。
  - capabilityChanged 下新版本不再满足 Codex project 可安装性时，命令早失败且保留旧 repo-managed 文件。
  - capabilityChanged 下 uninstall 已成功、新版 install 写 repo skill 后失败时，旧 repo skill、旧 tracking manifest 和旧 ledger record 都恢复到 upgrade 开始前状态。
  - capabilityChanged 下 uninstall 已成功、新版 install 已提交 `.codex/config.toml`，随后 tracking 或 ledger 写入失败时，旧 `.codex/config.toml`、旧 repo skill / extensions、旧 tracking manifest 和旧 ledger record 都恢复到 upgrade 开始前状态。
  - capabilityChanged 下旧版本同时包含 skill、MCP server 和 managed instructions 时，模拟新版 install 晚失败，确认三类旧 repo-managed artifacts 一起恢复，不能只恢复其中一种。
  - 旧版本有两个 repo skills，新版本删除或改名其中一个 skill 后，upgrade 会删除旧目录，不留下 orphan。
  - 旧版本声明多个 MCP servers，新版本删除或改名其中一个 server 后，upgrade 只保留新版集合，并继续保留用户手写或其它插件管理的 server。
  - 旧版本声明 quoted-key MCP server（如 `acme.tools v1`）时，新版刷新、删除或改名该 server 都按原始 `artifactKey` 命中同一 TOML quoted key identity，不误删 `acme`、`acme.tools` 或其它 sibling。
  - skill / MCP prune 发生在新版 artifact 写入成功之后；模拟 prune 或 tracking 写入失败时，旧文件和旧 tracking 能回滚。
  - `aw upgrade --all -p codex -s project` 能从 project ledger/tracking 发现 skills-only / mcp-only 插件，并使用只读 catalog。
  - PATH 缺少 `codex` executable 且未设置 `AW_FORCE_CODEX_AVAILABLE` 时，`aw upgrade --all -p codex -s project` 仍能从 project ledger/tracking 发现 repo-managed target；同一环境下需要 Codex native runner 的 user-scope target 仍被平台可用性检查拦住。
  - `aw upgrade --all -p codex -s project` 从 legacy AW bookkeeping 或 install snapshot 发现候选，但当前 project scope 没有完整 ledger managed scope record 或完整 repo tracking evidence 时，将该 target skipped，code 为 `scopeNotInitialized`；plain absence、orphan / unmanaged evidence 不能进入候选。
  - `aw upgrade --all -p codex -s project` 从 tracking 发现 `overridable` target 但 ledger scope record 缺失或不可用时，将该 target skipped，code 为 `installOptionsUnavailable`，并断言没有 repo skill 被按 `default` 重写、没有 stale artifact 被 prune。
  - `aw upgrade --all -p codex -s project` 从 tracking 发现 `mcp-only` 或 `slashCommands-only` target 但 ledger scope record 缺失或不可用时，不因偏好缺失 skipped / refused。
  - `aw upgrade --all -p codex -s project` 发现 `.codex/config.toml` 中存在无 tracking 的同名 MCP orphan 时，将该 target skipped，code 为 `unmanagedRepoArtifactConflict`，并断言没有覆盖、删除或认领该 server。
  - `aw upgrade --all -p codex -s project` 发现 project `.codex/config.toml` 语法损坏，且同一批 target 同时包含 config-backed target 和 skills-only target 时，将 config-backed target skipped，code 为 `projectConfigUnreadable`，skills-only target 继续执行；direct command 返回值、human receipt 和文件系统快照都要断言 skipped target 没有刷新、prune、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入。
  - `aw upgrade --all --platform both --scope project` 在 Codex project config-backed target 因 project TOML 损坏被 skipped 时，Claude 或其它不受影响 target 继续执行；receipt 同时展示 succeeded / skipped，CLI 退出码按 mixed succeeded + skipped 固定为 `0`。
  - `aw upgrade --all -p codex -s project` 全部 target 都因 project `.codex/config.toml` 损坏被 skipped 时，direct command 返回 `skipped[].code = "projectConfigUnreadable"`，CLI human receipt 输出“未升级任何插件，已跳过 ...”，退出码固定为 `1`。
  - `aw upgrade --all -p codex -s project` 在 current catalog 可解析、但 tracking / ledger historical fallback 发现的已安装插件已不在 current catalog 时，将该 target skipped，code 为 `catalogNotCurrent`；direct command 返回值、human receipt 和文件系统快照都要断言旧 repo-managed artifacts 未被刷新、删除或认领。
  - `aw upgrade --all --platform both --scope project` 遇到 `catalogNotCurrent` 的 Codex project target 时，跳过该 target 并继续处理其它不受影响 target；receipt 同时展示 succeeded / skipped，退出码按 mixed succeeded + skipped 固定为 `0`。
  - current catalog 整体不可加载时，`upgrade --all` 作为 target 外 fatal error 失败，不返回 `skipped[]`，不执行任何 target，也不写 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping、native config 或共享 runtime。
  - `aw upgrade --all --platform auto --scope project` 在只有 Codex project tracking-only `overridable` target、没有 Codex ledger scope record 时，仍先推断到 Codex，再把该 target skipped，code 为 `installOptionsUnavailable`；输出不能表现为“没有 Codex target”或“双平台无法唯一推断”。
  - `aw upgrade --all --platform auto --scope project` 在只有 Codex project tracking-only `none` / `fixed` target、没有 Codex ledger scope record 时，仍先推断到 Codex，并继续执行其它 preflight；输出不能把它误报为 install options unavailable。
  - `aw upgrade --all --platform auto --scope project` 在 Codex project tracking-only target 与 Claude project managed target 同时存在时，拒绝 auto 推断并要求显式平台，不得只执行 Claude 或只执行 Codex。
  - project `.codex/config.toml` 语法损坏且 `upgrade --all -p codex -s project` 发现待升级目标含 config-backed artifact 时，只跳过受影响的 config-backed target，不刷新、prune、tracking、ledger、AW config / install snapshot bookkeeping 或共享 runtime 写入该 target；只含 skills-only 目标时不因无关 TOML 损坏失败。
  - 显式 `aw upgrade <plugin> --platform auto --scope project` 在最终只解析到 Codex project target 时，不初始化、修复或重放共享 runtime，并在 preflight 前保持 repo artifact、tracking、ledger、AW config / install snapshot bookkeeping 原状。
  - 显式 `aw upgrade <plugin> --platform auto --scope project` 在 Claude executable 可用、Codex executable 不可用、插件同时支持 Claude 和 Codex、Codex project repo-managed 可执行、且当前 scope 没有 managed evidence 时，拒绝自动推断并提示显式平台；断言旧 repo artifact、Claude project 文件、tracking、ledger、AW config / install snapshot bookkeeping、native config 和共享 runtime 都保持命令前状态。
  - 显式 `aw upgrade <plugin> --platform auto --scope project` 在上述混合环境但当前 scope 只有完整 Codex project tracking / ledger evidence 时，稳定落到 Codex project repo-managed 路径；不能因 Claude 可用改走 Claude，也不能因 Codex native unavailable 失败。
  - 显式 `aw upgrade <plugin> --platform auto --scope project` 在上述混合环境且任一候选平台 evidence 为 `unknown` 时，拒绝自动推断并保持零写入；错误需说明 evidence unknown 或需要显式平台。
  - 显式 `aw upgrade <plugin-a> <plugin-b> --platform auto --scope project` 覆盖整组 evidence 聚合：一个插件只有 Claude project managed evidence、另一个只有 Codex project managed evidence 时拒绝自动推断；两个插件都只有 Codex project managed evidence 时统一落到 Codex project repo-managed 路径；任一插件 evidence 为 `unknown` 时整条命令拒绝。所有拒绝用例都断言旧 repo artifact、Claude project 文件、tracking、ledger、AW config / install snapshot bookkeeping、native config 和共享 runtime 保持命令前状态。
  - 显式 `aw upgrade <plugin> --platform both --scope project` 先解析真实 targets 并完成 Codex project 写入前预检；若 Codex project 分支预检失败，整条命令失败且不执行 Claude 分支。所有预检通过后，Codex project 分支保持只读 catalog，Claude project 或其它需要 native/runtime 的分支才允许触发 local marketplace 初始化。
  - 增加 explicit upgrade 对照用例：当 `--platform auto|both` 最终解析到 Claude project 或 Codex user 且目标需要 native/runtime 时，仍会执行必要的写入型 local marketplace 准备。
  - interactive upgrade 从 repo-managed project evidence 找到候选，并沿用 project scope 的 skill trigger 偏好解析规则。
  - PATH 缺少 `codex` executable 时，interactive upgrade 仍从 Codex project repo-managed evidence 暴露 Codex 平台和对应插件候选；若进入 upgrade-all 模式，后续 target skip / refusal 仍按 `upgrade --all` 合同表达。
- runtime-env：
  - direct command 与 `runCli(..., { env })` 两条入口都覆盖 Codex project install / status / upgrade。
  - 只读 catalog、repo skill 路径、MCP 配置路径、tracking manifest、ledger/current catalog 读取都严格使用注入 env，不回落到 `process.env`。
- skill trigger project 隔离：
  - repo A 安装 `manual`，repo B 安装 `auto`，两边 `.agents/skills` 各自不同。
  - `~/.aw` pristine/runtime 不因 Codex project install 改变。
  - `aw init --force` / stale rebuild 不把 Codex project scope trigger replay 到共享 `~/.aw`。
- rollback：
  - 模拟 MCP 写入失败或 skill 冲突，确认已写 repo 文件回滚。
  - 模拟 install 的 repo skill / MCP 已写入成功后 tracking manifest 写入失败，确认 `.agents/skills`、`.codex/config.toml [mcp_servers.*]` 和 tracking manifest 都恢复到安装前状态，`installed.json` 进入明确 degraded 状态。
  - 模拟同一插件同时写 managed `developer_instructions` 和 MCP server 后，在 tracking 或 ledger 写入阶段失败，确认整份 `.codex/config.toml` 恢复 baseline，不能只恢复其中一类配置。
  - 模拟 install 的 tracking manifest 已写入成功后 `installed.json` 写入失败，确认 repo artifacts 和 tracking manifest 都恢复到安装前状态，最终 ledger 以 degraded 状态记录这次晚失败；如果 degraded 写入也失败，错误同时包含原始失败和 degraded 写入失败。
  - 模拟 capabilityChanged 显式 upgrade 的 uninstall 已成功、新版 install 写 repo skill 后失败，确认旧 skill 目录、tracking manifest 和 ledger 恢复到升级前状态。
  - 模拟 capabilityChanged 显式 upgrade 的 uninstall 已成功、新版 install 提交 `.codex/config.toml` 后在 tracking / ledger 写入阶段失败，确认旧 `.codex/config.toml`、旧 repo artifacts、tracking manifest 和 ledger 都恢复到升级前状态。
  - 模拟 capabilityChanged 显式 upgrade 旧版本同时包含 skill + MCP / managed instructions，新版 install 晚失败时三类旧产物一起恢复；若旧安装恢复失败，错误信息点名 repo artifacts、`.codex/config.toml`、tracking manifest 或 `installed.json` 中的具体风险面。
  - 模拟 uninstall 删除 repo skill 目录后失败，确认 skill 目录、tracking manifest 和 ledger 恢复到卸载前状态。
  - 模拟 uninstall 删除 MCP server 后在写 tracking 或 ledger 时失败，确认 `.codex/config.toml [mcp_servers.*]`、tracking manifest 和 ledger 恢复或进入明确 degraded 状态。
  - 模拟 uninstall / upgrade prune 同时删除 managed instruction block 和 MCP server 后失败，确认 `.codex/config.toml` 恢复到命令开始前的完整内容。

### Smoke / 回归

完成实现后至少运行：

```bash
pnpm test:unit
pnpm test:integration
pnpm test:smoke:build
pnpm test:smoke:pack
pnpm test:smoke:plugin-scripts
```

这轮改造一定会改变 bundle layout、npm tarball 发布面，并接入 lifecycle / config snapshot 合同；`pnpm test:smoke:pack` 和 `pnpm test:smoke:plugin-scripts` 都是固定验收项，不能写成“按需补跑”。

smoke 层必须新增真实 build / pack 的 `slashCommands` 回归，覆盖编译后的 bundler、`prepack` 和 tarball 解包路径：

- `pnpm build` 后，`packages/cli/plugins-dist` 中 Claude manifest 的 `commands` 指向 generated `commands` 目录，Codex manifest 的 `skills` 指向 generated `skills` 目录。
- build 产物中存在对应 Claude command Markdown、Codex generated `SKILL.md` 和 manual-only `agents/openai.yaml`。
- smoke fixture 要使用新的 frontmatter schema：顶层 `description`、`claude` 分平台字段和 `codex.interface` 字段都要进入 generated 产物；Codex 产物不得包含 Claude-only 参数占位或命令结果填充。
- smoke fixture 的 `codex.interface.icon_small` / `icon_large` 使用 `./assets/...`，并断言 `pnpm build` 后每个 generated Codex skill 内包含对应 `assets/...` 文件，`agents/openai.yaml` 不引用源码目录或非法 `icons/...` 路径。
- build 产物中不得出现原始 `slash-commands/` 源目录，即使源码 `buildConfig.fileRules` include 命中该目录也不能复制进 platform bundle。
- `pnpm pack:cli` 后解包 tarball，仍能看到同样的 generated Claude commands / Codex skills 布局、Codex generated skill 图标资源和合法 `./assets/...` 引用，并确认 tarball 内不包含原始 `slash-commands/` 源目录。
- 该 smoke 可以沿用现有真实 compiled bundler / tarball 测试模式，用临时 fixture 注入 `slashCommands` manifest 和源码目录；如果改用仓库常驻样例，也必须断言同一组发布面合同。

## 文档更新计划

实现完成后同步更新：

- `README.md`
  - 去掉“写命令在需要时自动同步本地 marketplace”这类会被 Codex project-only 命令推翻的笼统表述。
  - 明确 Codex project repo-managed install / upgrade 不依赖、不会初始化或修复共享 marketplace/runtime；只有 user/native runtime 或 Claude 等需要共享 marketplace 的目标才会触发本地 marketplace 准备。`installed.json`、install snapshot 和可选 user config store 作为 AW bookkeeping 单独说明。
  - 说明 `aw init`、user scope native 注册和 project-only repo-managed 写入之间的边界。
  - 补充 project scope 的新落点：`.agents/skills`、`.codex/config.toml` managed instructions / MCP，以及 apps 暂不支持。
- `docs/plugin-installation.md`
  - 改掉“Codex 无论 scope 如何 native 注册始终 user scope”的旧 project 描述。
  - 明确 user scope 和 project scope 新矩阵。
  - 说明 `.agents/skills`、`.codex/config.toml [mcp_servers]`、apps 拒绝策略。
  - 说明公共 slash command 在 Codex 侧安装为 manual-only skill，显式触发名不是原生 `/command`。
- `docs/architecture.md`
  - 更新三层分发模型里 Codex project scope 的 repo-managed 边界。
  - 更新 discovery/status 的真值来源。
  - 补充公共 `slashCommands` 构建为 Claude commands / Codex skills 的分发模型。
- `docs/plugin-authoring.md`
  - 说明 Codex project scope 下 skills / MCP 可 repo-managed，apps 不支持。
  - 提醒 skill 名在 repo `.agents/skills` 中保留原名，作者应避免通用同名冲突。
  - 新增公共 `slashCommands` 作者入口，替代“Claude commands + Codex skill”两套等价入口的维护方式；写清 frontmatter 的公共 `description`、`claude` / `codex` 分平台块、首版不支持子目录命名空间、`codex.interface.icon_small/icon_large` 只能引用 `./assets/...` 并由 build 复制到 generated skill，以及 Codex 渲染结果不能包含 Claude-only 参数/命令填充语义。
  - 删除旧 Claude-only `commands` 作者配置说明；源码层只认公共 `slashCommands`。
  - MCP authoring 说明 server key 可以是需要 TOML quoted key 的任意 JSON 属性名；文档示例要明确 `artifactKey` 保存原始 key，`.codex/config.toml` 写成 `[mcp_servers."..."]` 时仍是单个 server identity。
- `docs/testing.md`
  - 更新 Codex project scope 候选过滤、native runner、command native bookkeeping、status JSON/debug 通道和 runtime env 测试预期。
  - 拆开 `aw config configure --scope` 与 install / upgrade required config preflight 的 `selectedScope` 合同：前者的显式 scope 是硬约束，prompt 不能改写层；后者允许 prompt 选择写入层，但同一插件同一 schema source 仍只 prompt 一次、只写一次。
  - 增加公共 slash command 构建、安装、manual-only Codex skill、Claude 原生命令、frontmatter 映射、Claude-only 语法拒绝和嵌套命令拒绝的回归说明。
  - 增加 MCP quoted key 的 install / status / upgrade / uninstall 全链路身份回归说明。
- `docs/coding-conventions.md`
  - 更新 `GeneratedArtifact` / tracking identity 文档，写清 `kind: "skill" | "mcpServer"`、`artifactKey`、绝对 artifact path 和 path-only cleanup 拒绝规则。
  - 更新 `ResolvedInstallOptions` 为带 `skillTriggerApplicability` 的判别模型：`overridable` 才需要可恢复偏好，`none` / `fixed` 不伪造 default 偏好。
  - 更新 `RepoManagedSessionStateReport`，补充 `skills` / `mcpServers` summary、item-level 状态、`not_applicable` 和 `unknown` 的语义。
  - 更新 `scopeInitialized` 兼容字段说明，避免贡献者继续把 Codex native availability 当作 Codex project repo-managed 可执行性的前置条件。
- `.agents/skills/create-agent-workflows-plugin/references/*.md`
  - 同步作者工具参考文档中 scope、skill trigger、MCP 和 apps 的描述。
  - 更新 `skills-and-triggers.md` / `claude-only-capabilities.md` / `build-config-spec.md` 中“commands 只能是 Claude 专属”的旧说法：源码层旧 `commands` 作者入口移除，统一改为公共 `slashCommands`，Claude 原生 `commands` 只作为 build 输出；同时补上分平台 frontmatter schema、Codex icon 资源只能使用 `./assets/...` 的复制合同，以及 Claude-only 语法只能出现在 Claude 渲染结果里的规则。
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js` 和隐藏示例夹具
  - 接受 `slashCommands`、校验命令目录 / 命名 / frontmatter schema / icon 资源路径和缺文件 / 模板渲染后的生成合同。
  - 拒绝旧 `manifestOverrides.claude.commands`、旧式 `commands` 字段，以及只为旧 `commands/` 配置的 Claude-only fileRules。
  - 将 `references/.examples/code-review/` 改为公共 `slashCommands` 示例，并补 authoring-tool 集成测试；负向夹具覆盖嵌套命令、缺失 `description`、Codex 渲染结果残留 `$ARGUMENTS` / 命令结果填充、源码试图配置 `codex.policy`、非法 icon 路径和缺失 icon 文件。

## 验收标准

- `aw install git-commit -p codex -s project` 成功，并写入 repo `.agents/skills/git-commit`。
- 上述命令不调用 `codex plugin marketplace add`。
- 上述命令不写用户级 `~/.codex/config.toml [marketplaces]` 或 `[plugins]`。
- 上述命令在 `~/.aw` 缺失、stale、布局损坏或 ledger degraded 时，不创建、不修复、不替换共享 marketplace/runtime；成功提交后只允许通用 AW bookkeeping 发生变化。
- 新 Codex 会话在该 repo 中能发现 repo skill。
- 离开该 repo 后，看不到该 project scope 安装带来的 skill / MCP / instructions / hooks / rules / agents。
- 插件作者可以用公共 `slashCommands` 维护一份手动触发工作流；Claude 安装后得到原生 `/command`，Codex project 安装后得到 repo `.agents/skills/<command>` manual-only skill。
- 公共 `slashCommands` 源码 schema 明确且被测试锁住：必填公共 `description`，平台专属字段放入 `claude` / `codex` 块，子目录命名空间早失败，Codex 渲染结果不能残留 Claude-only 参数占位或命令结果填充。
- 公共 `slashCommands` 的 Codex 图标资源合同被测试锁住：`icon_small` / `icon_large` 只能写 `./assets/...`，build / project install / user install / smoke pack 都能看到 generated skill 内的 `assets/...` 文件和合法 `openai.yaml` 路径；非法路径和缺文件在写 bundle 或 repo artifact 前失败。
- 同一公共 `slashCommands` 插件安装到 Codex user scope 后，native runtime bundle 中得到 `~/.aw/plugins/<plugin>/codex/skills/<command>` manual-only skill，status / upgrade 能持续识别该 generated skill。
- Codex 侧公共 slash command 等价 skill 不会被模型自动触发，`--skill-trigger auto` 不能把它改成 auto；status / tracking / uninstall / upgrade 都按 `kind: "skill"` + `artifactKey: "<command>"` 处理。
- Codex project scope MCP 插件写入 `.codex/config.toml [mcp_servers.*]`，卸载只清理 AW 管理的 server。
- Codex project scope MCP writer 完整透传 rendered `.mcp.json` 中 TOML 可表达的 `mcpServers.<server>` JSON 子树；结构化字段、数组、布尔、数字和 nested `tools.*` 子表不会被写坏或漏写。
- Codex project scope MCP refresh / prune / uninstall 会按 server key 清理整棵 `[mcp_servers.<server>]` TOML 子树，不留下旧 nested table，也不影响 sibling server 或外部配置。
- MCP server key 支持 TOML quoted key：包含点号、空格、斜杠、大小写或 Unicode 的 server key 在 install / status / upgrade / uninstall / drift comparator 中都保持同一个原始 `artifactKey` 身份，不被拆成 TOML nested path，也不误删 sibling server。
- Codex project scope 只有在 install / status / uninstall / explicit upgrade / `upgrade --all` 实际需要读取或改写 `.codex/config.toml` 时，才受损坏的 `.codex/config.toml` 影响；install / status / uninstall / explicit upgrade 早失败，`upgrade --all` 将受影响的 config-backed target 记为 `skipped[]` / `projectConfigUnreadable` 并继续处理同批 skills-only target 或 mixed 命令中的其它 target。config-backed 路径不会留下半安装、半卸载或半升级状态，也不会创建或修复共享 marketplace/runtime；skills-only 路径不因无关 TOML 损坏失败。
- 同一插件同时管理 `.codex/config.toml` 里的 `developer_instructions` 和 `mcp_servers.*` 时，install / upgrade / uninstall / prune 使用同一个文档级事务；任意失败都恢复整份 config baseline，不留下只写 instruction 或只写 MCP 的半状态。
- 同一插件声明多个 Codex project MCP servers 时，tracking 与 `status --json` 都以 `artifactKey` 区分每个 server，status / uninstall / rollback 都能精确处理其中一个 server。
- Codex project scope 的 tracking manifest、`generatedArtifacts[]` 和 `repoManagedSessionState.items[]` 都使用绝对 artifact path；`.agents/skills/<skill>`、`.codex/config.toml` 只作为 repo 内位置或 human display。
- Codex project status 的 `repoManagedSessionState` 能稳定表达 skill / MCP / instructions / hooks / rules / agents 的 `visible`、`missing`、`drifted`、`orphan`、`blockedByProjectTrust`、`projectTrustUnknown` 和 `unknown` 状态；`skills` / `mcpServers` summary 能用 `not_applicable` 区分未声明 kind；MCP、instructions、hooks、rules、agents 的 `drifted` 都有明确比较基线和回归测试。
- Codex project status 继续输出稳定的 `skillTriggerApplicability`；`none` 不伪造 default 偏好，`fixed` 表达固定 runtime drift 但不输出可选偏好集合，`overridable` 才输出用户可切换偏好相关的 `skillTriggerPreference` / `skillTriggerRuntimeMatches` 聚合；多 skill mixed、部分 missing、embedded fallback 和 `allowInstallOverride` 场景都有明确聚合语义。
- `.codex/config.toml` 中存在无 AW tracking 的同名 MCP server 时，status 把它暴露为 MCP orphan / unmanaged evidence，install / upgrade 早失败，uninstall / historical fallback 不会误删或误认领。
- Codex project skills-only status 在 embedded fallback catalog 下仍以 repo `.agents/skills` 和 pristine bundle 为真值；没有 trust-gated artifact 时，project trust `untrusted` / `unknown` 不会单独把 health 降级，但 user config 不可读导致的 `externalOwnership.checkState = "unknown"` 仍会让 cell health 进入 `unknown`。
- Codex project scope apps 插件早失败，无半成品文件；交互式 install 中 apps-only 不进无插件名候选，skills / MCP / slashCommands + apps 作为 disabled 候选展示 apps 不支持原因。
- Codex project scope skill trigger 只影响 repo `.agents/skills`；`aw init`、local marketplace rebuild、project uninstall 都不会把 project 偏好 replay 或重选到共享 `~/.aw`。
- 显式 upgrade、`upgrade --all`、interactive uninstall / upgrade 都能从 repo-managed evidence 发现 Codex project scope 的 skills-only / mcp-only 插件。
- legacy `scopeInitialized` 在 Codex project repo-managed 语义下有唯一解释：完整 ledger managed 或完整 tracking managed evidence 为 `yes`，只有 orphan / unmanaged / external-only 为 `no`，归属不可判定为 `unknown`；status、`--platform auto` 和 upgrade 旧消费方都遵守同一派生结果。
- repo tracking 仍有 Codex project `overridable` evidence 但 ledger scope record 缺失或不可用时，显式 upgrade 未传 `--skill-trigger` 必须拒绝，`upgrade --all` 必须记为 skipped，code 为 `installOptionsUnavailable`；两者都不能静默按 `default` 恢复偏好或 prune 旧 artifact。`none` / `fixed` evidence 不因偏好缺失被拒绝或跳过。
- repo tracking 仍有 Codex project `overridable` evidence 但 ledger scope record 缺失或不可用时，重复 install 未传 `--skill-trigger` 必须拒绝；显式传入 `--skill-trigger` 且 tracking identity 完整时才允许刷新并重建 ledger scope record。`none` / `fixed` 的重复 install 不要求显式 `--skill-trigger`。
- current catalog 缺失但 tracking 仍有 skill / MCP evidence 时，status 和 uninstall 仍能按 project repo-managed evidence 工作，不退化为 `Unknown plugin` 或 user native fallback。
- 显式 upgrade 在 capabilityChanged 下先预检再卸载；预检失败时旧 repo-managed 安装保持不变。
- 显式 upgrade 在 capabilityChanged 下卸载已成功但新版 install 晚失败时，旧 repo-managed artifacts、`.codex/config.toml`、tracking manifest、ledger 和 skill trigger preference 都恢复到升级前状态。
- 显式 upgrade 在同一 managed kind 内发生 repo skill / MCP 删除或改名时，会按旧 tracking 和新版 artifact 集合做差集清理，不留下 orphan，也不删除外部配置。
- 缺少本机 `codex` executable 时，Codex project repo-managed install、显式 upgrade 和 `upgrade --all` 仍可执行并使用只读 catalog；Codex user scope 或真实 native runner target 仍按平台不可用失败。
- 缺少本机 `codex` executable 时，interactive install / uninstall / upgrade 仍能把 Codex project repo-managed 路径作为可选平台暴露出来；Claude 可用、Codex executable 不可用的混合环境也不会隐藏 Codex project 候选。
- interactive install 的共享兼容性回归保持有效：`marketplace.policy.products`、`both` 下单平台插件规则、显式多插件名共同兼容平台交集、无共同兼容平台早失败，以及 fake prompt 不兼容返回值拒绝都被测试锁住。
- Codex project install / uninstall / upgrade 的 `nativePlugins.codex` 为空，CLI 不输出 native marketplace 注册、plugin enabled 成功或 user native fallback 文案。
- status / discovery 不把 user native plugin evidence 当成 project installed evidence。
- user native 外部同名插件不作为 project installed evidence；它会阻止 Codex project install / explicit upgrade，避免同名 repo artifact 与外部 native plugin 产生运行时歧义；但不会阻止已有 project managed evidence 的 uninstall 清理 AW 自己管理的 repo artifacts。
- Codex project scope 已有 repo-managed evidence 且命中 user native 外部同名插件时，status health 为 `needsAttention` 而不是 `external`，默认输出继续展示 repo-managed item 状态，next steps 提示解除外部 native 冲突。
- user `~/.codex/config.toml` 损坏时，Codex project install / explicit upgrade 在写任何状态前失败；status 和已有 repo-managed evidence 的 uninstall 继续基于 repo evidence 工作，并把 `externalOwnership.checkState` / `projectTrust` 暴露为 `unknown`；`upgrade --all -p codex -s project` 将所有 Codex project target 标记为 skipped，不能刷新或清理其中任一 target。
- `uninstall --platform auto --scope project` 使用和 install / explicit upgrade / `upgrade --all` 一致的 evidence-first 推断：完整 Codex project evidence 能在缺少 `codex` executable 时落到 Codex；Claude 与 Codex project evidence 同时存在或任一候选 evidence 为 `unknown` 时拒绝自动推断，且不发生 lifecycle、repo artifact、tracking、ledger、AW config / install snapshot bookkeeping、native config 或共享 runtime 写入。
- `install` / 显式 `upgrade` 在 `--platform auto|both --scope project` 下先解析真实 targets 并完成 Codex project 写入前预检，再决定是否准备 local marketplace；最终只有 Codex project repo-managed target 时不触碰共享 marketplace/runtime，所有预检通过且解析到 Claude project 或 Codex user、并需要 native/runtime 时才执行必要准备。
- Required AW config 顺序与写入层被测试锁住：Codex project 安全预检失败时不调用配置向导、不写 config store；安全预检通过后才允许 required config prompt / non-interactive refusal。同一插件同一 schema source 在 mixed install / explicit upgrade 中只 prompt 一次、只写一次，写入层以 prompt 返回的 `selectedScope` 为准，所有 target 复用写入后的 effective config；同时 `aw config configure --scope user|project` 的显式 scope 硬约束有独立回归，prompt 不能改写到另一层。
- Codex project scope 带 lifecycle/config 的插件遵守已合入基线：install / upgrade lifecycle 在 repo artifacts 写完后、tracking / ledger 前执行，uninstall lifecycle 在清理 repo artifacts 前执行，安装快照写入 ledger scope record，status 只读展示 config/script health 与 `healthSource`。
- `install` / 显式 `upgrade --platform auto --scope project` 在 Claude 可用、Codex native 不可用、Codex project repo-managed 可执行且无 managed evidence 的歧义场景下拒绝自动推断；显式多插件同命令先按整组共同兼容平台收口，再聚合 evidence，只有完整 evidence 唯一指向同一侧时才自动落到该平台；任一插件 evidence 为 `unknown`、不同插件分别指向 Claude / Codex、或整组 evidence 无法共同收敛时都拒绝。
- `install` / 显式 `upgrade` 不支持 target-level `skipped[]`：mixed 显式命令中 Codex project target 因 user config 损坏、外部同名 native 冲突或 `overridable` tracking-only 偏好缺失而不能安全写入时，整条命令失败，其它 platform/scope target 不执行。只有显式 `upgrade --all --platform both` 允许跳过 Codex project target 后继续其它 target；`upgrade --all --platform auto` 必须先唯一推断平台，推断失败时整条拒绝，推断成功后才进入该平台的 target-level skip/refuse；`none` / `fixed` target 不因偏好缺失进入 skipped。
- `upgrade --all --platform auto --scope project` 的平台推断使用 ledger + tracking evidence；Codex project tracking-only target 不会在 target discovery 之前被漏掉，同时 auto 推断不会绕过后续 target-level skip / refusal。
- `upgrade --all` 的 skipped CLI 合同稳定：mixed succeeded + skipped 退出 `0`；全部 target skipped 且没有成功升级时退出 `1`；`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`trackingIntegrityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict` 都有唯一语义，并能在 direct command 返回值、human receipt 和退出码回归中稳定展示；catalog 整体不可加载仍是 target 外 fatal error，不产生 `skipped[]`。
- `kind: "skill"` / `kind: "mcpServer"` 的 tracking artifact 缺少必要 `artifactKey` 时，status 输出 `unknown` 诊断；uninstall、explicit upgrade、historical cleanup 和 stale prune 都 deterministic refusal，不执行 path-only cleanup。
- Codex project status 默认输出在纯 repo-managed 正常场景下，不把 user marketplace 状态当作主诊断。
- Codex project uninstall 删除 skill / MCP 后任一步失败，都能恢复 repo artifacts 和 tracking，或给出明确 degraded 状态。
- status default / verbose / JSON / debug、CLI entry 和 runtime env 合同都有回归覆盖。
- repo 子目录执行 install / status / uninstall 时仍锚定 repo root。
- `README.md`、`docs/plugin-installation.md`、`docs/architecture.md`、`docs/plugin-authoring.md`、`docs/testing.md`、`docs/coding-conventions.md` 和作者工具参考文档都同步到 Codex project repo-managed、公共 `slashCommands`、tracking identity 与 skill trigger applicability 新模型。
- `pnpm test:unit`、`pnpm test:integration`、`pnpm test:smoke:build`、`pnpm test:smoke:pack`、`pnpm test:smoke:plugin-scripts` 通过。

## 实施顺序建议

1. 先改 capability 模型和 validation，让 Codex project scope 不再进入 native path。
2. 拆分只读 catalog 准备、写入型 local marketplace 初始化和 Codex executable availability gate，确保 project-only repo-managed 命令不触碰共享 marketplace/runtime、不要求本机 `codex` executable，并先补 `install`、显式 `uninstall`、默认 `uninstall --platform auto --scope project`、显式 `upgrade --platform auto|both --scope project` 的 prepare 顺序、platform unavailable 对照与 mixed refusal 回归。
3. 先补命令层 dedicated preflight、required AW config 顺序 / 聚合 / `selectedScope` 写入层合同和 status fatal error 边界，停止把 `adapter.status()` 直接复用成写入前守门；安全预检必须早于 config prompt / config store 写入。
4. 补齐 `upgrade --all` 的 `skipped[]` direct command 返回值、CLI receipt 渲染和 CLI 退出码，再接入 target-level skip；同步加入全部 10 个稳定 code：`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`trackingIntegrityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`，并把 catalog 整体不可加载保留为 target 外 fatal error。
5. 补 external ownership / user config 预检分流：install / explicit upgrade 早失败，mixed 显式命令不部分继续，status / project uninstall 可带 unknown 诊断继续，纯 `upgrade --all -p codex -s project` 在 user config 损坏时把所有 Codex project target 标记为 skipped。
6. 先补 explicit upgrade 的 pre-uninstall validation、`capabilityChanged` 旧安装恢复快照和 lifecycle/snapshot 边界；内部 uninstall 不触发 uninstall lifecycle，新版写入失败时要恢复旧 repo artifacts、tracking、ledger 和旧 lifecycle/config snapshot metadata，再把 install / upgrade 的 native bookkeeping 改成 scope-aware 真实执行结果。
7. 补齐 legacy `scopeInitialized` 派生和 `upgrade --all --platform auto` evidence-first 推断，确保 tracking-only Codex project target 不会在旧控制流里丢失。
8. 补齐 `skillTriggerApplicability` 和 tracking-only install / upgrade 偏好拒绝合同：只有 `overridable` target 在 ledger scope record 不可恢复偏好时，重复 install 和显式 upgrade 不隐式 default，`upgrade --all` 只把该 target 记为 skipped，code 为 `installOptionsUnavailable`；`none` / `fixed` target 不要求偏好恢复。
9. 定义公共 `slashCommands` manifest / source validation / build / 作者工具合同，包含分平台 frontmatter schema、`./assets/...` 图标资源复制、子目录拒绝和 Codex 渲染结果 Claude-only 语法拒绝；删除旧 command 配置入口，让 Claude 生成 native commands、Codex user/project 都生成 manual-only skills。
10. 把 skill-trigger policy inventory 改成 platform-scoped，避免公共 `slashCommands` 生成的 Codex skill 进入 Claude skill-trigger 解析路径。
11. 增加 `.agents/skills` repo skill materializer，并接入 skill trigger preference；公共 slash command 生成的 skill 复用同一条路径，但固定为 `skillTriggerApplicability = "fixed"`，不允许 `--skill-trigger` 改成 auto。
12. 增加 `.codex/config.toml` 文档级事务，再接入 MCP config writer / remover、managed instructions 和 tracking kind；先落地结构化 JSON 子树到 TOML 等价结构、quoted key identity、writer / subtree replace / subtree delete 单元测试，再接入 install / status / upgrade / uninstall 主链路。
13. 补齐 project uninstall 对 skill / MCP / managed instructions 的快照、删除和失败回滚。
14. 调整 ledger 写入，停止 project `sharedNativeRefs`，写入 scope-owned `lifecycleConfigSnapshot` metadata，并把 Codex project scope 排除出共享 skill trigger replay / re-election。
15. 调整 discovery / status / historical fallback / interactive install / uninstall / upgrade 候选，并把交互式 platform prompt 接入 Codex project repo-managed 可执行性模型；这一阶段同步补回 `interactive install` 共享兼容性回归，避免 Codex project 特例覆盖旧的策略过滤、平台交集和 runtime validation 合同。
16. 调整 `codex + project` 输出契约，去掉默认视图里的 user native fallback 旧文案。
17. 补齐单元测试、集成测试、CLI entry 和 runtime env 回归。
18. 更新公开文档和作者工具参考文档。

这个顺序可以把风险拆开：先切断用户级 native 写入，再逐步补齐 project repo-managed 能力和状态展示。
