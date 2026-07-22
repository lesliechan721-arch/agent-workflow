# 插件安装指南

## 前置条件

- Node.js 版本至少为 `20`
- 已全局安装 `@yiliang/aw`（`npm install -g @yiliang/aw`）
- 写入 Claude 目标时需要 Claude Code `>= 2.1.88`
- 写入 Codex 目标时需要 Codex `>= 0.145.0`；Codex project scope 也会在写 repo-visible artifacts 前检查版本。Codex `0.144.x` 可能不暴露 `spawn_agent` 的 `agent_type` 参数，导致 `codex-explore` 无法调度专用子代理

## 快速上手

```bash
# 1. 可选：提前预热远程 catalog 和 artifact cache
aw init

# 2. 安装插件
aw install git-commit -p both

# 3. 查看安装状态
aw status
```

`aw install` 和 `aw upgrade` 会先解析 current catalog。显式运行 `aw init` 不是硬性前置步骤，但适合首次安装前预热远程 catalog/cache，或验证当前网络、selector 和本地 fallback 状态。纯 `Codex + project scope` 安装走当前仓库的 repo-visible artifacts，只读使用 current catalog，不会为了当前项目写入去初始化、修复或注册用户级 Codex marketplace。

带动态 `codex.skill` 的插件也由 AW 统一安装和刷新：renderer 只返回 `ArtifactPlan`，AW 再把 skill 写到 user 或 project runtime，并按 AW 内建 SkillTrigger 配置 patch `agents/openai.yaml`。配置变化命中 `refreshKeys` 后，同一条 apply 路径会重新生成 skill、更新 dynamic diagnostic cache，并按当前 effective 触发策略重新应用 runtime。

---

## 命令参考

### `aw init`

预热远程 catalog 和 artifact cache。`aw init` 会先获取轻量 sidecar 包 `@yiliang/aw-plugins-manifest`，确认 catalog 与当前 CLI 兼容后，再解析同版本 full catalog 包 `@yiliang/aw-plugins` 的 identity；如果本机已有完全匹配的 cache，就直接复用，否则下载 full catalog 并校验 manifest、integrity 和 artifact digest。它不安装插件、不升级插件、不写 install record，也不写活 active local marketplace/runtime view；需要 user-scope native runtime 的写命令会在真正调用平台 native 能力前 materialize active view。

```bash
aw init [-f|--force] [--catalog-channel <dist-tag>|--catalog-version <semver>]
```

- `-f, --force`：绕过已匹配的 cache 快路径，强制重新拉取和重建匹配 selector 的 catalog/cache，但不会删除仍被安装位置或恢复证据引用的 historical runtime
- `--catalog-channel <dist-tag>`：本次预热使用显式 dist-tag；`aw init --channel <dist-tag>` 是兼容别名
- `--catalog-version <semver>`：本次预热使用显式 exact catalog version；与 `--catalog-channel` 互斥
- selector 只影响本次命令，不修改持久默认 channel，也不会污染其它 channel 或 exact version 的离线 fallback

稳定版 CLI 默认解析 `@yiliang/aw-plugins-manifest@latest`，prerelease / beta CLI 默认解析 `@yiliang/aw-plugins-manifest@beta`。`latest` catalog 只接受 stable catalog version 和 stable 插件 version；`beta` catalog version 必须是 prerelease，且可包含 stable 或 prerelease 插件 version。

如果 latest catalog 的最低 CLI 版本高于当前 `aw`，CLI 不会写入这个不兼容 catalog，而是按 sidecar manifest 的 history 查询同一轨道里仍支持当前 CLI 的最新历史 catalog。history 不可用、schema 不支持或内容非法时返回 `catalogHistoryUnavailable`；有效 history 确认没有兼容 catalog 时返回 `awVersionTooLow`。解析出合法 catalog identity 后，匹配 cache 会作为快路径使用；如果强制刷新或远程校验失败，匹配 cache 仍可作为 fallback。远程不可用且没有匹配 cache 时，需要 current catalog 的命令返回 `catalogUnavailable`。这些场景都不会回退到 CLI 包内 embedded catalog。

同一组 catalog selector 也用于 `aw install`、`aw upgrade`、`aw reinstall`、`aw status`、发现类入口，以及未安装或未消费 store 上需要 current catalog schema 的 `aw config list/get/set/unset`。直接命令的 JSON / verbose 输出会展示请求 selector、实际 catalog identity、latest blocked 状态，以及 cache source 或 fallback 证据。

---

### `aw`

`aw` 主命令是唯一交互入口。TTY 环境下直接运行 `aw` 会打开插件管理控制台，首页按 `异常`、`可升级`、`已安装`、`未安装` 分组展示插件；详情页承载安装、升级、配置、卸载、清理、重装和重新应用配置动作，状态页只展示状态详情。子命令只服务脚本化调用，不会弹出 prompt。

```bash
aw
```

主控制台复用 `aw status --json.consoleItems` 的状态投影：首屏合并 current catalog、install record、project artifact identity、native evidence、dynamic diagnostic cache 和 dependency index；同名插件多个位置只显示一个 item，执行写动作前必须先选明确位置。用户可见页面不会显示诊断入口、raw command 或字符串 `nextSteps`。安装和升级向导固定先选插件、平台和位置，再执行只读安全预检；触发策略在配置页管理，不在安装目标页选择。只有预检通过后，才进入 required config 表单。非 TTY、`CI=true` 或 prompt 不可用时，直接运行 `aw` 不会挂起，会返回清晰错误、可复制的脚本化命令示例和 `--json` 机器输出提示。

配置向导只在 `aw` 主控制台中提供。脚本里请使用 `aw config set/unset/reset` 写入配置。

---

### `aw install`

```bash
aw install [插件名...] [-s project|user] -p codex|claude|both [--adopt-existing] [--script-timeout <ms>] [-j|--json]
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-s, --scope` | `user` | `user`：安装到用户全局目录（`~/.claude/` 或 `~/.codex/`）；`project`：安装到当前目录（`.claude/` 或 `.codex/`） |
| `-p, --platform` | 必填 | 显式选择 `claude`、`codex` 或 `both`；`both` 按每个插件当前支持平台集合展开 |
| `--script-timeout` | 插件 manifest 或 `30000` | 覆盖 lifecycle 脚本超时，单位毫秒，合法范围 `1000..300000` |
| `--adopt-existing` | 关闭 | 只允许 project scope；fresh clone 后仓库已有可验证 repo-visible artifacts 和 project artifact identity、本机缺少 install record 时，用它创建本机 record 并认领共享产物 |
| `--catalog-channel` | 当前 CLI 默认轨道 | 本次命令显式使用某个 catalog dist-tag；不改变持久默认 channel |
| `--catalog-version` | 无 | 本次命令显式使用某个 exact catalog version；与 `--catalog-channel` 互斥 |
| `-j, --json` | 关闭 | stdout 输出单一 JSON receipt，包含 `receiptSchemaVersion: 2`、`ok`、`command`、`plugins`、`targets`、`actions`、`artifacts`、`native`、`warnings` 和结构化 `nextSteps` |

一次安装多个插件：

```bash
aw install git-commit another-plugin -p claude
```

如果目标插件声明了 `dependencies.plugins`，`aw install` 会在写入任何状态前先解析完整依赖图。缺失依赖会自动安装；已经安装但低于 `dependencies.plugins[].minVersion` 的依赖会自动升级；已经健康满足的依赖不会重复安装，但父插件的依赖引用会刷新。默认输出会说明哪些插件是自动依赖，`--json` receipt 中自动依赖 target 会带 `requested: false` 和 `dependencyOf`。

`install --adopt-existing` 是 project fresh clone 的认领入口。它不会覆盖普通外部 evidence，也不会把已有有效 install record 当成需要认领的目标；如果共享产物或 identity 无法验证，命令会在写入前失败，并提示先查看 `aw status --verbose` 的状态详情。

---

### `aw uninstall`

```bash
aw uninstall [插件名...] [-s project|user] -p codex|claude|both [--script-timeout <ms>] [--remove-config] [-j|--json]
```

参数与 `install` 相同。卸载会清理当前 scope 里 AW 管理的平台原生注册、repo-visible artifacts、project artifact identity、dynamic diagnostic cache 和 install record，但默认保留 AW 自管配置；需要在主体卸载成功后同时删除当前 target scope/store 的 AW 自管配置时，传 `--remove-config`。Codex project scope 只清理当前仓库里 AW 管理的 repo-visible artifacts，不会删除用户级 Codex native plugin 状态。`--json` receipt 会包含清理动作、native 结果、artifact 结果、配置处理结果、warnings 和 next steps。

如果目标仍被其它已安装插件依赖，`aw uninstall` 会拒绝单独卸载，并提示先卸载依赖它的插件。父插件成功卸载后，AW 会反向检查自动依赖：如果某个自动安装的依赖没有可信 incoming edge，只给出手动处理建议，不会自动删除。`aw uninstall` 仍然依赖可信 dependency index 做跨 scope 删除保护；但 `aw cleanup` 是用户显式确认的残留收口入口，只要 AW 能定位到要删的残留，并且没有已知 dependents，命令就会继续执行，不再把用户卡回“重装一遍”或手动改文件。

`aw uninstall` 只处理有有效 install record、且能安全标准卸载的目标。record 损坏、native 状态不完整、可认领 project 产物、AW-owned 残留、外部归属冲突、shared runtime owner 冲突或依赖元数据异常时，命令会在删除前失败，并给出稳定 reason code 和下一步入口；需要收口异常状态时，改用 `aw cleanup` 或 `aw reinstall`。`cleanup` 默认保留配置，且不运行 uninstall lifecycle。

---

### `aw upgrade`

```bash
aw upgrade [插件名...] [-a|--all] [-s project|user] -p codex|claude|both [--script-timeout <ms>] [-j|--json]
```

- 指定插件名，或用 `-a, --all` 升级当前 scope 下所有已管理的插件
- 触发策略不再是升级参数；需要调整时使用 `aw config` 或主控制台配置页
- 显式升级会先安装缺失依赖、再升级已安装依赖，最后升级用户指定的父插件；父插件失败时不会提交失败父插件的依赖引用
- current catalog 来自最新兼容远程 catalog、历史兼容 catalog，或已经解析出允许使用的 catalog identity 后命中的匹配 cache；latest catalog 被当前 CLI 阻止时，不会显示成插件可升级
- 若插件的能力（instructions / permissions / hooks / native hooks / agents）发生变更，CLI 会先卸载再重新安装
- `upgrade --all` 只把用户显式保留的安装作为根，从 current catalog 展开依赖图；孤立 auto dependency 不会被当作用户目标，旧 edge 中已经不再需要的自动依赖不会阻塞父插件升级
- `upgrade --all` 只处理 `catalogCompatibility=current` 且 scope 已初始化的插件；缺失、能力变更、外部 marketplace 管理、project artifact identity 损坏、项目配置不可读、shared runtime owner 冲突或 install options 无法恢复时会把对应 target 放入 `skipped[]`
- `upgrade --all` 的默认输出会同时展示成功和跳过摘要；部分成功部分跳过时退出码为 `0`，全部 target 都 skipped 且没有成功升级时退出码为 `1`
- `--json` receipt 包含 `upgraded`、`skipped`、`targets`、`actions`、`native`、`artifacts`、`warnings` 和 `nextSteps`

---

### `aw status --verbose`

```bash
aw status [插件名...] [-s project|user] [-p codex|claude|both] [--verbose] [-j|--json]
```

`status --verbose` 是统一只读排查入口。它不执行 lifecycle、不修复文件，详细说明当前证据来自哪些层：current catalog、平台现场、project artifact identity、install record、dynamic diagnostic cache、historical lifecycle runtime、dependency index、shared runtime owner、native transaction marker 和配置状态。原先需要深度诊断才能看到的信息迁移到这里；不再提供额外的 `--deep` 用户选项。

- dependency index 不可信时，verbose / JSON 会把它作为诊断或写命令 blocker 展示；遇到 stale project reference 时会给出 token，并要求用户显式运行 `aw cleanup --dependency-index --prune-stale <token> --yes`。
- project shared/local config、路径型配置和 ignore 规则问题会在这里汇总，方便在写命令前修正。
- verbose / JSON 会展示 catalog selector、实际 catalog identity、catalog 最低 CLI 版本、latest 是否被当前 CLI 阻止、history schema、cache source 或 fallback 命中的 selector / catalog identity，以及 manifest mismatch、integrity failure 等原始远程错误。

---

### 已移除的旧恢复入口

旧版恢复命令不再是公开入口，也不再提供 dependency index 重建、project adopt 或 shared runtime owner 强制替换参数。新的恢复路径按状态分流：

- project fresh clone 中已有可验证共享产物，但本机没有 install record：使用 `aw install <插件名> -p <platform> -s project --adopt-existing`
- AW-owned 残留、marker-only 或无效 record：使用 `aw cleanup <插件名> -p <platform> -s <scope>`
- 需要按 current catalog 删除后重建：使用 `aw reinstall <插件名> -p <platform> -s <scope>`
- dependency index stale project reference：只使用 `aw cleanup --dependency-index --prune-stale <token> --yes`
- shared runtime owner 冲突：先卸载、cleanup 或调整 owner 对应的有效安装，再重试原写命令

---

### `aw cleanup`

```bash
aw cleanup [插件名...] [-s project|user] [-p codex|claude|both] [--force] [--remove-config] [--dependency-index --prune-stale <token>] [-y|--yes] [-j|--json]
```

`cleanup` 是异常状态和残留的直接收口入口。它覆盖 marker-only、半完成写入、AW-owned 残留、无效 record、native transaction marker、historical runtime 残留、dependency index 引用残留和 shared runtime owner 残留；外部归属证据只作为 blocker 或 skipped item，不会被默认删除。cleanup 不再提供只读 plan 模式：命令通过安全边界后会直接执行，默认保留 AW 自管配置，也不会运行 uninstall lifecycle。

`cleanup --force` 是 direct CLI 的高风险确认，不再额外要求 `--yes`。执行 receipt 会列出 force reason、备份项、跳过项、受影响 dependents、阻断原因和实际未清项；如果无法归类、枚举或证明归属，命令仍会失败并给出人工处理建议。`--remove-config` 只在主体清理成功后删除当前 target scope/store 的 AW 自管配置；主体被阻断或失败时配置会保留。普通插件 cleanup 不接受 `--yes`，`--yes` 只用于 dependency index stale reference prune。

dependency index 的 stale project reference 不会被读命令静默裁剪。只有诊断给出 token 后，才运行：

```bash
aw cleanup --dependency-index --prune-stale <token> --yes
```

---

### `aw reinstall`

```bash
aw reinstall [插件名...] [-s project|user] -p codex|claude|both [-j|--json]
```

`reinstall` 等价于先读取详细状态，再安全移除 AW-owned 状态，最后按 current catalog 重新安装。遇到 project fresh clone 的可认领共享产物时默认停止，提示改用 `aw install --adopt-existing`，避免把团队共享产物当成残留覆盖。触发策略仍由当前 `aw config` effective 值决定，不通过重装参数改写。

`reinstall` 必须拿到 current catalog，不能在 catalog unavailable 时改用 historical runtime 重新铺一遍。旧状态撤销阶段继承 `uninstall` 的安全边界；如果需要运行旧 lifecycle、撤销动态 artifact 或收口 native 副作用，而 historical runtime 缺失或摘要不可信，本次重装会在写入新版本前失败。

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
- 已安装位置的 schema 优先来自 install record 绑定的 historical runtime / manifest；current catalog 不可用时，只要 historical schema 健康且没有 schema conflict，已安装插件的配置读写仍可继续。未安装插件的配置预置或未消费 store 需要 current catalog schema，拿不到时会失败。
- `reset` 是单纯的 config store 级删除，不卸载插件、不清理 runtime artifact，也不处理 native residue。已被安装位置消费的 store 会走 installed-aware write，receipt 暴露 `removedKeys` 和 `artifactRefresh`，删除命中 `refreshKeys` 时按 historical runtime 刷新动态 artifact；schema conflict 时只能作为整 store 清理动作继续，不能任选一个 schema 解释输入。孤立残留 store 才允许确认后 raw 删除，不伪造 schema identity，也不刷新 artifact。存在 store 且未传 `--yes` 时，脚本化命令会确定性失败，不会静默删除；需要交互确认时请运行 `aw` 主控制台。
- `set` / `unset` / `reset` 共用配置写入 helper。JSON receipt 顶层使用 `receiptSchemaVersion: 2`，稳定返回 `updatedKeys`、`removedKeys`、`affectedFields` 和 `artifactRefresh`；sensitive 值不会在默认输出、debug log 或 receipt 中明文出现。

插件名会先经过 config store 路径段安全校验：只允许非空单段名称，拒绝路径分隔符、`.`、`..`、绝对路径和 URL-like 值。

带动态 artifact 的插件会在配置写入后按需刷新已安装产物。刷新只在写入的 key 命中已安装 artifact 的 `refreshKeys` 时触发；未命中时只保存配置。SkillTrigger 内建字段不依赖 `refreshKeys`，保存后走 AW built-in apply pipeline，把当前 effective 触发策略应用到静态 skill、动态 `codex.skill` 和公共 `slashCommands` 生成的固定手动 skill。user 配置写入会刷新 user scope artifact，并在当前仓库也安装了 project artifact 时一并刷新当前仓库；project 配置写入只刷新当前仓库 project artifact，不会改写 user artifact。CLI 不会扫描所有历史项目。刷新执行 renderer 时使用当前 location 的 install record 所引用的 historical bundle，而不是可能已被运行时产物覆盖的本地 marketplace 当前副本；historical bundle 缺失或校验失败时，本次刷新会失败并留下诊断。

刷新使用 artifact render config，而不是 `get/list` 的 effective config：user artifact 只看 `default < user store`，project repo-visible artifact 只看 `default < project shared store` 中可共享的键。user / project local 覆盖不会改变 project artifact identity、config digest 或 stale 判断。如果 renderer、project preflight 或写盘失败，已经写入的 config store 会保留，受影响 artifact 会在 dynamic diagnostic cache 中标记为最近刷新失败，`aw status` 可继续诊断。`aw config ... --json` 会在 receipt 中包含 `artifactRefresh.attempted`、`status`、`triggerKeys`、`artifacts[]`，失败时还会有稳定的 `error` 摘要。

`aw` 主控制台里的“重新应用配置”复用 artifact apply / diagnostic cache 写回路径和 SkillTrigger built-in apply pipeline，但不修改 config store。成功后会更新对应 artifact 的 `lastRefresh` 和 dynamic diagnostic cache，并让触发策略 runtime 与 effective 配置对齐；失败后保留配置，并把新的 `artifactRefresh.error` 或 built-in apply 错误写回 receipt 和后续 status 诊断。脚本化场景通过 `aw config set/unset/reset` 写入配置来触发刷新；不要把重新应用配置指向安装、升级或重装参数。

---

## 脚本化命令与安全预检

`install`、`uninstall`、`upgrade` 和 `config` 子命令不会 prompt。缺少插件名、缺少必填配置、未传 `--yes` 的 reset、非 TTY 或 CI 场景都会确定性失败，并给出可复制命令；需要交互式选择时运行 `aw`。

在 `Codex + project scope` 下，安装候选必须包含 repo-visible artifacts；纯 native-only 插件不能作为项目级安装目标。skills-only、mcp-only、slashCommands-only 和 extensions-only 插件都可以作为项目级候选；带 `apps` 的 Codex project 安装会明确拒绝，请改用 `--scope user` 或拆分插件。

如果插件声明了 required AW config，脚本化 `install` / `upgrade` 会在写入平台状态前先解析 effective config。Codex project install / explicit upgrade / mixed explicit command 的顺序更严格：先做不会写状态的安全预检，包括 project installability、用户级 Codex config external ownership、必要的 `.codex/config.toml` 解析、project artifact identity 和未受管 repo artifact 冲突；这些都通过后，才检查 required AW config。缺少必填项或 `file` / `directory` 路径失效时，子命令会确定性失败，并提示可复制的 `aw config set` 命令或引导运行 `aw` 主控制台。同一插件在 `--platform both` 或重复 target 中只会复用一次重新解析后的 effective config。

---

## Skill 触发策略

Skill 触发策略是 AW 内建配置，不再是安装、升级或重装参数。插件作者必须在 `.agents-plugin/plugin.json` 的 `skillTriggers.<skill>` 中声明显式受管 skill 的默认策略和是否允许用户动态修改：

```json
{
  "skillTriggers": {
    "commit": {
      "defaultTrigger": "auto",
      "allowDynamicTrigger": true
    }
  }
}
```

| 值 | 含义 |
|----|------|
| `manual` | 禁止模型自动触发，但保留用户显式触发入口 |
| `auto` | 允许模型自动触发 |

用户通过 `aw config` 或主控制台配置页修改可动态变更的字段：

```bash
aw config list git-commit -s user
aw config set git-commit aw.skillTriggers.commit.trigger manual -s user
aw config unset git-commit aw.skillTriggers.commit.trigger -s user
```

`defaultTrigger` 是默认真值；未写入内建配置时，effective 值等于 `defaultTrigger`。恢复默认通过 `aw config unset` 或 `aw config reset` 清空覆盖值完成，不能写入 `default` 作为配置值。`allowDynamicTrigger: false` 的字段只读展示默认策略，历史 `$aw.skillTriggers` 覆盖值会被标记为 ignored，不参与 effective、runtime patch、status 或 drift 判断。

对动态 `codex.skill`，AW apply 阶段按当前 effective 触发策略 patch `agents/openai.yaml`：`auto` 会让 `policy.allow_implicit_invocation` 为 `true`，`manual` 会改为 `false`。renderer 输出的模板不是最终触发真值；配置保存和主控制台“重新应用配置”都复用同一套 resolver 与 built-in apply pipeline。

`~/.aw` 是本机共享 marketplace。Codex user scope 和 Claude native runtime 仍共享同一用户下同名插件的 runtime skill 文件；同一 plugin/platform 同一时间只有一个 shared runtime owner 可以控制这份 runtime。shared runtime owner 文件只保存 owner 身份和完整性证据，不保存触发策略真值；owner 冲突只作为 blocker、diagnostic 或状态详情展示。解决方式是卸载、cleanup 或调整 owner 对应的有效安装后重试原写命令。Codex project scope 例外：它只改当前仓库的 `.agents/skills/<skill>/agents/openai.yaml`，不参与 shared runtime owner 合同、`aw init` replay 或本地 marketplace rebuild replay。

SkillTrigger 的公开 JSON 读写合同：

- `aw config list/get --json` 顶层使用 `configSchemaVersion: 2`，主数据结构是 `fields`。
- AW 注入字段使用逻辑 key `aw.skillTriggers.<skill>.trigger`，并标记 `kind: "builtIn"`、`reserved: true`。
- `aw config set/unset/reset --json` 顶层使用 `receiptSchemaVersion: 2`，通过 `affectedFields` 回显本次触碰的字段身份。
- project scope 的 SkillTrigger effective 值只由默认值和 project shared 配置决定；project local 中的旧 `$aw.skillTriggers` 只能作为 invalid 存量值展示，不能改变 repo-visible runtime。

---

### `aw status`

```bash
aw status [插件名...] [-s project|user] [-p codex|claude|both] [-j|--json]
```

不指定插件名时，显示 AW 管理过或平台可发现的插件摘要。`status` 的 `--scope` 和 `--platform` 是过滤条件；不传 `--platform` 时按 `both` 查看所有有状态证据的真实平台。需要全部平台时使用 `both`，需要单平台时使用 `codex` 或 `claude`。

默认输出是日常状态面板，包含：

- 状态摘要：每个位置的顶层状态只会是 `installed`、`notInstalled`、`cleanupRequired` 或 `external`
- 位置摘要：展示用户可理解的位置、原因和可执行下一步；默认文案不展示内部诊断词
- 下一步：给出最可能的确认或恢复入口，例如 `aw status <plugin> --verbose`、`aw upgrade <plugin> -p both`、`aw install <plugin> -p both`、`aw cleanup <plugin> -p <platform> -s <scope>` 或 `aw reinstall <plugin> -p <platform> -s <scope>`

友好状态投影由 status、主控制台和 JSON 共用。有效 install record 是唯一安装真值；project artifact identity、dynamic diagnostic cache、dependency index、historical runtime、native marker 和 shared runtime owner 只能进入 reason、diagnostic、cleanup / reinstall 删除范围或 command blocker，不能单独把顶层状态改成已安装。默认输出只展示用户可理解的四态和摘要；内部状态文件、低层 runtime 细节和诊断字段只出现在 `--verbose` / `--json` 或 debug log 中。可复制命令、argv、flag、JSON 字段和类型名保留真实技术标识。

`--verbose` 会展开诊断字段，包括平台检测、native plugin 状态、scope 初始化状态、install record、catalog 兼容性、managed evidence、shared runtime owner、config/script health、generated artifacts、dynamic diagnostic cache、project artifact identity、dependency index 和 drift warnings。Codex project scope 的默认状态面板以本机 install record 为安装真值；仓库里有可验证 repo-visible artifacts 和 identity、但本机没有 record 时，顶层状态是 `external`，reason 是可认领 project 共享产物，并指向 `install --adopt-existing`。动态 artifact 会单独展示 skill / instruction / role 等 artifact health，常见状态包括 healthy、disabled by config、missing、content drift、config digest stale 和 recent refresh failed。user 配置写入没有扫描历史项目时，`refreshReach` 会说明本次已刷新 user / 当前 project，以及其它已知 project target 是否可能仍 stale。`status` 只读，不会执行 lifecycle、不会执行 artifact renderer、不会刷新 marketplace、不会启动 `codex app-server`、不会创建配置目录；失效的 `file` / `directory` 配置会显示为 `invalid-config`。配置驱动的 runtime drift 会指向配置页或主控制台“重新应用配置”。`-j, --json` 输出稳定 JSON schema；即使和 `--verbose`、`--debug` 叠加，stdout 也只包含可直接 `JSON.parse` 的 JSON。

依赖状态也只读展示。`status --json` 中每个位置的 `dependencies` 会包含 `declared`、`resolved`、`satisfied`、`missing`、`dependents`、`autoInstalled`、`autoRemovable`、`catalogDrift` 和 `dependencyIndexTrusted`。`missing` 表示当前健康层确实缺依赖；`catalogDrift` 表示 current catalog 和 record 里的依赖声明不同，不会单独把旧安装判成缺失依赖。`autoRemovable=true` 是只读投影，表示该位置是未显式保留的自动依赖且当前没有其它插件引用；status 和主控制台不会因此自动删除它。

`status --json` 顶层使用 `statusSchemaVersion: 2`，并输出 `consoleItemsSchemaVersion: 3`、`ok`、`command`、`friendlySummaries` 和 `consoleItems`。`statusSchemaVersion: 2` 管理 status 顶层 envelope 和 `status --verbose --json` 详细结构；每个 location 的顶层 `state` 只允许 `installed`、`notInstalled`、`cleanupRequired`、`external`。`consoleItemsSchemaVersion: 3` 管理主控制台 summary shape、结构化 `nextSteps`、SkillTrigger 公共投影和旧 SkillTrigger 字段移除。功能入口放在 `features`，不输出旧 `locations[].actions[]`、命令数组、确认文案或 TUI 页面字段；真正的执行动作由主控制台在用户选择功能和明确 target 后生成。

主控制台首页按用户任务分组，而不是扩展新的状态机：

| 首页分组 | 来源 |
|---|---|
| `异常` | `cleanupRequired`、普通 `external`、缺配置、owner 冲突、dependency blocker 等需要用户处理的条目 |
| `可升级` | 顶层仍为 `installed`，且 current catalog 显示有可升级版本 |
| `已安装` | 顶层为 `installed`，没有更高优先级提示 |
| `未安装` | 顶层为 `notInstalled`，或 catalog 可发现但本机无安装证据 |

详情页承载 install、upgrade、uninstall、cleanup、reinstall、adopt existing 和 reapply config 等动作；状态页只展示状态详情。用户可见页面不出现诊断入口、raw command、字符串 `nextSteps` 或旧恢复模型。

Codex user native 的 JSON 字段有一个重要变化：`native.pluginInstalled` 表示 Codex cache 中已经 materialize 出可用 active version；`native.pluginEnabled` 表示用户级 config 中 `[plugins."<plugin>@aw"].enabled === true`；native transaction marker 表示 native 写入已经发生但 AW record 还没成功提交。因此 enabled-only、cache-only、marker-only 只会作为 diagnostics、command blocker 或 `cleanupRequired` 细节暴露，不再被解释成完整安装。

---

## JSON schema 迁移说明

公开 JSON 版本边界固定如下：

| 字段 | 版本 | 管理范围 |
|---|---:|---|
| `statusSchemaVersion` | `2` | `aw status --json` 顶层 envelope、顶层字段和 verbose 详细状态 |
| `consoleItemsSchemaVersion` | `3` | `consoleItems` summary shape、结构化 `nextSteps`、SkillTrigger 公共投影 |
| `configSchemaVersion` | `2` | `aw config list/get --json` 的 `fields` 主结构 |
| `receiptSchemaVersion` | `2` | 写命令 receipt、target/action、结构化 `nextSteps`，以及配置写命令的 `affectedFields` |
| `nextStepsSchemaVersion` | `1` | 同层 `nextSteps` 结构化对象数组 |

暴露 `nextSteps` 的对象必须同时带 `nextStepsSchemaVersion: 1`。读配置命令使用 `configSchemaVersion: 2`，写配置命令使用 `receiptSchemaVersion: 2`；两者不能互相冒充。

---

## Scope 与 Platform 说明

### Scope

| | `project` | `user` |
|---|---|---|
| 写入位置 | 当前项目目录下的 `.claude/`；Codex 写当前仓库的 `.agents/skills` 和 `.codex/` | `~/.claude/` 或 `~/.codex/`，并按需使用 `~/.aw` native runtime |
| 适用场景 | 项目级配置，提交到版本控制 | 跨项目共享的个人配置 |

> **Codex 注意**：`--scope user` 使用 Codex native plugin 平面。AW 会先通过 `codex plugin marketplace add <canonical ~/.aw>` 注册或重新指向本地 marketplace，用 `codex plugin marketplace list` 校验，再通过 `codex plugin add/remove` 完成安装或卸载，并做写后本地证据校验；AW 不回退到只写或只删 `~/.codex/config.toml`。`codex app-server` 的 `plugin/list`、`plugin/installed`、`plugin/read` 只用于 `status --verbose`、native view 和诊断详情这类只读视图，不是普通写命令主链路。`--scope project` 不写 `~/.codex/config.toml [marketplaces]` 或 `[plugins]`，也不调用 Codex native CLI / app-server；它只写当前仓库的 repo-visible artifacts，并维护 `.agent-workflows/project-artifacts/` 下的 shared identity metadata，但写入前仍要求本机 Codex `>= 0.145.0`。

### Platform

| 值 | 行为 |
|---|---|
| `claude` | 仅安装到 Claude Code |
| `codex` | 仅安装到 Codex |
| `both` | 安装、升级时按每个插件当前支持平台集合展开；恢复动作时处理所有可定位目标 |

如果插件声明了 `marketplace.policy.products`，安装和升级时会拦截不匹配的平台；省略该字段表示不限制平台。绑定真实插件 target 的写入口必须显式传 `--platform codex|claude|both`；`aw status` 未传平台时按 `both` 读取状态。

---

## 安装后生成的文件

安装成功后，CLI 会在对应目录写入以下产物：

**Claude**
- `.claude/rules/aw-<名称>.md` — instructions 文件
- `.claude/settings.json` — 合并 permissions 配置，并在 `awGenerated` 下记录 CLI 生成部分，尽量保留手写权限
- Claude hooks 来自插件 bundle 内的 `claude/hooks/hooks.json`，由 Claude Code 原生插件加载；CLI 不会把它作为额外 repo-visible hook 文件写入项目目录

**Codex project scope**
- `.agents/skills/<skill>/` — Codex project scope 的 repo skill；静态 skill、动态 `codex.skill` 和公共 `slashCommands` 生成的 manual-only skill 都会以受管 identity 记录
- `.codex/config.toml` — 追加 managed instructions block，写入动态 `developer_instructions` block、Codex agent role 注册项和 `mcp_servers`；动态 `codex.skill` 不要求 `.codex/config.toml`。MCP server key 保留 rendered `.mcp.json` 的原始属性名，包含点号、空格或 Unicode 时使用 TOML quoted key，例如 `[mcp_servers."acme.tools v1"]`
- `.codex/rules/*.rules` — Codex execpolicy `prefix_rule(...)` 权限规则
- `.codex/hooks.json` — Codex `hooks.<Event>[]` 钩子配置，包含公共 hooks 和 `extensions.nativeHooks.codex`
- `.codex/agents/*.toml` — Codex agent role 文件

Codex project scope 的 `.codex/hooks.json` 是共享文件。CLI 只替换自己通过 artifact identity 确认拥有的 hook groups，手写配置或其它工具写入的 runtime-valid groups 会原样保留。Codex user scope 的 hooks 不写这里；它们随 native bundle 进入 `.codex-plugin/plugin.json` 的 `hooks` 字段，由 Codex `>= 0.145.0` 原生插件生命周期加载。历史上由 AW 写到 user scope `.codex/hooks.json` 的旧 hook groups 本期不迁移、不接管；缺少 ownership evidence 时也不会自动删除。

安装成功后，AW 会为当前 location 写入独立 install record v2。record 只保存归属、必要安装选项、安装来源和 canonical outgoing dependency edges；它是本机安装真值，但不是健康状态数据库，也不是 SkillTrigger 真值来源。project scope 还会在 `.agent-workflows/project-artifacts/<platform>/` 写入可提交的 shared identity metadata，用于 fresh clone 后识别“可认领”的共享产物。动态 artifact 的 accepted state、`configDigest`、`contentDigest`、`lastRefresh` 和 `refreshReach` 写入 dynamic diagnostic cache，供 `status` / `status --verbose` 只读展示。

带 lifecycle、AW config 或动态 artifact renderer 的插件会保存最小 historical runtime / snapshot。普通 `uninstall` 和必要 `reinstall` 撤销阶段会用它运行安装时的 lifecycle；配置触发的 dynamic artifact refresh 和 refresh-only 会用它执行安装时的 renderer；已安装位置的 config schema 也优先来自这份 historical manifest。它不作为 current catalog 或新依赖声明的来源。

project scope 的本机私有状态和本机配置会默认加入 ignore：`.claude/.agent-workflows/`、`.codex/.agent-workflows/`、`.agent-workflows/plugin-config.local/`。团队共享输入不能默认忽略：`.agent-workflows/plugin-config/` 和 `.agent-workflows/project-artifacts/` 应随仓库提交。

---

## 常用短选项

| 短选项 | 长选项 | 适用命令 |
|---|---|---|
| `-s` | `--scope <scope>` | `install` / `uninstall` / `upgrade` / `status` |
| `-p` | `--platform <platform>` | `install` / `uninstall` / `upgrade` / `status` |
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
aw install git-commit -p both
aw status        # 确认安装成功
```

### 升级所有插件

```bash
aw upgrade -a
```

### 迁移到新机器

新机器上重新执行 `aw init` 和 `aw install` 即可恢复需要 native runtime 的本机 marketplace 与平台原生注册。Codex project scope 的 repo-visible 文件（如 `.agents/skills/`、`.codex/config.toml`、`.codex/rules/`、`.codex/hooks.json`）随项目存在；如果仓库里已有可验证的 project artifact identity，本机缺少 install record 时，先运行：

```bash
aw install git-commit -p codex -s project --adopt-existing
```

认领会在当前机器创建 project install record，并按 current catalog 重新应用共享 artifacts。用户级配置仍需要在新机器上重新安装或重新设置。

---

## 故障排查

### 安装中断或状态需要处理

安装、卸载或升级过程中断后，先用只读命令确认状态：

```bash
aw status git-commit
aw status git-commit --verbose
```

常见处理路径：

```bash
aw reinstall git-commit -p codex -s user
aw cleanup git-commit -p codex -s user
```

依赖功能依赖完整的 `installSource` 和 `dependencyEdges` metadata。若 install record 缺少这些字段、edge 不完整，或 dependency index 不可信，依赖相关安装、升级和普通卸载保护仍会保守失败；先用 `aw status --verbose` 看具体位置，再通过显式升级或重新安装受影响插件补齐记录。遇到 stale project reference 时，按状态或 receipt 给出的 token 运行 `aw cleanup --dependency-index --prune-stale <token> --yes`。`aw cleanup` 不再把这类索引问题当成硬前置，只要能定位残留并确认当前没有已知 dependents，就允许显式收口。

### 自动依赖无法安装或升级

自动依赖和显式目标使用同一套 preflight。常见失败原因包括：依赖插件不在当前 AW catalog、依赖插件不支持父插件当前 platform、user scope 父插件声明了 project scope 依赖、Codex project scope 依赖没有 repo-visible surface、依赖缺少 required config，或多个父插件通过 `inheritInstallOptions: true` 给同一个自动依赖传入冲突安装选项。

处理时先运行：

```bash
aw status <插件名> --verbose
```

缺配置时按提示对依赖插件运行 `aw config set <依赖插件> <key> <value> -s <scope>`；scope 不匹配时需要改用合适的 `--scope` 安装父插件，或由插件作者调整 `target.scope`。如果自动依赖需要特殊 SkillTrigger 策略，先用 `aw config set <依赖插件> aw.skillTriggers.<skill>.trigger manual|auto -s <scope>` 写入配置，再安装父插件。

### 插件安装后 AI 看不到 instructions

先执行 `aw status` 查看友好摘要和下一步；需要定位具体运行时可见性时，再执行 `aw status --verbose` 查看诊断字段：

- `blockedByProjectTrust`：Codex 项目信任未开启，需在 Codex 中将项目标记为 trusted
- `shadowedByProjectDeveloperInstructions`：被项目自定义 instructions 覆盖
- `absent`：文件未正确生成，尝试重新安装

### 提示"插件已由外部 marketplace 管理"

Codex project scope 安装 / 显式升级时，如果用户级 `~/.codex/config.toml [plugins]` 中已有同名外部 native plugin，CLI 会在写入任何 repo artifact 前拒绝，避免运行时歧义。已有 project artifact identity 或 install record 的 `status` 会继续以当前仓库的安装状态为主，把 external ownership 作为附加诊断和下一步；`uninstall -p codex -s project` 只清理 AW 管理的 repo artifacts，不删除用户级 native plugin。

### Codex native CLI 或 native view 诊断失败

`aw install <plugin> -p codex -s user` 和 `aw uninstall <plugin> -p codex -s user` 需要 Codex `>= 0.145.0` 提供 `codex plugin add/remove` 和 `codex plugin marketplace add/list/remove`。如果 CLI 不可用、命令失败、marketplace 未指向当前 canonical `AW_HOME`，或写后本地证据无法证明 plugin 已安装/已移除，命令会失败并给出可行动建议。AW 不会退回到只写 enabled config 或只删 config；请先升级/修复 Codex CLI 或 workspace policy，再重试同一条 `aw install` / `aw uninstall`。`codex app-server` 只影响 verbose/native view 只读诊断，RPC 不可用会显示 `nativeViewUnknown`，不会阻断 Codex CLI 写入主链路。

排查时建议加 `--verbose` 或 `--debug`。debug event 会区分：

- `native:marketplace`：marketplace add / list / remove，失败通常是 `codex plugin marketplace add <canonical ~/.aw>` 不可用或注册后未指向当前 AW_HOME。
- `native:plugin`：`codex plugin add/remove` 写入，失败会带 `pluginId`、`errorCategory` 和 `suggestion`。
- `native:post-check`：CLI 写入后检查 enabled config、config entry 和 active cache；install 要求 enabled config + active cache 同时存在，uninstall 要求 config entry 不存在且 active cache 不存在。
- `native:transaction`：native transaction marker 写入、更新或删除；它说明 AW 是否能把残留纳入 cleanup 范围。
- `native:skipped`：Codex project 路径不会写 native 状态，reason 为 `project_repo_managed_skipped_native`。

### Codex user native marker

Codex user native CLI 写入成功后，AW 会写入短生命周期 native transaction marker，再继续 post-check、lifecycle、artifact apply 和 install record 提交。只要后续步骤失败，`aw status --verbose` / `aw status --json` 都会把 marker-only 作为 diagnostic、command blocker 或 `cleanupRequired` 细节展示。

常见状态和处理方式：

- `pending_after_native_write`：Codex native 写入已发生，AW 后续步骤未完成。可重试同一条 `aw install`；如果状态已经进入 `cleanupRequired`，运行 `aw cleanup <plugin> -p codex -s user` 清理残留。
- `post_check_failed`：Codex CLI 返回成功，但 enabled config 或 active cache 缺失。AW 不会 config-only fallback；先修复 Codex CLI / marketplace，再重试 install 或 uninstall。
- `lifecycle_failed`、`record_write_failed`、`diagnostic_write_failed`：native 已写入，AW 后续持久化或脚本失败。重试同一条 install 可重新走写入收口；cleanup 可用 marker 授权清理残留。
- `cleanup_failed`：native 卸载大概率已执行，但 cache/config 或 marker 清理未收口。重新运行 `aw cleanup <plugin> -p codex -s user`，必要时按 receipt 建议加 `--force`。

如果 marker 写入本身失败，命令会立即失败，并提示 AW 不能承诺后续自动 cleanup 授权。此时先运行 `aw status --verbose` 检查 config/cache，再决定是否修正文件权限或手动处理。marker-only cleanup 会清 config/cache/marker，但不会运行 uninstall lifecycle；marker-only upgrade 会明确失败，`upgrade --all` 会跳过。

### `upgrade --all` 跳过 code

`upgrade --all` 的 direct command 返回值包含稳定 `skipped[]`。CLI receipt 会展示 code 和原因。首版 code 如下：

`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`projectArtifactIdentityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`、`dependencyIndexUntrusted`、`sharedRuntimeOwnerConflict`。
