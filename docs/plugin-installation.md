# 插件安装指南

## 前置条件

- 已全局安装 `@yiliang/aw`（`npm install -g @yiliang/aw`）
- 至少安装了 Claude Code 或 Codex 其中一个

## 快速上手

```bash
# 1. 可选：提前初始化本地 marketplace，便于确认 native plugin runtime 正常
aw init

# 2. 安装插件
aw install git-commit

# 3. 查看安装状态
aw status
```

`aw install` 和 `aw upgrade` 只有在目标需要 native plugin runtime 时才会同步 `~/.aw`。显式运行 `aw init` 不是硬性前置步骤，但适合首次安装、升级 CLI 后排查 bundle 问题，或想提前确认本机 marketplace 状态时使用。纯 `Codex + project scope` 安装走当前仓库的 repo-visible artifacts，只读使用 catalog，不会为了当前项目写入去初始化、修复或注册用户级 Codex marketplace。

带动态 `codex.skill` 的插件也由 AW 统一安装和刷新：renderer 只返回 `ArtifactPlan`，AW 再把 skill 写到 user 或 project runtime，并按 `--skill-trigger default|manual|auto` patch `agents/openai.yaml`。配置变化命中 `refreshKeys` 后，同一条 apply 路径会重新生成 skill、更新 dynamic diagnostic cache，并保留用户已经选择过的触发偏好。

---

## 命令参考

### `aw init`

初始化或刷新本地 marketplace，将 npm 包内置的插件包同步到 `~/.aw/`。这主要服务 Codex user scope、Claude native plugin runtime 和 shared runtime owner replay；Codex project 安装本身不要求先跑 `aw init`。

```bash
aw init [-f|--force]
```

- `-f, --force`：忽略缓存，强制重新同步（升级 CLI 版本后如遇异常可使用）
- 若本地镜像缺失、过期或不健康，安装/升级命令也会自动回到 embedded bundle 并尝试同步；重复执行 `aw init` 无副作用

---

### `aw`

`aw` 主命令是唯一交互入口。TTY 环境下直接运行 `aw` 会打开控制台，按友好状态列表进入安装、升级、配置、卸载、重新应用配置和诊断流程；子命令只服务脚本化调用，不会弹出 prompt。

```bash
aw
```

主控制台复用 `aw status --json.consoleItems` 的状态投影：首屏合并 current catalog、install record、project artifact identity、native evidence、dynamic diagnostic cache 和 dependency index；同名插件多个位置只显示一个 item，执行写动作前必须先选明确位置。安装和升级向导固定先选插件、平台、位置和触发方式，再执行只读安全预检；只有预检通过后，才进入 required config 表单。非 TTY、`CI=true` 或 prompt 不可用时，直接运行 `aw` 不会挂起，会返回清晰错误、可复制的脚本化命令示例和 `--json` 机器输出提示。

配置向导只在 `aw` 主控制台中提供。脚本里请使用 `aw config set/unset/reset` 写入配置。

---

### `aw install`

```bash
aw install [插件名...] [-s project|user] [-p codex|claude|both|auto] [-t default|manual|auto] [--script-timeout <ms>] [-j|--json]
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-s, --scope` | `user` | `user`：安装到用户全局目录（`~/.claude/` 或 `~/.codex/`）；`project`：安装到当前目录（`.claude/` 或 `.codex/`） |
| `-p, --platform` | `auto` | `auto` 自动检测平台；双平台同时可用时，安装/卸载/升级需要能从当前 scope 的既有状态唯一推断目标平台，否则要显式指定 `claude`、`codex` 或 `both` |
| `-t, --skill-trigger` | 见下文 | 安装时的 skill 触发偏好：`default`、`manual` 或 `auto` |
| `--script-timeout` | 插件 manifest 或 `30000` | 覆盖 lifecycle 脚本超时，单位毫秒，合法范围 `1000..300000` |
| `-j, --json` | 关闭 | stdout 输出单一 JSON receipt，包含 `ok`、`command`、`plugins`、`targets`、`actions`、`artifacts`、`native`、`warnings`、`nextSteps` |

一次安装多个插件：

```bash
aw install git-commit another-plugin -p claude
```

如果目标插件声明了 `dependencies.plugins`，`aw install` 会在写入任何状态前先解析完整依赖图。缺失依赖会自动安装；已经健康满足的依赖不会重复安装，但父插件的依赖引用会刷新。默认输出会说明哪些插件是自动依赖，`--json` receipt 中自动依赖 target 会带 `requested: false` 和 `dependencyOf`。

---

### `aw uninstall`

```bash
aw uninstall [插件名...] [-s project|user] [-p codex|claude|both|auto] [--script-timeout <ms>] [--remove-config] [-j|--json]
```

参数与 `install` 相同。卸载会清理当前 scope 里 AW 管理的平台原生注册、repo-visible artifacts、project artifact identity、dynamic diagnostic cache 和 install record，但默认保留 AW 自管配置；需要在主体卸载成功后同时删除当前 target scope/store 的 AW 自管配置时，传 `--remove-config`。Codex project scope 只清理当前仓库里 AW 管理的 repo-visible artifacts，不会删除用户级 Codex native plugin 状态。`--json` receipt 会包含清理动作、native 结果、artifact 结果、配置处理结果、warnings 和 next steps。

如果目标仍被其它已安装插件依赖，`aw uninstall` 会拒绝单独卸载，并提示先卸载依赖它的插件。父插件成功卸载后，AW 会反向检查自动依赖：如果某个自动安装的依赖没有可信 incoming edge，只给出手动处理建议，不会自动删除。`aw uninstall` 仍然依赖可信 dependency index 做跨 scope 删除保护；但 `aw cleanup` 是用户显式确认的残留收口入口，只要 AW 能定位到要删的残留，并且没有已知 dependents，命令就会继续执行，不再把用户卡回“重装一遍”或手动改文件。

`aw uninstall` 只处理正常已安装或可升级、且能安全标准卸载的目标。record 损坏、native 状态不完整、可认领安装、残留、外部归属冲突、shared runtime 无法安全重放或依赖元数据异常时，命令会在删除前失败，并给出稳定 reason code 和下一步入口；需要恢复评估或高风险清理时，先运行 `aw cleanup --plan` 查看同构计划，再按建议执行 `aw cleanup` 或 `aw cleanup --force`。

---

### `aw upgrade`

```bash
aw upgrade [插件名...] [-a|--all] [-s project|user] [-p codex|claude|both|auto] [-t default|manual|auto] [--script-timeout <ms>] [-j|--json]
```

- 指定插件名，或用 `-a, --all` 升级当前 scope 下所有已管理的插件
- 显式升级某个插件时可传 `-t, --skill-trigger` 调整 skill 触发偏好；`upgrade --all` 不接受这个参数，会按各 location 的 install record 恢复
- 显式升级会先安装缺失依赖、再升级已安装依赖，最后升级用户指定的父插件；父插件失败时不会提交失败父插件的依赖引用
- 若插件的能力（instructions / permissions / hooks / native hooks / agents）发生变更，CLI 会先卸载再重新安装
- `upgrade --all` 只把用户显式保留的安装作为根，从 current catalog 展开依赖图；孤立 auto dependency 不会被当作用户目标，旧 edge 中已经不再需要的自动依赖不会阻塞父插件升级
- `upgrade --all` 只处理 `catalogCompatibility=current` 且 scope 已初始化的插件；缺失、能力变更、外部 marketplace 管理、project artifact identity 损坏、项目配置不可读、shared runtime owner 冲突或 install options 无法恢复时会把对应 target 放入 `skipped[]`
- `upgrade --all` 的默认输出会同时展示成功和跳过摘要；部分成功部分跳过时退出码为 `0`，全部 target 都 skipped 且没有成功升级时退出码为 `1`
- `--json` receipt 包含 `upgraded`、`skipped`、`targets`、`actions`、`native`、`artifacts`、`warnings` 和 `nextSteps`

---

### `aw diagnose`

```bash
aw diagnose [插件名...] [-s project|user] [-p codex|claude|both] [--deep] [-j|--json]
```

`diagnose` 是只读诊断入口。默认不执行 renderer、不运行 lifecycle、不修复文件，只说明当前证据来自哪些层：current catalog、平台现场、project artifact identity、install record、dynamic diagnostic cache、historical lifecycle runtime、dependency index、shared runtime owner 和 native transaction marker。

- `--deep` 可以重新执行动态 artifact renderer，用于确认配置驱动产物是否仍可生成；普通 `status` 和默认 `diagnose` 不会执行 renderer。
- dependency index 不可信时，诊断会给出恢复命令，例如 `aw repair --dependency-index`；遇到 stale project reference 时会给出 token，并要求用户显式运行 `aw cleanup --dependency-index --prune-stale <token> --yes`。
- project shared/local config、路径型配置和 ignore 规则问题会在这里汇总，方便在写命令前修正。

---

### `aw repair`

```bash
aw repair [插件名...] [-s project|user] [-p codex|claude|both] [--adopt-existing] [--dependency-index] [--takeover-shared-runtime] [-j|--json]
```

`repair` 用于修复 AW 能确认归属的安装。current catalog 与 install record 仍能证明是同一 bundle 时，repair 会重新应用 AW-owned artifacts，必要时重新执行平台 native install，并刷新 dynamic diagnostic cache、project artifact identity、install record 和 dependency index。catalog 已漂移时，repair 不会隐式升级；请显式运行 `aw upgrade` 或 `aw reinstall`。

- `--adopt-existing` 是 project fresh clone 认领共享产物的脚本化入口。仓库里已有可验证的 repo-visible artifacts 和 project artifact identity，但本机缺少 install record 时，运行它会按当前机器位置创建本机 record，并按 current catalog 重新应用共享 artifacts。
- `--dependency-index` 从可验证的 install records 重建全局 dependency index。
- `--takeover-shared-runtime` 只对单个明确 plugin/platform/scope/project target 生效；遇到 shared runtime owner 冲突时，普通 install/repair/单目标 upgrade 默认失败，用户确认后重跑同一条命令并加这个 flag 才会接管。`upgrade --all` 不允许批量接管。

---

### `aw cleanup`

```bash
aw cleanup [插件名...] [-s project|user] [-p codex|claude|both] [--plan] [--force] [--remove-config] [--dependency-index --prune-stale <token>] [-y|--yes] [-j|--json]
```

`cleanup` 是统一恢复评估入口，会先生成删除计划，再按安全边界执行。它覆盖健康安装、可升级安装、marker-only、半完成写入、可认领安装、可定位残留、外部归属冲突和诊断问题；受控 Codex native residue 会保留具体类型，例如 `config-only`、`manifest-only`、`cache-only`。`cleanup --plan` 只读，不写状态、不删除文件、不创建备份；配合 `--json` 时输出 `cleanupPlanSchemaVersion: 1`，并包含 `plannedRemovals`、`wouldBackups`、`wouldRemoveConfig`、`skippedForeignItems`、`affectedDependents`、`blockingReasons` 和建议执行命令。

`cleanup --force` 本身就是 direct CLI 的高风险确认，不再额外要求 `--yes` 或 plan token。高风险计划会列出 force reason、备份项、跳过项、受影响 dependents、阻断原因和实际未清项；如果无法归类、枚举或证明归属，命令仍会失败并给出人工处理建议。`cleanup --plan --force` 合法且仍然只读，用来预览 force 语义下会发生什么。`--remove-config` 只在主体清理成功后删除当前 target scope/store 的 AW 自管配置；主体被阻断或失败时配置会保留。普通插件 cleanup 不接受 `--yes`，`--yes` 只用于 dependency index stale reference prune。

dependency index 的 stale project reference 不会被读命令静默裁剪。只有诊断给出 token 后，才运行：

```bash
aw cleanup --dependency-index --prune-stale <token> --yes
```

---

### `aw reinstall`

```bash
aw reinstall [插件名...] [-s project|user] [-p codex|claude|both|auto] [-t default|manual|auto] [--takeover-shared-runtime] [-j|--json]
```

`reinstall` 等价于先诊断，再安全移除 AW-owned 状态，最后按 current catalog 重新安装。遇到 project “可认领”状态时默认停止，提示先运行 `aw repair --adopt-existing`，避免把团队共享产物当成残留覆盖。

---

### `aw config`

`aw config` 管理 AW 自管插件配置，独立于 Claude 原生 `userConfig`。插件只要在当前 catalog 中声明了 `config.schema`，就可以先配置后安装，也可以在未安装插件的另一层 scope 里预置覆盖值。脚本化配置命令只有 `set`、`unset`、`reset`、`get` 和 `list`；交互式配置请运行 `aw` 主控制台。

```bash
aw config list <插件名> [-s project|user] [-j]
aw config get <插件名> [key] [-s project|user] [-j]
aw config set <插件名> <key> <value> [-s project|user] [--value-json] [-j]
aw config unset <插件名> <key> [-s project|user] [-j]
aw config reset <插件名> [-s project|user] [-y] [-j]
```

- `set` / `unset` / `reset` 默认写 `user`；`get` / `list` 默认读取 effective config。
- effective config 按 `manifest default < user store < project shared store < project local store` 合并，project local 只影响本机读命令、lifecycle/helper 或未来 local-only 能力。
- project shared config 在仓库或 workspace 内锚定 repo root，路径是 `.agent-workflows/plugin-config/<plugin>/config.json`，可以提交；project local config 位于 `.agent-workflows/plugin-config.local/<plugin>/config.json`，默认忽略。不在仓库内时退回 normalized command `cwd`。
- `file` / `directory` 是本机路径型配置，只能写 user store 或 project local store，写入时会把相对路径按 AW project root 解析，并以 canonical absolute realpath 落盘；后续每次读取都会重新校验路径是否仍存在且类型正确。路径型配置不能进入 project shared config，也不能参与 project repo-visible artifact 的 render config、digest、stale 判断或 refresh。
- `--value-json` 只影响 `set` 的输入值解析；`--json` 只影响输出格式。
- `reset` 是单纯的 config store 级删除，不卸载插件、不清理 runtime artifact，也不处理 native residue。即使 current catalog 已经找不到插件，只要 store 存在，`aw config reset <插件名> -s <scope> --yes` 仍可清理残留配置。存在 store 且未传 `--yes` 时，脚本化命令会确定性失败，不会静默删除；需要交互确认时请运行 `aw` 主控制台。
- `set` / `unset` / `reset` 共用配置写入 helper。receipt 稳定返回 `updatedKeys`、`removedKeys` 和 `artifactRefresh`；sensitive 值不会在默认输出、debug log 或 receipt 中明文出现。

插件名会先经过 config store 路径段安全校验：只允许非空单段名称，拒绝路径分隔符、`.`、`..`、绝对路径和 URL-like 值。

带动态 artifact 的插件会在配置写入后按需刷新已安装产物。刷新只在写入的 key 命中已安装 artifact 的 `refreshKeys` 时触发；未命中时只保存配置。user 配置写入会刷新 user scope artifact，并在当前仓库也安装了 project artifact 时一并刷新当前仓库；project 配置写入只刷新当前仓库 project artifact，不会改写 user artifact。CLI 不会扫描所有历史项目。刷新执行 renderer 时使用当前 location 的 install record 所引用的 historical bundle，而不是可能已被运行时产物覆盖的本地 marketplace 当前副本；historical bundle 缺失或校验失败时，本次刷新会失败并留下诊断。

刷新使用 artifact render config，而不是 `get/list` 的 effective config：user artifact 只看 `default < user store`，project repo-visible artifact 只看 `default < project shared store` 中可共享的键。user / project local 覆盖不会改变 project artifact identity、config digest 或 stale 判断。如果 renderer、project preflight 或写盘失败，已经写入的 config store 会保留，受影响 artifact 会在 dynamic diagnostic cache 中标记为最近刷新失败，`aw status` 可继续诊断。`aw config ... --json` 会在 receipt 中包含 `artifactRefresh.attempted`、`status`、`triggerKeys`、`artifacts[]`，失败时还会有稳定的 `error` 摘要。

`aw` 主控制台里的“重新应用配置”是 refresh-only 动作：它复用同一条 artifact apply / diagnostic cache 写回路径，但不修改 config store。成功后会更新对应 artifact 的 `lastRefresh` 和 dynamic diagnostic cache；失败后保留配置，并把新的 `artifactRefresh.error` 写回 receipt 和后续 status 诊断；没有可定位 dynamic artifact 时返回 `artifactRefresh.status = skipped`。

---

## 脚本化命令与安全预检

`install`、`uninstall`、`upgrade` 和 `config` 子命令不会 prompt。缺少插件名、缺少必填配置、未传 `--yes` 的 reset、非 TTY 或 CI 场景都会确定性失败，并给出可复制命令；需要交互式选择时运行 `aw`。

在 `Codex + project scope` 下，安装候选必须包含 repo-visible artifacts；纯 native-only 插件不能作为项目级安装目标。skills-only、mcp-only、slashCommands-only 和 extensions-only 插件都可以作为项目级候选；带 `apps` 的 Codex project 安装会明确拒绝，请改用 `--scope user` 或拆分插件。

如果插件声明了 required AW config，脚本化 `install` / `upgrade` 会在写入平台状态前先解析 effective config。Codex project install / explicit upgrade / mixed explicit command 的顺序更严格：先做不会写状态的安全预检，包括 project installability、用户级 Codex config external ownership、必要的 `.codex/config.toml` 解析、project artifact identity 和未受管 repo artifact 冲突；这些都通过后，才检查 required AW config。缺少必填项或 `file` / `directory` 路径失效时，子命令会确定性失败，并提示可复制的 `aw config set` 命令或引导运行 `aw` 主控制台。同一插件在 `--platform both` 或重复 target 中只会复用一次重新解析后的 effective config。

---

## Skill 触发偏好

`-t, --skill-trigger` 只影响插件作者在 `.agents-plugin/plugin.json` 中允许安装时覆盖的 skill。未允许覆盖的 skill 会保留插件默认策略，并在命令输出中给出提示。

| 值 | 含义 |
|----|------|
| `default` | 恢复插件源码里的默认触发策略 |
| `manual` | 禁止模型自动触发，但保留用户显式触发入口 |
| `auto` | 允许模型自动触发 |

默认策略仍来自平台原生文件：Codex 读取 `skills/<skill>/agents/openai.yaml` 的 `policy.allow_implicit_invocation`，Claude Code 读取 `SKILL.md` frontmatter 的 `disable-model-invocation` 和 `user-invocable`。

对动态 `codex.skill`，`default` 和 `auto` 会让最终 runtime `agents/openai.yaml` 中的 `policy.allow_implicit_invocation` 为 `true`，`manual` 会改为 `false`。renderer 输出的模板不是最终触发真值；AW 会在 install、显式 upgrade、repair、config refresh 和 refresh-only 时按 install record 里的偏好重新 patch，因此配置刷新不会把用户显式选择的 manual/auto 悄悄重置。

重复执行 `aw install` 时，未传 `--skill-trigger` 不等于重置。只要当前 location 的 install record 可读且来源仍可信，CLI 会沿用上一次记录的偏好；只有显式传 `-t default` 才会主动恢复默认策略。`aw upgrade <插件名>` 未传参数时也遵循同样的 record 继承规则。

如果当前 location 的 install record 损坏或缺少可恢复安装选项，CLI 不能安全相信旧记录。对已经受管的 target，重复 `install` 或显式 `upgrade` 必须传 `--skill-trigger default|manual|auto` 才能继续；未受管的新安装 target 仍按 `default` 安装。

`~/.aw` 是本机共享 marketplace。Codex user scope 和 Claude native runtime 仍共享同一用户下同名插件的 runtime skill 文件；同一 plugin/platform 同一时间只有一个 shared runtime owner 可以控制这份 runtime。非 owner 的 install、repair 或单目标 upgrade 如果会改变共享 runtime，默认失败并提示重跑同一条命令加 `--takeover-shared-runtime`。Codex project scope 例外：它只改当前仓库的 `.agents/skills/<skill>/agents/openai.yaml`，不参与 shared runtime owner 合同、`aw init` replay 或本地 marketplace rebuild replay。

`skillTriggerApplicability` 是 status / upgrade 判断里的稳定语义：

- `none`：目标没有 skill trigger 面，例如 mcp-only 或 extensions-only
- `fixed`：有 skill artifact，但运行时固定，例如公共 `slashCommands` 生成的 manual-only Codex skill，或所有 skill 都不允许 install override
- `overridable`：至少一个 Codex project skill 允许 `--skill-trigger` 覆盖；只有共享产物证据但缺少可恢复 install options 时，显式 install / upgrade 必须要求用户传 `--skill-trigger`，`upgrade --all` 会以 `installOptionsUnavailable` 跳过

---

### `aw status`

```bash
aw status [插件名...] [-s project|user] [-p codex|claude|both] [-j|--json]
```

不指定插件名时，显示 AW 管理过或平台可发现的插件摘要。`status` 的 `--scope` 和 `--platform` 是过滤条件；不传时会跨 scope / platform 扫描。为了兼容旧习惯，`aw status -p auto` 等同于不传 platform 过滤。

默认输出是日常状态面板，包含：

- 状态摘要：每个插件的整体健康状态，例如可用、部分可用、需要处理、外部管理、未安装或未知
- 位置摘要：展示用户可理解的位置、原因和可执行下一步；默认文案不展示内部诊断词
- 下一步：给出最可能的修复或确认命令，例如 `aw status <plugin> --verbose`、`aw upgrade <plugin>` 或 `aw install <plugin>`

友好状态投影由 status、主控制台和 JSON 共用。默认输出只展示 `已安装`、`需要修复`、`可认领`、`有残留`、`由其它来源管理`、`未安装` 等用户可理解状态；内部状态文件、低层 runtime 细节和诊断字段只出现在 `--verbose` / `--json` 或 debug log 中。可复制命令、argv、flag、JSON 字段和类型名保留真实技术标识。

`--verbose` 会展开诊断字段，包括平台检测、native plugin 状态、scope 初始化状态、install record、catalog 兼容性、managed evidence、shared runtime owner、config/script health、generated artifacts、dynamic diagnostic cache、project artifact identity、dependency index 和 drift warnings。Codex project scope 的默认状态面板以 repo-visible artifacts、project artifact identity 和本机 record 为主；用户级 native marketplace 注册缺失不会覆盖正常的 project installed/adoptable signal。动态 artifact 会单独展示 skill / instruction / role 等 artifact health，常见状态包括 healthy、disabled by config、missing、content drift、config digest stale 和 recent refresh failed。user 配置写入没有扫描历史项目时，`refreshReach` 会说明本次已刷新 user / 当前 project，以及其它已知 project target 是否可能仍 stale。`status` 只读，不会执行 lifecycle、不会执行 artifact renderer、不会刷新 marketplace、不会启动 `codex app-server`、不会创建配置目录；失效的 `file` / `directory` 配置会显示为 `invalid-config`。`-j, --json` 输出稳定 JSON schema；即使和 `--verbose`、`--debug` 叠加，stdout 也只包含可直接 `JSON.parse` 的 JSON。

依赖状态也只读展示。`status --json` 中每个位置的 `dependencies` 会包含 `declared`、`resolved`、`satisfied`、`missing`、`dependents`、`autoInstalled`、`autoRemovable`、`catalogDrift` 和 `dependencyIndexTrusted`。`missing` 表示当前健康层确实缺依赖；`catalogDrift` 表示 current catalog 和 record 里的依赖声明不同，不会单独把旧安装判成缺失依赖。`autoRemovable=true` 是只读投影，表示该位置是未显式保留的自动依赖且当前没有其它插件引用；status 和主控制台不会因此自动删除它。

`status --json` 顶层保留既有 `detection`、`summaries`、`cells`、`reports`，并追加 `ok`、`command`、`friendlySummaries`、`consoleItemsSchemaVersion: 2` 和 `consoleItems`。V2 的变化边界只切换 `consoleItemsSchemaVersion` 和 `consoleItems` 合同；顶层 envelope 中未声明变更的字段保持兼容。V2 `consoleItems` 是公开 summary shape，功能入口放在 `features`，不再输出旧 `locations[].actions[]`、命令数组、确认文案或 TUI 页面字段；真正的执行动作由主控制台在用户选择功能和明确 target 后生成。

V2 `consoleItems.status` 只使用四类状态：

| 旧状态语义 | V2 状态 |
|---|---|
| 未安装、未知但可从 catalog 发现 | `notInstalled` |
| 可用、ready、healthy | `installed` |
| 已安装且 current catalog 有可升级版本 | `upgradeAvailable` |
| `needsAction`、`partial`、`repoManaged`、外部管理、残留、配置缺失、record 损坏等需要处理的状态 | `abnormal` |

旧 action kind 迁移为两段：公开 summary 只暴露 `features[].kind`，执行层在 TUI 内部生成 `PluginConsoleExecutableAction.kind`。

| 旧 action kind / 语义 | V2 `features[].kind` | 执行层 action |
|---|---|---|
| `openInstallWizard`、安装入口 | `install` | `runInstall` |
| `runUpgrade`、升级入口 | `upgrade` | `runUpgrade` |
| `runUninstall` | `uninstall` | `runUninstall` |
| `repairInstall`、普通修复 | `repair` | `runRepair` |
| `cleanupRecovery`、残留/异常清理 | `cleanup` | `runCleanup` |
| `runReinstall` | `reinstall` | `runReinstall` |
| `adoptExisting` | `adoptExisting` | `runAdoptExisting` |
| 共享 runtime owner takeover | `takeoverSharedRuntime` | `runTakeoverSharedRuntime` |
| `reapplyConfigRefresh` | `reapplyConfigRefresh` | `runReapplyConfigRefresh` |
| `diagnoseCommand`、状态/诊断入口 | `status` / `diagnose` | 诊断页 supplemental command，不属于公开写动作 |
| 重复安装处理 | `resolveDuplicateInstall` | `resolveDuplicateInstall` |

旧 reason code 会投影为 V2 稳定 code；`consoleItemsSchemaVersion: 2` 下不会再输出旧 id。

| 旧 reason code | V2 reason code |
|---|---|
| `missingRecord` | `recordCorrupted` |
| `adoptExisting` | `adoptableInstall` |
| `ownerConflict` | `foreignOwnershipConflict` |
| `dependencyProtected` | `dependencyBlocked` |
| `requiredConfigMissing` | `missingRequiredConfig` |
| `invalidConfig` | `missingRequiredConfig` |
| `unreadableConfig` | `missingRequiredConfig` |
| `nativeResidue` | `residueDetected` |
| `artifactDrift` | `artifactRefreshFailed` |
| `externalOwnership` | `foreignOwnershipConflict` |
| `trackingIdentityBroken` | `recordCorrupted` |
| `roleOrMcpConflict` | `foreignOwnershipConflict` |
| `unmanagedArtifactConflict` | `foreignOwnershipConflict` |
| `catalogCapabilityChanged` | `recordCorrupted` |

Codex user native 的 JSON 字段有一个重要变化：`native.pluginInstalled` 表示 Codex cache 中已经 materialize 出可用 active version；`native.pluginEnabled` 表示用户级 config 中 `[plugins."<plugin>@aw"].enabled === true`；native transaction marker 表示 native 写入已经发生但 AW record 还没成功提交。因此 enabled-only、cache-only、marker-only 状态都会作为诊断或 `needsAttention` 暴露，不再被解释成完整安装。

---

## Scope 与 Platform 说明

### Scope

| | `project` | `user` |
|---|---|---|
| 写入位置 | 当前项目目录下的 `.claude/`；Codex 写当前仓库的 `.agents/skills` 和 `.codex/` | `~/.claude/` 或 `~/.codex/`，并按需使用 `~/.aw` native runtime |
| 适用场景 | 项目级配置，提交到版本控制 | 跨项目共享的个人配置 |

> **Codex 注意**：`--scope user` 仍使用 Codex native plugin 平面。AW 会先通过 `codex plugin marketplace add <canonical ~/.aw>` 注册本地 marketplace，再调用 `codex app-server` 的 `plugin/install` / `plugin/uninstall` RPC，由 Codex 写入 enabled config 和 materialized cache；AW 不再回退到只写或只删 `~/.codex/config.toml`。`--scope project` 不写 `~/.codex/config.toml [marketplaces]` 或 `[plugins]`，也不调用 native marketplace add / app-server RPC；它只写当前仓库的 repo-visible artifacts，并维护 `.agent-workflows/project-artifacts/` 下的 shared identity metadata。即使本机缺少 `codex` 可执行文件，Codex project 安装也不会产生用户级 native 副作用。

### Platform

| 值 | 行为 |
|---|---|
| `auto`（默认）| 自动检测平台；`status` 会展示所有可用平台，写入型命令会先按插件的 `marketplace.policy.products` 过滤，再在双平台可用时尝试唯一推断目标平台 |
| `claude` | 仅安装到 Claude Code |
| `codex` | 仅安装到 Codex |
| `both` | 同时安装到两个平台（均需可用） |

如果插件声明了 `marketplace.policy.products`，安装和升级时会拦截不匹配的平台；省略该字段表示不限制平台。

---

## 安装后生成的文件

安装成功后，CLI 会在对应目录写入以下产物：

**Claude**
- `.claude/rules/aw-<名称>.md` — instructions 文件
- `.claude/settings.json` — 合并 permissions 配置，并在 `awGenerated` 下记录 CLI 生成部分，尽量保留手写权限
- Claude hooks 来自插件 bundle 内的 `claude/hooks/hooks.json`，由 Claude Code 原生插件加载；CLI 不会把它作为额外 repo-visible hook 文件写入项目目录

**Codex**
- `.agents/skills/<skill>/` — Codex project scope 的 repo skill；静态 skill、动态 `codex.skill` 和公共 `slashCommands` 生成的 manual-only skill 都会以受管 identity 记录
- `.codex/config.toml` — 追加 managed instructions block，写入动态 `developer_instructions` block、Codex agent role 注册项和 `mcp_servers`；动态 `codex.skill` 不要求 `.codex/config.toml`。MCP server key 保留 rendered `.mcp.json` 的原始属性名，包含点号、空格或 Unicode 时使用 TOML quoted key，例如 `[mcp_servers."acme.tools v1"]`
- `.codex/rules/*.rules` — Codex execpolicy `prefix_rule(...)` 权限规则
- `.codex/hooks.json` — Codex `hooks.<Event>[]` 钩子配置，包含公共 hooks 和 `extensions.nativeHooks.codex`
- `.codex/agents/*.toml` — Codex agent role 文件

Codex 的 `.codex/hooks.json` 是共享文件。CLI 只替换自己通过 artifact identity 确认拥有的 hook groups，手写配置或其它工具写入的 runtime-valid groups 会原样保留。

安装成功后，AW 会为当前 location 写入独立 install record v2。record 只保存归属、必要安装选项、`skillTriggerPreference`、安装来源和 canonical outgoing dependency edges；它是本机安装真值，但不是健康状态数据库。project scope 还会在 `.agent-workflows/project-artifacts/<platform>/` 写入可提交的 shared identity metadata，用于 fresh clone 后识别“可认领”的共享产物。动态 artifact 的 accepted state、`configDigest`、`contentDigest`、`lastRefresh` 和 `refreshReach` 写入 dynamic diagnostic cache，供 `status` / `diagnose` 只读展示。

带 lifecycle 或动态 artifact renderer 的插件会保存最小 historical runtime bundle。普通 `uninstall` 以及需要先撤销历史副作用的 `repair` / `reinstall` 会用它运行安装时的 lifecycle；配置触发的 dynamic artifact refresh 和 refresh-only 会用它执行安装时的 renderer，避免 current local marketplace 被运行时产物污染后反过来污染模板真值。它不作为 current catalog、依赖声明或配置 schema 的来源。

project scope 的本机私有状态和本机配置会默认加入 ignore：`.claude/.agent-workflows/`、`.codex/.agent-workflows/`、`.agent-workflows/plugin-config.local/`。团队共享输入不能默认忽略：`.agent-workflows/plugin-config/` 和 `.agent-workflows/project-artifacts/` 应随仓库提交。

---

## 常用短选项

| 短选项 | 长选项 | 适用命令 |
|---|---|---|
| `-s` | `--scope <scope>` | `install` / `uninstall` / `upgrade` / `status` |
| `-p` | `--platform <platform>` | `install` / `uninstall` / `upgrade` / `status` |
| `-t` | `--skill-trigger <preference>` | `install` / 显式插件 `upgrade` |
| `-a` | `--all` | `upgrade` |
| `-v` | `--verbose` | `install` / `uninstall` / `upgrade` / `status` |
| `-D` | `--debug` | `install` / `uninstall` / `upgrade` / `status` |
| `-j` | `--json` | `init` / `install` / `uninstall` / `upgrade` / `config` / `status` |
| `-f` | `--force` | `init` |
| 无 | `--force` | `cleanup` |
| 无 | `--plan` | `cleanup` |
| 无 | `--remove-config` | `uninstall` / `cleanup` |

---

## 可用插件

| 插件名 | 描述 | 支持平台 |
|--------|------|----------|
| `git-commit` | 在用户请求提交时，按约定式提交规范完成 Git 提交 | Codex / Claude Code |
| `codex-explore` | 为 Codex 提供通用只读探索流程 | Codex |

> P0/P11 runtime contract：`codex-explore` 是 Codex 通用只读探索 workflow，可用于代码库、文档、网络资料、日志和用户材料的证据搜索与总结；具体能访问哪些来源取决于当前会话工具、权限、联网策略和用户提供的上下文。

查看完整列表：

```bash
aw status
```

---

## 常见工作流

### 在新项目中启用插件

```bash
cd my-project
aw init          # 若本机已初始化过可跳过
aw install git-commit
aw status        # 确认安装成功
```

### 升级所有插件

```bash
aw upgrade -a
```

### 迁移到新机器

新机器上重新执行 `aw init` 和 `aw install` 即可恢复需要 native runtime 的本机 marketplace 与平台原生注册。Codex project scope 的 repo-visible 文件（如 `.agents/skills/`、`.codex/config.toml`、`.codex/rules/`、`.codex/hooks.json`）随项目存在；如果仓库里已有可验证的 project artifact identity，本机缺少 install record 时，先运行：

```bash
aw repair git-commit -p codex -s project --adopt-existing
```

认领会在当前机器创建 project install record，并按 current catalog 重新应用共享 artifacts。用户级配置仍需要在新机器上重新安装或重新设置。

---

## 故障排查

### 安装中断或状态需要修复

安装、卸载或升级过程中断后，先用只读命令确认状态：

```bash
aw status git-commit
aw diagnose git-commit --verbose
```

常见处理路径：

```bash
aw repair git-commit -p codex -s user
aw reinstall git-commit -p codex -s user -t default
aw cleanup git-commit -p codex -s user --plan
aw cleanup git-commit -p codex -s user
```

依赖功能依赖完整的 `installSource` 和 `dependencyEdges` metadata。若 install record 缺少这些字段、edge 不完整，或 dependency index 不可信，依赖相关安装、升级和普通卸载保护仍会保守失败；先用 `aw diagnose --verbose` 看具体位置，再通过 `aw repair --dependency-index`、显式升级或重新安装受影响插件补齐记录。`aw cleanup` 不再把这类索引问题当成硬前置，只要能定位残留并确认当前没有已知 dependents，就允许显式收口。

### 自动依赖无法安装或升级

自动依赖和显式目标使用同一套 preflight。常见失败原因包括：依赖插件不在当前 AW catalog、依赖插件不支持父插件当前 platform、user scope 父插件声明了 project scope 依赖、Codex project scope 依赖没有 repo-visible surface、依赖缺少 required config，或多个父插件通过 `inheritInstallOptions: true` 给同一个自动依赖传入冲突安装选项。

处理时先运行：

```bash
aw status <插件名> --verbose
```

缺配置时按提示对依赖插件运行 `aw config set <依赖插件> <key> <value> -s <scope>`；scope 不匹配时需要改用合适的 `--scope` 安装父插件，或由插件作者调整 `target.scope`。如果自动依赖需要特殊 skill trigger，建议先显式安装该依赖，再安装父插件。

### 插件安装后 AI 看不到 instructions

先执行 `aw status` 查看友好摘要和下一步；需要定位具体运行时可见性时，再执行 `aw status --verbose` 查看诊断字段：

- `blockedByProjectTrust`：Codex 项目信任未开启，需在 Codex 中将项目标记为 trusted
- `shadowedByProjectDeveloperInstructions`：被项目自定义 instructions 覆盖
- `absent`：文件未正确生成，尝试重新安装

### 提示"插件已由外部 marketplace 管理"

Codex project scope 安装 / 显式升级时，如果用户级 `~/.codex/config.toml [plugins]` 中已有同名外部 native plugin，CLI 会在写入任何 repo artifact 前拒绝，避免运行时歧义。已有 project artifact identity 或 install record 的 `status` 会继续以当前仓库的安装状态为主，把 external ownership 作为附加诊断和下一步；`uninstall -p codex -s project` 只清理 AW 管理的 repo artifacts，不删除用户级 native plugin。

### Codex app-server 或 native RPC 失败

`aw install <plugin> -p codex -s user` 和 `aw uninstall <plugin> -p codex -s user` 需要 Codex 提供 `codex app-server`，并支持 `plugin/install` / `plugin/uninstall`。如果 app-server 无法启动、提前退出、协议输出无法解析、unknown method、plugins 被 workspace 禁用，或 install policy 拒绝，命令会失败并给出可行动建议。AW 不会退回到只写 enabled config 或只删 config；请先升级/修复 Codex CLI 或 workspace policy，再重试同一条 `aw install` / `aw uninstall`。

排查时建议加 `--verbose` 或 `--debug`。debug event 会区分：

- `native:marketplace`：marketplace add / verify，失败通常是 `codex plugin marketplace add <canonical ~/.aw>` 不可用或注册后未指向当前 AW_HOME。
- `native:rpc`：`plugin/install` / `plugin/uninstall` RPC，失败会带 `method`、`pluginId`、`errorCategory` 和 `suggestion`。
- `native:post-check`：RPC 后检查 enabled config、config entry 和 active cache；install 要求 enabled config + active cache 同时存在，uninstall 要求 config entry 不存在且 active cache 不存在。
- `native:transaction`：native transaction marker 写入、更新或删除；它说明 AW 是否能自动 repair 或 cleanup。
- `native:skipped`：Codex project 路径不会写 native 状态，reason 为 `project_repo_managed_skipped_native`。

### Codex user native marker

Codex user native RPC 成功后，AW 会写入短生命周期 native transaction marker，再继续 post-check、lifecycle、artifact apply 和 install record 提交。只要后续步骤失败，`aw status --verbose` / `aw status --json` 都会显示 marker-only 或 needs repair 状态。

常见状态和处理方式：

- `pending_after_native_write`：Codex native 写入已发生，AW 后续步骤未完成。运行 `aw repair <plugin> -p codex -s user` 补齐 record，或先运行 `aw cleanup <plugin> -p codex -s user --plan` 预览后再清理残留。
- `post_check_failed`：RPC 返回成功，但 enabled config 或 active cache 缺失。AW 不会 config-only fallback；先修复 Codex app-server / marketplace，再重试 install 或 uninstall。
- `lifecycle_failed`、`record_write_failed`、`diagnostic_write_failed`：native 已写入，AW 后续持久化或脚本失败。重新 install / repair 会尝试补齐；cleanup 可用 marker 授权清理残留。
- `cleanup_failed`：native 卸载大概率已执行，但 cache/config 或 marker 清理未收口。重新运行 `aw cleanup <plugin> -p codex -s user --plan` 查看计划，再按建议执行 `aw cleanup` 或 `aw cleanup --force`。

如果 marker 写入本身失败，命令会立即失败，并提示 AW 不能承诺后续自动 repair / cleanup 授权。此时先运行 `aw diagnose --verbose` 检查 config/cache，再决定是否修复文件权限或手动处理。marker-only install / repair 可以补齐 AW record 并在成功后删除 marker；marker-only cleanup 会清 config/cache/marker，但不会运行 uninstall lifecycle；marker-only upgrade 会明确失败，`upgrade --all` 会跳过。

### `upgrade --all` 跳过 code

`upgrade --all` 的 direct command 返回值包含稳定 `skipped[]`。CLI receipt 会展示 code 和原因。首版 code 如下：

`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`projectArtifactIdentityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`、`dependencyIndexUntrusted`、`sharedRuntimeOwnerConflict`。
