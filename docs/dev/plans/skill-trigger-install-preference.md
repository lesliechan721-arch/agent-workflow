# Skill 安装触发偏好计划

## 结论

当前插件的 skill 触发策略已经分散在平台原生文件里：

- Codex：`skills/<skill>/agents/openai.yaml` 的 `policy.allow_implicit_invocation` 控制自动触发；显式 `$skill-name` 仍可手动触发。
- Claude Code：`skills/<skill>/SKILL.md` frontmatter 的 `disable-model-invocation` 控制模型自动触发，`user-invocable` 控制用户手动入口。

CLI 现在只在 build 阶段把 `skills` 目录复制到 `plugins-dist`，安装时注册 `~/.aw` 里的本地 marketplace，不会按用户偏好改写 skill 文件。因此新增“安装时触发偏好”需要补一层 agent-workflows 自己的安装 contract：

- skill 的默认触发策略继续由平台原生文件定义，避免新增一套和平台字段重复的默认真值。
- 插件作者在源码 manifest 中按 skill 声明是否允许安装时覆盖。
- 用户在 `aw install` / `aw upgrade` 指定 `manual` 或 `auto` 偏好时，只覆盖允许覆盖的 skill；显式选择 `default`、首次安装未指定偏好、或 skill 不允许覆盖时，都按 skill 默认策略安装。已受管 target 重复 `install` 且未指定偏好时，只能在 ledger 为 `available` 时沿用该 target 的 ledger 记录，避免把已有偏好悄悄重置成默认值；ledger 为 `degraded` 时不得隐式继承旧偏好。
- `skillTriggers` / `allowInstallOverride` 的权威来源固定为 embedded / pristine bundle 里的 `.agents-plugin/plugin.json`。`~/.aw/plugins/<plugin>` 只是运行时副本，可以作为 drift / 本地篡改证据，但不能反向决定 install、replay、status 或 sibling conflict warning 的覆盖规则。
- 覆盖只改写本地 marketplace 的平台运行时副本，不回写 `plugins/` 源码，也不改 `packages/cli/plugins-dist/`。
- `~/.aw` 可能被 `aw init --force`、bundle 指纹变化或 layout 修复整体重建；当 `installed.json` 处于 `available` 状态时，重建完成前必须按 ledger 记录 best-effort 重放偏好，不能只在 install / upgrade 时做一次 patch。ledger 已经 degraded 时首版不重放偏好，只保留 pristine bundle，并报告跳过原因。
- embedded pristine skill 文件本身缺失或不可解析时，status / replay / sibling conflict warning / rebuild 语义比较输出 `unknown` 或 skipped warning，不把维护性读路径和重建路径升级成硬失败。只有用户显式 `--skill-trigger manual|auto` 要改写该 skill 时才 fail fast。
- degraded ledger 下允许显式继续执行的 install / upgrade 只信任本次 CLI 解析出的偏好，不再拿旧 sibling scope record 做胜者选举、冲突告警或 replay。当前命令会按本次偏好物化运行时副本；如果显式 `manual|auto` 遇到 malformed pristine skill，仍按显式覆盖合同 fail fast。ledger 继续保持 degraded，`status` 仍把 skill trigger runtime / drift 输出为 `unknown`。
- available ledger 下 scope 卸载后也必须重新选举共享 marketplace 的有效偏好：如果还有剩余 managed scope record，就让最近一次成功写入的记录重新生效；如果没有剩余记录，就恢复 pristine 默认 skill 文件。
- skill 文件物化属于共享 marketplace 的 native state 写入，必须纳入 install / uninstall 失败回滚和 degraded ledger 语义。

首版建议只提供两个覆盖值，外加一个显式回到默认策略的哨兵值：

| 偏好 | Codex 映射 | Claude Code 映射 |
| --- | --- | --- |
| `manual` | `allow_implicit_invocation: false` | `disable-model-invocation: true`，并写 `user-invocable: true` |
| `auto` | `allow_implicit_invocation: true` | `disable-model-invocation: false`，`user-invocable` 从 pristine 默认文件继承 |
| `default` / 首次安装未指定 / 无 ledger 记录 | 不改默认 | 不改默认 |

这里的 `manual` 表示“禁止模型自动触发，但保留用户显式触发入口”。Codex 没有隐藏手动入口的等价字段；Claude Code 的 `user-invocable: false` 只有在使用默认或 `auto` 且默认如此配置时才保留。

## 已调研的当前实现

- `packages/cli/src/types.ts`：`PluginManifestSource` 目前只有 `skills?: string`，不枚举 skill，也没有安装偏好字段；`CommandOptions` 只有 `scope/platform/cwd`。
- `packages/cli/src/utils/manifest.ts`：source manifest 严格拒绝未知顶层字段；新增 contract 必须同步 `types.ts` 和 manifest normalizer。
- `packages/cli/src/generators/local-plugin.ts`：`bundleLocalPlugin()` 会把 `plugin.manifest.skills` 复制到 `./claude/skills` 和 `./codex/skills`，并生成平台 manifest；这是默认策略进入 runtime bundle 的唯一路径。
- `packages/cli/src/utils/local-marketplace.ts`：`ensureLocalMarketplace()` 把 embedded bundle 复制到 `~/.aw`，并保留 `installed.json`。`config.json.bundleFingerprint` 记录 embedded 指纹，但不会重新计算 `~/.aw` 内容是否被改写。
- `packages/cli/src/utils/plugin-catalog.ts`：`resolveCurrentCatalog()` 在 `~/.aw` 缺失、stale 或 layout 不健康时回退到 embedded catalog；现有 status 集成测试已经要求这条路径保持只读，不能为了读状态物化 `~/.aw/plugins/...`。
- `packages/cli/src/utils/plugin-catalog.ts` / `packages/cli/src/commands/common.ts`：当 `~/.aw` fresh 且 layout 健康时，`resolveCatalogPlugins()` 会把 local catalog 里的 bundle 读成当前 `PluginMeta`。如果后续实现把这份 `PluginMeta` 直接传给 skill trigger policy helper，手工改写过的 `~/.aw/plugins/<plugin>/.agents-plugin/plugin.json` 就会污染安装覆盖规则。
- `packages/cli/src/commands/common.ts`：`loadPluginTargetsForCommand(..., { ensureLocalMarketplace: true })` 会在 `install` / `upgrade` 进入目标解析前自动重建 `~/.aw`，但当前函数只返回 targets，无法把 `ensureLocalMarketplace()` 的 warning 带回命令输出。
- `packages/cli/src/commands/install.ts`：安装顺序是 `installPlugin()` 注册原生插件，再 `installExtensions()` 写 repo-managed artifacts，最后写 tracking 和 ledger。触发偏好如果要影响原生插件注册，必须在 `installPlugin()` 前完成本地 marketplace 物化，但这一步要按 native state 写入处理，失败时不能留下半完成的共享 `~/.aw` 状态。
- `packages/cli/src/commands/install.ts`：当前 `installTargetsOnPlatforms()` 不拒绝已受管 target，重复 `install` 会再次执行 native install、repo-managed artifacts、tracking 和 ledger 更新；因此未传 `--skill-trigger` 时不能简单等同于“重置为 default”。
- `packages/cli/src/commands/uninstall.ts`：卸载链路会调用 `adapter.uninstallPlugin()`、清理 repo-managed artifacts、回写 tracking 和 ledger，但不会在删除 scope record 后重新计算共享 marketplace 的 skill 触发偏好。
- `packages/cli/src/adapters/codex.ts` / `packages/cli/src/adapters/claude.ts`：现有 scope record 写入只用 `new Date().toISOString()` 生成 `updatedAt`；毫秒级时间戳不能单独承担共享 marketplace 的最后写入者选举。
- `packages/cli/src/adapters/codex.ts`：Codex native plugin 只在 user scope 的 `~/.codex/config.toml` 启用；project scope 只是 repo-managed artifacts。skill 策略一旦改写 `~/.aw/plugins/<plugin>/codex/skills`，会影响该用户启用的同名 Codex 插件。
- `packages/cli/src/adapters/claude.ts`：Claude 通过 `claude plugin marketplace add ~/.aw --scope <scope>` 和 `claude plugin install <plugin>@aw --scope <scope>` 安装，但 marketplace source 仍是共享 `~/.aw`。Claude / Codex adapter 里也会再次调用 `ensureLocalMarketplace()` 作为防线；用户可见 warning 不能依赖这层临时吞掉返回值的调用。
- `packages/cli/src/utils/manifest.ts` / `packages/cli/src/generators/local-plugin.ts` / `packages/cli/src/utils/bundle-layout.ts`：CLI 当前只校验 source manifest、声明路径和 bundle 路径存在性，`skills/` 会被原样复制到平台 bundle，不解析 `SKILL.md` frontmatter 或 `agents/openai.yaml` 的内部结构。
- `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md`：作者文档已明确两端触发字段，作者工具 `validate_plugin.js` 也会检查 `openai.yaml.policy.allow_implicit_invocation` 和 Claude frontmatter 字段。这个脚本是作者工具侧校验，不是 CLI build / install 主链路的硬前置条件。
- `package.json` 有 `yaml` 依赖，但 `packages/cli/package.json` 运行时依赖里没有；如果 CLI 要解析 / 改写 YAML，需要把 `yaml` 加到 `@yiliang/aw` 依赖。

## 设计边界

### Source Contract

在 `.agents-plugin/plugin.json` 新增可选字段 `skillTriggers`，按 skill 名声明安装时是否允许覆盖：

```json
{
  "skills": "./skills",
  "skillTriggers": {
    "commit": {
      "allowInstallOverride": true
    }
  }
}
```

规则：

- `skillTriggers` 可省略；省略时所有 skill 都不允许安装时覆盖。
- key 必须对应 source 形态 `skills` 目录下的一个 skill 子目录；这是 source-only 校验，不属于通用 manifest schema 校验。
- `allowInstallOverride` 必须是 boolean。
- 默认触发策略不放进 `skillTriggers`，继续从 `SKILL.md` / `openai.yaml` 读取，避免出现两个默认真值。
- 如果插件没有声明 `skills`，不能声明 `skillTriggers`。
- 安装期读取覆盖策略时，只信任 embedded / pristine bundle 中的这份 manifest。`~/.aw` 里的同名 manifest 只是运行时副本，即使当前 catalog 因 fresh + layout healthy 被判定为 `source: local`，也不能把 local manifest 当成新的 policy 真值。

选择 manifest 而不是 `SKILL.md` frontmatter 的原因：这是 agent-workflows 的安装策略，不是 Claude / Codex 原生字段。放在 `.agents-plugin/plugin.json` 可以避免把 AW 专属字段暴露给平台 runtime，也便于 source manifest 校验。

### 阶段边界

首版不兼容“当前 catalog 已删除，但旧 ledger / tracking 仍残留该插件记录”的 skill trigger replay。这个边界不是对已发布用户数据做破坏性取舍，而是因为该功能还处在开发阶段：目前没有发布过带 `skillTriggers` / `installOptions.skillTriggerPreference` 的构建物，也没有真实用户机器上需要迁移的旧 skill trigger 运行时副本或历史 ledger。`loadPluginTargetsForCommand()` 现有 historical fallback 仍用于 uninstall / status 的基础清理能力，但触发偏好物化只处理当前 embedded bundle 中仍存在、能读取 pristine skill 文件的插件。

因此：

- `initializeLocalMarketplace()` 的 replay 只遍历当前 embedded catalog 中可解析的插件；遇到历史残留记录不尝试重建 skill trigger 文件。
- `uninstall` 后的共享 marketplace 重物化只要求覆盖当前 embedded catalog 中仍存在的插件；historical placeholder 没有 pristine bundle，不纳入首版验收范围。
- 测试计划不把“旧 ledger 指向已删除插件”的 replay 兼容列为首版必测项。

### Degraded ledger 重建策略

首版选择保守策略：只有 `ledger.ledgerState.status === 'available'` 时，`initializeLocalMarketplace()` / `ensureLocalMarketplace()` 的 rebuild 才会从 ledger replay skill trigger 偏好。

当 preserved ledger 是 `degraded` 时：

- `initializeLocalMarketplace()` 仍保留原 `installed.json`，复制 embedded pristine bundle，写入新 `config.json`，但跳过 skill trigger replay。
- 跳过 replay 的原因要通过 `EnsureLocalMarketplaceResult.warnings` 返回，并由所有会自动触发 rebuild 的用户命令输出，包括 `aw init`、`aw install`、显式 `aw upgrade` 和 `aw upgrade --all`。`status` 继续展示 `ledgerState=degraded (...)`，并把 ledger 驱动的 skill trigger drift 判定标成 `unknown`，避免把不可信 ledger 物化成看似正常的共享 marketplace 状态。
- `install` / 显式 `upgrade` 的“未传 `--skill-trigger`”也不能从 degraded ledger 隐式继承偏好。`install` 如果目标已经是当前 scope 的 managed target 且未传参数，应在 native state 写入前拒绝继续，并提示用户显式传入 `--skill-trigger default|manual|auto`；未受管的新安装 target 可以继续按 `default` 安装。显式 `upgrade` 在 degraded ledger 下未传参数时一律拒绝继续，因为 upgrade 语义本身依赖已有安装记录恢复偏好。
- 显式传入 `--skill-trigger default|manual|auto` 时，`install` 和显式 `upgrade` 可以在 degraded ledger 下继续；此时偏好来源是 CLI，而不是 ledger。命令仍必须保留 degraded ledger 状态，并输出前述 rebuild / replay skip warning。
- degraded ledger 下继续执行时，本次命令只允许用“当前目标 + 本次解析出的偏好”决定要写入的 runtime skill 文件，不得读取 degraded ledger 里的 sibling record 来调用 `selectEffectiveSkillTriggerRecord()`、`selectEffectiveSkillTriggerPreference()` 或 `collectSkillTriggerSiblingConflictWarnings()`。因此这条路径不会返回基于旧 sibling 记录的 effective record / conflict warning，也不会因为旧 sibling 记录覆盖用户本次显式偏好。若命令仍更新当前 scope record，可记录本次 `installOptions.skillTriggerPreference` 作为 degraded ledger 的诊断信息，但这些记录在 ledger 恢复为 `available` 之前不能参与 replay、status 确定性 drift 或 sibling 胜者选举。
- `upgrade --all` 首版采用“先 command preparation / `ensureLocalMarketplace()`，再暴露 rebuild warning，最后因 degraded ledger 拒绝继续”的顺序合同。也就是说，它不允许在读取 prepared marketplace 之前先通过 `resolveUpgradeAllPlatforms()` 或 `listManagedPluginNamesForPlatform()` 直接读 `installed.json` 并提前抛错；但 prepared ledger 仍为 degraded 时，`upgrade --all` 仍应拒绝执行，因为批量推断和批量升级不能建立在不可信 ledger 上。CLI 层必须保证拒绝前的 warning 对用户可见，可以用带 `warnings` 的错误类型或在抛错前由命令入口打印准备阶段 warning。
- 这条规则同时适用于 `aw init --force`、config/layout 损坏触发的非 force 修复、bundle fingerprint 变化触发的刷新。
- 后续如果要允许某些 degraded 原因安全 replay，需要单独引入 `canReplaySkillTriggersFromLedger()` 之类的判定函数，而不是默认重放所有 degraded ledger。

### Skill 文件可 patch 合同

首版选择把“运行时 skill 文件是否可安全改写”的硬保证放在 install-time materializer，而不是只依赖 CLI build/layout 或作者工具。

原因是当前 CLI 基线并不解析 `SKILL.md` frontmatter 或 `agents/openai.yaml`，而且 bundle 内的文件才是经过复制 / 模板渲染后的真实运行时输入。`validate_plugin.js` 仍作为作者侧预检和文档示例校验保留，但用户执行 `aw install --skill-trigger manual|auto` 时，不能假设作者一定提前跑过这个脚本。

因此：

- `validatePluginManifest()` / `validateSourcePluginManifest()` / `validateBundleLayout()` 首版仍只承担 manifest schema、source skill key 存在性和 bundle 路径存在性校验，不把完整 frontmatter / YAML 语义校验塞进通用 layout 校验。
- `materializeSkillTriggerPreference()` 是用户显式覆盖的权威兜底：只要本次命令显式传入 `--skill-trigger manual|auto`，且某个 `allowInstallOverride: true` 的 skill 需要按该偏好物化，就必须先校验目标平台运行时文件可解析、可安全重写；缺文件、缺 frontmatter、frontmatter YAML 非法、`openai.yaml` 非法或根结构不符合预期，都要在写 native state 之前 fail fast。
- fail fast 的错误必须指向具体 `plugin / platform / skill / filePath`，不能退化成泛化的 materialize 失败，也不能把用户显式要求的覆盖降级成“跳过并 warning”。warning 只用于“skill 存在但 `allowInstallOverride: false`，所以保留默认策略”这类预期行为。
- materializer / replay 不能变成全量 skill 结构校验器。只有本次确实要按用户显式 `manual|auto` 改写、且 `allowInstallOverride: true` 的 skill，才需要用严格模式解析并校验平台运行时文件；`default`、`allowInstallOverride: false` 的 skill、落选 scope record，以及同一插件里的无关 skill，都必须保持浅校验边界，不能因为内部 YAML / frontmatter 损坏而额外拦截安装、升级或重建。
- ledger 驱动的 replay、未传参数时从 ledger 恢复偏好、status 候选签名、sibling conflict warning 和 rebuild 语义比较都属于 best-effort 推导路径。它们遇到 embedded pristine skill 文件缺失或不可解析时，返回 `unknown` / `skipped` / `cannot determine deterministic signature`，不要把整个命令升级成硬失败；对应 warning 应说明跳过的是 skill trigger 签名、replay 或冲突判断，而不是隐藏错误。
- best-effort replay 如果无法安全按 ledger 中的 `manual|auto` 重放某个 `plugin/platform`，保留 staging 中的 pristine skill 子树，返回 replay skipped warning，并让后续 status 对该 `plugin/platform` 输出 `skillTriggerRuntime=unknown` / `skillTriggerDrift=unknown`。不要因为一次 `aw init --force`、stale refresh、bundle fingerprint refresh 或 `upgrade --all` 只是触发维护性重建，就让用户无法完成命令。
- `default` 物化恢复 pristine 文件；status 做只读语义比对时如果遇到不可解析文件，输出 `skillTriggerRuntime=unknown` / `skillTriggerDrift=unknown`，不尝试修复。

### CLI 参数

给 `install` 增加：

```bash
aw install <插件名...> --skill-trigger manual
aw install <插件名...> --skill-trigger auto
aw install <插件名...> --skill-trigger default
```

并给显式 `upgrade` 增加同名参数：

```bash
aw upgrade <插件名...> --skill-trigger manual
```

语义：

- 不传 `--skill-trigger`：只有 ledger 为 `available` 时，`install` 才对已受管 target 沿用该 `platform / scope / plugin` 的 ledger 偏好；对未受管 target 使用默认策略。`upgrade` 也只在 ledger 为 `available` 时保留 ledger 中上次记录的偏好，没有记录则使用默认策略。ledger 为 `degraded` 时，重复 `install` 的已受管 target 和显式 `upgrade` 都必须拒绝隐式继承，并要求用户显式传入 `--skill-trigger default|manual|auto`。
- `--skill-trigger default`：显式重置为 skill 默认策略，并更新 ledger。
- `--skill-trigger manual|auto`：只覆盖 `allowInstallOverride: true` 的 skill；其他 skill 保留默认策略，并输出 warning。
- 重复 `install` 的“未传参数”和显式 `--skill-trigger default` 必须区分：前者保持已有偏好，后者才是用户主动重置。
- `upgrade --all` 首版不建议接受新的全局覆盖参数；在 prepared ledger 为 `available` 时，默认按每个已安装 scope 的 ledger 记录恢复偏好。prepared ledger 为 `degraded` 时按前述合同拒绝继续。如确实要支持全局重写，需要先确认多插件批量覆盖的交互风险。
- 命令内部不能把偏好建模成“本次命令一个全局 resolved 值”。进入安装循环前先按 `platform / plugin / scope` 解析出 resolved install options；多插件显式 upgrade、单插件双平台 upgrade 都可能从 ledger 恢复出不同偏好。

首版不做 per-skill CLI 选择，例如 `commit=manual,review=auto`。原因是当前需求表达的是用户级偏好，且多插件安装时 per-skill 语法会显著增加解析和错误提示复杂度。源码 contract 已经按 skill 建模，后续可以扩展命令参数。

### 运行时物化

不能直接长期在 `~/.aw/plugins/<plugin>` 上做增量 patch，否则一次 `manual` 安装会污染后续默认安装。每次 install / upgrade / rebuild / uninstall 后有效策略变化，都要从 pristine embedded bundle 重新物化目标平台 skill 文件，再按 resolved 偏好改写；没有剩余有效偏好时恢复 pristine 默认。

这里的 pristine / embedded 指 `packages/cli/plugins-dist` 或测试中注入的 embedded root。`~/.aw` 只提供当前 runtime 文件和安装位置，不能提供 `skillTriggers` policy map；如果 local manifest 和 embedded manifest 不一致，应把它视作本地运行时 drift / 篡改证据，而不是新的覆盖策略。

建议新增工具模块 `packages/cli/src/utils/skill-trigger-preferences.ts`：

- 从 embedded root 读取 pristine 平台 skill 文件：
  - `plugins/<plugin>/claude/skills/<skill>/SKILL.md`
  - `plugins/<plugin>/codex/skills/<skill>/agents/openai.yaml`
- 从 embedded root 的 `plugins/<plugin>/.agents-plugin/plugin.json` 读取 `skillTriggers` / `allowInstallOverride`，并据此确定需要参与物化和签名计算的 skill 覆盖面；不要从 `target.currentPlugin`、`resolveCatalogPlugins()` 返回的 local `PluginMeta` 或 `~/.aw` manifest 读取 policy。
- 把当前目标平台的 `skills` 子树先复制到 staging 目录，只重置当前平台，避免覆盖另一个平台刚应用的偏好。
- 严格物化时只解析本次需要按 `manual|auto` 改写的 `allowInstallOverride: true` skill；`default` 只恢复 pristine，不解析内部结构。候选签名才需要读取默认语义，且必须按 `unknown` 合同退化。
- 如果本次偏好是 `manual|auto` 且 `allowInstallOverride` 为 true，改写目标平台文件。
- 如果偏好存在但 skill 不允许覆盖，保持 pristine 文件并返回 warning。
- staging 完成并校验后，再原子替换 `~/.aw/plugins/<plugin>/<platform>/skills`；替换前保留旧子树快照，供安装失败时恢复。
- `initializeLocalMarketplace()` / `ensureLocalMarketplace()` 的重建路径在复制 embedded bundle 到 staging 后、写入 `config.json` 前，调用 ledger replay，把所有已安装插件的平台 skill 偏好重放到 staging 中，然后再校验 layout 并原子替换 `~/.aw`。
- 上述 replay 只允许在 preserved ledger 为 `available` 时执行；degraded ledger 必须跳过 replay，保留 pristine staging，并返回 warning。
- available ledger replay 仍是维护性 best-effort 路径：某个 `plugin/platform` 的 pristine skill 无法解析时，只跳过该 `plugin/platform` 的偏好重放和确定性 warning，保留 pristine staging，继续处理其他插件 / 平台，并把 skip warning 返回给 CLI。
- available ledger 的 replay 如果由 bundle fingerprint 变化、layout 修复或 `aw init --force` 触发，也可能改变共享 marketplace 的有效物化语义。重建 helper 要在原子替换前比较旧 runtime 与 staging replay 后的新 runtime；如果语义变化让 sibling scope 进入 drift，同样通过 `EnsureLocalMarketplaceResult.warnings` 返回 sibling conflict warning，不能把它当成无声 refresh。
- replay 只根据 ledger 中仍为 `managed: true` 的 scope record 生效。由于 `~/.aw` 是共享 marketplace，同一个 `plugin/platform` 不能同时存在多份策略；如果多个 scope 记录偏好不同，选择最近一次成功写入的 scope record 作为当前本地 marketplace 的有效策略，并在 status 中对其他 scope 报 drift warning。
- 胜者选举只在 `available` ledger 上有确定语义，并且必须复用同一套 `selectEffectiveSkillTriggerRecord()`，不能在 replay、uninstall、status、sibling conflict warning 中各自排序。degraded ledger 下允许继续的显式 install / upgrade 直接按本次 resolved preference 物化，不调用这套 sibling 选举。排序合同是：
  - 优先按 scope record 顶层的 `skillTriggerWriteOrder` 降序选择；每次 install / upgrade 成功写入 available ledger scope record 时，为当前 `plugin/platform` 写入 `max(existing skillTriggerWriteOrder) + 1`。
  - 旧 ledger 记录缺少 `skillTriggerWriteOrder` 时按 `0` 参与排序；如果所有候选都缺少该字段，继续按 `updatedAt` 降序作为兼容 fallback。
  - 如果 `skillTriggerWriteOrder` 和 `updatedAt` 都并列，按稳定 scope identity 升序兜底，例如 `user`、`project:<normalizedProjectKey>`。这个兜底只用于旧数据或手工构造数据，保证结果不依赖对象遍历顺序；新写入路径不能依赖它表达最后写入。
- available ledger 下，所有会写入 managed scope record 的命令（`install`、显式 `upgrade`、`upgrade --all` 内部逐项升级）都必须在写 ledger 前用“写入后的候选 ledger”和计划中的物化结果计算同一 `plugin/platform` 的新有效 runtime 语义。warning 的触发条件比较的是“共享 marketplace 的有效物化语义”，不是只比较 effective record 的 scope identity：只要本次命令让有效物化语义发生变化，并让其他 managed sibling scope 的期望物化结果与新运行时语义不等价，命令必须立即返回 warning；warning 至少说明当前生效的 scope / preference，以及哪些 sibling scope 会进入 drift。首版不采用 status-only 暴露冲突。
- available ledger 下，`uninstall` 删除某个 scope record 后，必须基于删除后的 ledger 重新选举同一 `plugin/platform` 的有效偏好并重物化当前平台 skill 子树；没有剩余 managed record 时，把该平台 `skills` 子树恢复为 pristine embedded bundle。

注意：`~/.aw` 是共享 marketplace。首版的触发偏好是“本地 marketplace 中某插件某平台的当前生效策略”，不是可并存的 per-project 策略。尤其 Codex native plugin 是 user scope 启用，同一用户下不同项目无法同时使用同名插件的不同 native skill 触发策略。文档和命令期 warning 都要把这个边界说清楚，避免用户在一次成功安装/升级后静默改变其他 scope 的运行时偏好。

## 实现步骤

### 1. 类型与 manifest 校验

- 在 `packages/cli/src/types.ts` 增加：
  - `SkillTriggerPreference = 'default' | 'manual' | 'auto'`
  - `SkillTriggerPolicy { allowInstallOverride: boolean }`
  - `PluginManifestSource.skillTriggers?: Record<string, SkillTriggerPolicy>`
  - `InstalledScopeInstallOptions { skillTriggerPreference?: SkillTriggerPreference }`
  - `InstalledScopeRecord.installOptions?: InstalledScopeInstallOptions`
  - `InstalledScopeRecord.skillTriggerWriteOrder?: number`
  - `ResolvedInstallOptions { skillTriggerPreference: SkillTriggerPreference; skillTriggerSource: 'cli' | 'ledger' | 'default' }`
  - `EnsureLocalMarketplaceResult.warnings?: string[]`
  - `CommandWarningError` 或等价结构化错误类型，用于失败路径携带已产生的 warnings、错误信息和 exit code
- `InstallCommandOptions.requestedSkillTrigger?: SkillTriggerPreference` / `UpgradeCommandOptions.requestedSkillTrigger?: SkillTriggerPreference` 只表示 CLI 原始覆盖值；基础 `CommandOptions` 不承载 resolved 偏好，安装循环也不得把原始 CLI 值当成所有 target 的最终偏好。
- 在 `packages/cli/src/utils/manifest.ts`：
  - `validatePluginManifest()` 只负责通用 schema：允许顶层 `skillTriggers`、校验 `skills` 缺失时不得声明 `skillTriggers`、校验每个 entry 只允许 `allowInstallOverride`，并保留 bundle source manifest 中的字段。
  - `validateSourcePluginManifest()` 负责 source-only 存在性检查：读取 source `skills` 目录并确认 key 对应真实 skill 子目录。
  - `readPluginManifest(..., { mode: 'bundle' })` 不能假设 bundle root 下还有 source 形态的 `./skills` 目录。
- 更新 `createBundleSourceManifest()`，确保 `skillTriggers` 写入 bundle source manifest。
- 更新 `packages/cli/src/utils/bundle-layout.ts`，让 layout 校验覆盖新字段的 schema 与保留行为；如果需要校验 bundle 中的 skill 目录存在性，只能基于 `./claude/skills/<skill>` / `./codex/skills/<skill>` 或平台 manifest 的 `skills` 路径，不能用 source `./skills`。layout 校验首版不负责解析 frontmatter / `openai.yaml`，这层交给 install-time materializer fail fast。

### 2. CLI 解析与命令流传递

- 在 `packages/cli/src/index.ts` 增加 `parseSkillTriggerPreference()`。
- `install` 增加 `.option('--skill-trigger <preference>', 'default | manual | auto')`，并传入 install 专用 command options。
- `upgrade` 增加同名 option；显式 upgrade 使用传入值，未传时只在 ledger 为 `available` 时从 ledger 恢复，ledger 为 `degraded` 时拒绝继续。
- `upgrade --all --skill-trigger ...` 首版直接报错，避免一次命令批量覆盖多插件的共享 marketplace 策略。
- 新增 `resolveInstallOptionsForTargets()`：
  - `install`：传了 `--skill-trigger` 就使用 CLI 值；未传且 ledger 为 `available` 时，如果当前 `platform / scope / plugin` 已有 managed scope record，则沿用该 record 的 `installOptions.skillTriggerPreference`；available ledger 没字段或 target 未受管则为 `default`。未传且 ledger 为 `degraded` 时，如果目标已是当前 scope 的 managed target，拒绝继续并要求显式传入 `--skill-trigger`；未受管 target 使用 `default`。
  - 显式 `upgrade`：传了 `--skill-trigger` 就使用 CLI 值；未传且 ledger 为 `available` 时按当前 `platform / scope / plugin` 的 scope record 读取 ledger，available ledger 没字段则为 `default`。未传且 ledger 为 `degraded` 时拒绝继续，不能从 degraded ledger 读取或推断旧偏好。
  - `upgrade --all`：prepared ledger 为 `available` 时，按每个已安装 scope record 的 ledger 偏好恢复，available ledger 没字段则为 `default`；prepared ledger 为 `degraded` 时拒绝继续。
  - 返回以 `platform + plugin + scopeKey` 为 key 的 resolved map，`installTargetsOnPlatforms()` 只读取这张 map 或 resolver callback，不直接读取全局 CLI 值。resolved entry 要带上偏好来源，例如 `preferenceSource: 'cli' | 'ledger' | 'implicit-default'`，供后续选择 strict explicit 还是 best-effort replay。
- `resolveInstallOptionsForTargets()` 要在进入安装循环前读取 ledger 快照和 ledger state；同一命令里先装单平台再处理另一平台时，不能让前一个 target 的写入污染后一个 target 的解析结果，也不能在 degraded ledger 下因为前一个 target 写入了 CLI 偏好，就让后一个未传参 target 继承这份不可信快照。
- `resolveInstallOptionsForTargets()` 在 degraded ledger 下只能判断“当前 target 是否必须显式传参”和“本次偏好来自 CLI 还是默认值”，不得把 degraded sibling record 传给后续胜者选举或 conflict warning helper。显式继续执行时，resolved map 中要标记 `ledgerTrust: 'degraded-explicit'` 或等价状态，安装循环据此跳过 sibling 选举和 warning。
- `loadPluginTargetsForCommand()` 或新的 command preparation helper 必须把 `ensureLocalMarketplace()` 结果里的 warnings 一起返回给 `install` / `upgrade`，并汇入命令 result.warnings。adapter 内部保留的 `ensureLocalMarketplace()` 只能作为幂等防线，用户命令不能把首次 rebuild 放到 adapter 层才发生，否则 degraded replay warning 会被吞掉。
- command preparation 需要同时区分“当前 catalog / runtime target”和“embedded policy source”。`target.currentPlugin` 可以继续表示当前可安装目标或 historical fallback，但 install / replay / status 的 skill trigger policy 必须通过 embedded catalog 按 `pluginName` 解析得到；如果当前 local bundle manifest 与 embedded manifest 不一致，命令可以返回 drift / tamper warning，但后续 resolved options、materialize、signature 和 conflict warning 都继续使用 embedded policy。
- `upgrade --all` 必须先执行同一层 command preparation，再进入 `resolveUpgradeAllPlatforms()`、`listManagedPluginNamesForPlatform()` 和后续 target 解析。`resolveUpgradeAllPlatforms()` 不能继续自己读取未 prepared 的 ledger；`listManagedPluginNamesForPlatform()` 应接收 prepared ledger 快照或由 preparation helper 返回的 managed plugin 列表。prepared ledger 如果仍是 degraded，`upgrade --all` 要在 warning 可见后拒绝继续，不承诺成功输出 result。
- 同一命令里如果 command preparation 和 adapter 防线都调用了 `ensureLocalMarketplace()`，只允许输出一次 rebuild warning；可以通过命令入口先完成 ensure、后续 adapter 调用只命中新鲜 marketplace 来避免重复。
- CLI 入口层要有失败路径 warning 合同：当命令在 preparation 后决定报错（例如 degraded ledger 下的 `upgrade --all`，或显式 upgrade 未传 `--skill-trigger`）时，已经产生的 warnings 仍必须先对用户可见。推荐新增 `CommandWarningError`（或等价结构化错误），携带 `warnings`、原始 error message 和 exit code；`index.ts` 的统一 catch 负责先去重打印 warnings，再打印错误。若选择在命令层抛错前直接打印，也必须保证所有入口行为一致，并有 CLI 入口测试覆盖。
- 为了让 CLI 入口测试保持 build-free，把当前 `index.ts` 里的 Commander 组装拆成可从源码直接调用的入口，例如 `buildProgram({ cwd, env, stdout, stderr })` / `runCli(argv, io, env)`。`#!/usr/bin/env node` 的 bin 文件只负责把真实 `process.argv`、`process.cwd()`、`process.env` 和 `console` 接进去；测试直接 import 这个入口并注入内存 stdout / stderr，覆盖参数解析、warning 顺序和 exit code，不依赖 `packages/cli/dist/index.js` 或真实 `plugins-dist`。
- `status` 首版不接收该参数，但输出中必须展示当前 scope ledger 记录的偏好，以及当前共享 marketplace skill 文件和哪些候选偏好语义等价；不要把运行时文件强行反推成唯一的 `default|manual|auto`。

### 3. 物化与 patch 工具

新增 `utils/skill-trigger-preferences.ts`：

- `resolveSkillTriggerPolicies({ embeddedRoot, pluginName })`：只从 embedded / pristine bundle 的 `.agents-plugin/plugin.json` 读取 policy，返回 skill 名、是否允许覆盖、平台文件路径和可用于诊断的 embedded manifest path。不要接收泛化的 `plugin: PluginMeta`，避免调用方把 local catalog `PluginMeta` 误传进来。
- `materializeSkillTriggerPreference({ pluginName, platform, resolvedOptions, embeddedRoot, marketplaceRootOrStagingRoot, env })`：
  - 不在 helper 内重新调用 `ensureLocalMarketplace()`，避免 rebuild replay 时递归；调用方负责确保本地 marketplace 已可用，或显式传入 staging root。
  - policy map 只能来自 `resolveSkillTriggerPolicies({ embeddedRoot, pluginName })`；runtime 写入目标只能来自 `marketplaceRootOrStagingRoot`。这两个来源在类型和参数名上必须分开，不能用同一个 `plugin` 对象同时表达“策略来源”和“运行时位置”。
  - 从 embedded root 复制目标平台 skill 子树到临时 staging。
  - 对本次确实需要改写的 `allowInstallOverride: true` skill，读取必要的 pristine 字段并按 resolved 偏好改写。
  - 调用方必须显式传入物化模式，例如 `strictExplicit` / `bestEffortReplay`。`strictExplicit` 用于用户显式传入 `--skill-trigger manual|auto` 的 install / explicit upgrade；`bestEffortReplay` 用于 ledger 恢复、rebuild replay 和 `upgrade --all` 这类维护性路径。
  - `strictExplicit` 下，校验 staging 中本次需要解析 / 改写的目标 skill 文件结构；对 `allowInstallOverride: true` 且本次 resolved 偏好为 `manual|auto` 的 skill，缺少 `SKILL.md` frontmatter、frontmatter YAML 非法、缺少 `agents/openai.yaml`、`openai.yaml` YAML 非法或根结构不是 object，都要在提交前报错，错误信息包含具体路径。
  - `bestEffortReplay` 下，遇到 embedded pristine skill 文件缺失或不可解析时，不提交该 `plugin/platform` 的偏好覆盖；保留从 embedded bundle 复制出的 pristine skill 子树，返回 `skipped` summary 和 warning，供调用方把 status / drift / conflict 判断标成 `unknown`。
  - `default` 路径只复制 pristine 子树，不解析 platform skill 内部结构；`manual|auto` 路径也不能解析不允许覆盖或与本次改写无关的 skill。
  - 完成必要校验后，原子替换目标 `skills` 子树，并返回 applied summary、warnings、`committed` 状态和 rollback handle。
- `buildSkillTriggerMaterializationSignature({ pluginName, platform, preference, embeddedRoot })` 或等价 helper：
  - 从 pristine bundle 计算某个偏好最终会落成的语义签名，用于 status 和 sibling conflict warning；签名只表达平台真正消费的触发语义，不依赖 YAML 文本格式、字段顺序或注释。
  - 签名必须纳入 `allowInstallOverride` 覆盖面和 pristine 默认值，所以 `default` 与 `auto` 在某个插件版本上可能语义等价，也可能不等价。
  - 签名 helper 是只读推导路径，不能因为 embedded pristine skill 文件缺失、frontmatter / YAML 不可解析或根结构异常而抛出导致调用命令失败；应返回结构化 `unknown` 结果，包含 `plugin / platform / skill / filePath / reason`，由 status 输出 unknown，由 conflict warning/replay 选择跳过确定性判断。
  - 对 `upgrade` / `upgrade --all`，warning 比较应使用本次命令将要提交的新 bundle / 新物化结果；即使 effective scope identity 和偏好字符串都没变，只要新 bundle 导致有效语义变化，也要进入 conflict 判断。
- `readCurrentSkillTriggerRuntimeSignature({ pluginName, platform, marketplaceRoot, embeddedRoot })` 或等价 helper：
  - status 只在当前 `~/.aw` 是可信 local marketplace 且 ledger 为 `available` 时读取现有 runtime skill 文件；会写入的 rebuild / install / upgrade 路径可以在替换前读取旧 marketplace 中 layout 仍可定位的 skill 子树，用来判断本次命令是否改变了共享 marketplace 的有效物化语义。
  - 读取 runtime 文件时也要用 embedded policy 决定覆盖面和候选签名；不能因为 `marketplaceRoot/plugins/<plugin>/.agents-plugin/plugin.json` 被删改，就少看某个 skill 或改变 `allowInstallOverride`。
  - 读取不到、不可解析、旧 layout 已无法定位，或 ledger 是 degraded 时，不能生成确定性 sibling conflict warning；对应状态交给 `status` 输出 `unknown`。
- `replaySkillTriggerPreferencesFromLedger({ ledger, marketplaceRoot, embeddedRoot, env })`：
  - 调用方必须先检查 ledger 状态；只有 `available` ledger 可以 replay。若保留在 helper 内处理，也必须在 degraded 时直接返回 `skipped` summary 和 warning，不能写 staging skill 文件。
  - 遍历 ledger 中仍 managed 的 scope record。
  - 对同一 `plugin/platform` 调用 `selectEffectiveSkillTriggerRecord()`，选择同一套排序规则下的有效记录作为共享 marketplace 的有效偏好。
  - replay 只物化每个 `plugin/platform` 的有效记录；落选 scope record 只参与胜者选举，不能触发额外文件解析或让重建失败。
  - 如果调用方传入旧 marketplace root / 旧 runtime signature，replay 要比较旧 runtime 与 staging 中的新 runtime；只要有效物化语义变化并让 sibling scope 语义不等价，就返回同一类 sibling conflict warning。
  - replay 过程中遇到 embedded pristine skill 文件缺失或不可解析时，按 best-effort 合同跳过该 `plugin/platform` 的偏好重放和 sibling conflict warning，保留 pristine staging，并返回可见 warning；不要丢弃整个 staging，也不要把 `aw init --force`、stale refresh 或 `upgrade --all` 变成硬失败。
  - 只处理 embedded bundle / 当前 catalog 中仍存在的插件；历史残留记录不属于首版 replay 范围。
  - replay 的插件存在性、`skillTriggers` 覆盖面和 pristine skill 文件全部从 embedded bundle 解析。local `~/.aw` manifest 只允许作为旧 runtime drift 证据，不能影响 replay 覆盖范围。
  - 在 `initializeLocalMarketplace()` 的 staging root 上重放；best-effort skipped 不算致命失败，其他 staging / IO / 原子替换错误才直接丢弃 staging，不改旧 `~/.aw`。
- `getNextSkillTriggerWriteOrder({ ledger, pluginName, platform })`：
  - 只对 `available` ledger 承诺全局有序语义。收集同一 `plugin/platform` 所有 scope record 顶层的 `skillTriggerWriteOrder`，忽略缺失或非法值，返回最大值加一；没有现有序号时返回 `1`。
  - `install`、显式 `upgrade`、`upgrade --all` 每次准备写入 available ledger scope record 时都使用它，确保同一毫秒内的多次写入也有确定顺序。
  - degraded ledger 下显式继续执行时，不得用旧 sibling record 计算胜者；如果实现仍给当前 scope record 写入 `skillTriggerWriteOrder`，该值只能作为诊断信息，不能被 replay、status drift 或 conflict warning 当成可信排序依据。
- `selectEffectiveSkillTriggerRecord({ ledger, pluginName, platform })`：
  - 只接收 `available` ledger，或由调用方保证输入是可信候选视图；不能把 preserved degraded ledger 原样传进来做 sibling 胜者选举。
  - 从删除或写入后的 ledger 视图中收集仍为 `managed: true` 的 scope record。
  - 返回按 `skillTriggerWriteOrder desc`、`updatedAt desc`、`scopeIdentity asc` 排序后的第一条记录；没有剩余记录时返回 `null`。
  - 返回值包含 scope identity、偏好、write order、`updatedAt` 和 record 引用，供 replay、uninstall、status 和 sibling conflict warning 共用。
- `selectEffectiveSkillTriggerPreference({ ledger, pluginName, platform })`：
  - 包装 `selectEffectiveSkillTriggerRecord()`；同样只对 available ledger 承诺确定语义。没有剩余记录时返回 `default`，并标记需要恢复 pristine。
- `collectSkillTriggerSiblingConflictWarnings({ ledgerBefore, ledgerAfter, pluginName, platform, writtenScope })`：
  - 只接收 `available` ledger；degraded ledger 下的显式继续执行路径必须跳过这个 helper，不能基于不可信 sibling record 生成 warning。
  - 比较写入前可信 runtime 语义和写入后计划 runtime 语义，而不是只比较 effective record 的 scope identity。effective scope 没变但偏好从 `default` 改成 `manual`、或 bundle 升级导致同一偏好落成不同语义时，也可能需要 warning。
  - 如果任一参与比较的 runtime / candidate signature 是 `unknown`，返回 `skipped` warning 或 diagnostics，不生成确定性 sibling conflict warning，也不让调用命令失败。
  - 只要本次写入后的有效 runtime 语义与写入前不等价，并且存在其他 managed sibling scope 的期望物化结果与新有效 runtime 语义不等价，就返回 warning。
  - 如果 effective scope 切换但物化语义等价，或 sibling scope 的期望语义与新 runtime 等价，不要提示；warning 要去重，不能把当前 scope 或语义一致的 sibling scope 报成 drift。
  - install / explicit upgrade / upgrade --all 都复用这套判断，避免不同命令的共享 marketplace 提示不一致。
- `rematerializeSkillTriggerPreferenceAfterUninstall({ pluginName, platform, ledgerAfterUninstall, embeddedRoot, marketplaceRoot, env })`：
  - 复用 install 侧的 staging、校验、原子替换和 rollback handle。
  - 和 install 物化一样，policy 与 pristine skill 文件只从 `embeddedRoot` 读取；`marketplaceRoot` 只作为 runtime 写入目标。
  - 只在 baseline ledger 为 available 时，按删除后的 ledger 重新物化共享 marketplace；没有剩余 managed record 时从 embedded pristine 恢复目标平台 `skills` 子树。
  - degraded ledger 下首版不做 sibling 重选；调用方要跳过该 helper 或让 helper 返回 skipped warning，不能拿旧 sibling record 恢复所谓“剩余胜者”。
  - 对 historical target 或当前 catalog 缺失插件首版 no-op，并保留现有 uninstall 清理能力。
- `rollbackMaterializedSkillTriggerPreference(handle)`：
  - 如果 materialize 已提交且后续 `installPlugin()` / `installExtensions()` / tracking / ledger 写入失败，恢复旧 `skills` 子树。
  - rollback 失败时把 `installed.json` 标记为 `operation_interrupted_after_native_write`。
- `patchCodexOpenAiYaml(filePath, preference)`：
  - 使用 `yaml` 解析。
  - 要求文件存在且 YAML root 是 object；`policy` 缺失时可以创建，`policy` 存在但不是 object 时 fail fast。
  - 写入 `allow_implicit_invocation`。
- `patchClaudeSkillFrontmatter(filePath, preference)`：
  - 只处理以 `---` 开头的 YAML frontmatter。
  - frontmatter 缺失、结束分隔符缺失、YAML 非法或 frontmatter root 不是 object 时 fail fast。
  - `manual`：写 `disable-model-invocation: true` 和 `user-invocable: true`。
  - `auto`：写 `disable-model-invocation: false`，不强改 pristine `user-invocable`。

同时把 `yaml` 加入 `packages/cli/package.json` 的 dependencies。

### 4. 安装、升级与 ledger

- 在 `installTargetsOnPlatforms()` 中，在 `adapter.installPlugin()` 前读取当前 target 的 `ResolvedInstallOptions` 并调用 `materializeSkillTriggerPreference()`。只有 `preferenceSource === 'cli'` 且偏好是 `manual|auto` 时使用 `strictExplicit`；从 ledger 恢复的 `manual|auto`、`upgrade --all` 的逐项恢复，以及隐式 default 都使用 best-effort / pristine 语义，不能让 malformed pristine skill 把维护性路径变成硬失败。
- 调用物化前必须解析 embedded policy source，并把它和当前 local runtime target 分开传递。`target.currentPlugin` 仍可用于现有 adapter 安装和 status 检查，但不能作为 `skillTriggers` 的事实来源。
- materialize 一旦提交，就把本次操作视为 native state 已写入；如果后续步骤失败，先恢复 materialize 快照，恢复失败或 adapter native state 已写入时按现有 degraded 机制写入 `operation_interrupted_after_native_write`。
- 物化过程自身必须是 subtree staging + 原子替换；如果提交前失败，不改 `~/.aw`；如果提交后失败，走 rollback。
- `mayWriteNativeState()` 继续只表达 adapter `installPlugin()` 是否可能写原生平台状态；skill trigger 物化单独用 `marketplaceWritten` / `materializationCommitted` 之类的状态位纳入同一个失败处理分支，不能依赖现有 helper 隐式覆盖。
- 扩展 ledger scope record，记录：

```ts
installOptions?: {
  skillTriggerPreference?: SkillTriggerPreference;
};
skillTriggerWriteOrder?: number;
```

- `applyClaudeInstallLedger()` / `applyCodexInstallLedger()` 接收当前 target 的 `ResolvedInstallOptions`，并写入当前 scope record。available ledger 写入时同时设置 scope record 顶层的 `skillTriggerWriteOrder = getNextSkillTriggerWriteOrder(...)`，不能只依赖毫秒级 `updatedAt` 表达顺序。
- 上述 `skillTriggerWriteOrder` 的确定排序语义只对 available ledger 成立。degraded ledger 下显式继续执行时，当前 scope record 可以记录本次 CLI 偏好，但安装循环不能用 degraded sibling record 推导新的 effective record，也不能返回 sibling conflict warning；运行时物化结果以本次 resolved preference 为准，ledger 状态继续 degraded。
- `upgrade`：
  - 显式传入 `--skill-trigger` 时使用新值。
  - 未传且 ledger 为 `available` 时读取该 `platform / scope / plugin` 的 ledger `installOptions.skillTriggerPreference`。
  - 未传且 ledger 为 `degraded` 时拒绝继续，要求用户显式传入 `--skill-trigger default|manual|auto`。
  - available ledger 没有该字段时按 `default`。
- 显式 `upgrade plugin-a plugin-b` 与 `upgrade plugin-a --platform both` 都必须在进入安装循环前生成 per-target resolved map，不能把其中任一偏好提升成全局值。
- `upgrade --all` 在 prepared ledger 为 `available` 时按每个插件各自 ledger 偏好恢复，不做批量偏好重写；如果不同 scope 记录冲突，遵循共享 marketplace 的 `selectEffectiveSkillTriggerRecord()` 选举规则。只要本次逐项升级让共享 marketplace 的有效物化语义发生变化，并让 sibling scope 进入语义不等价的 drift，命令结果必须立即包含 sibling conflict warning；如果新 bundle 的 pristine skill 不可解析导致语义签名为 `unknown`，则跳过该项确定性 conflict warning 并输出 diagnostics。`status` 只负责后续只读展示当前 mismatch，不能作为 `upgrade --all` 的唯一暴露渠道。
- available ledger 下，`install`、显式 `upgrade` 和 `upgrade --all` 每次成功写入某个 scope record 后，都要用写入前可信 runtime 语义、写入后的候选 ledger 和计划物化语义生成 sibling conflict warning。本次写入导致其他 scope drift 时，命令结果必须立即包含 warning；如果只是重写当前 scope，但物化语义没有变化，或 sibling scope 与新有效 runtime 语义一致，则不要提示。不能用“effective record 的 scope 没变”作为不提示的充分条件。若任一参与比较的签名为 `unknown`，只能返回 skipped diagnostics，不能生成确定性 warning，也不能因此让命令失败。
- `uninstall`：
  - 在现有卸载步骤完成后，先基于 baseline ledger 计算删除当前 scope record 后的 `nextLedger`，再调用 `rematerializeSkillTriggerPreferenceAfterUninstall()`，最后写入 `nextLedger`。
  - 只有 baseline ledger 为 `available` 时，卸载后的共享 marketplace 才按剩余 sibling record 重新选举并重物化。baseline ledger 为 `degraded` 时，首版不能用旧 sibling record 做重选；若卸载流程仍允许继续，应跳过 sibling re-election，保留 degraded 状态，并输出 skill trigger 重选已跳过的 warning，后续 `status` 继续输出 `unknown`。
  - 如果重物化提交后失败，先回滚 marketplace skills 快照；回滚失败或前面已经写过 adapter native state 时，把 ledger 标记为 `operation_interrupted_after_native_write`。
  - 如果重物化在提交前失败，不应改写 `~/.aw`；但如果 native state、artifacts 或 tracking 已经发生变化，仍按现有 degraded 规则处理。
  - available ledger 下，Codex project scope 卸载虽然不会删除共享 user native plugin state，也必须触发本地 marketplace 偏好重选，因为该 project scope 的 ledger 偏好可能正是当前 `~/.aw` 的胜者。
- `initializeLocalMarketplace()`：
  - 读取并保留旧 `installed.json`。
  - 如果旧 `~/.aw` 仍能读取目标平台 skill 子树，在替换前捕获 available ledger 下各 `plugin/platform` 的旧 runtime 语义，用于判断本次 rebuild / bundle refresh 是否造成 sibling drift。
  - 复制 embedded bundle 到 staging。
  - 如果 preserved ledger 是 `available`，按 ledger best-effort 重放 skill trigger 偏好到 staging，并把 replay 过程中发现的 sibling conflict warning 或 skipped diagnostics 返回给调用方。
  - replay 使用 embedded manifest / embedded skill 文件计算 policy 和签名。旧 `~/.aw` 只允许用来读取替换前 runtime 语义，不能用旧 local manifest 决定哪些 skill 要 replay。
  - replay 某个 `plugin/platform` 时如果 embedded pristine skill 缺失或不可解析，跳过该项偏好重放和确定性 conflict warning，保留 pristine staging，继续完成本次 marketplace 重建，并通过 warning 暴露具体文件和原因。
  - 如果 preserved ledger 是 `degraded`，跳过 replay，保留 pristine staging，并把 warning 返回给 CLI；不要因为重建成功而把 ledger 洗回 `available`。
  - 写入 preserved ledger 和新 config，校验 layout 后再原子替换 `~/.aw`。
- `initCommand()` / CLI `init` 输出 `EnsureLocalMarketplaceResult.warnings`，让用户知道 degraded ledger 下没有 replay skill trigger 偏好。
- `installCommand()`、显式 `upgradeCommand()` 和 `upgrade --all` 的目标解析 / command preparation 阶段也必须输出同一类 warning；不要只在 `aw init` 暴露，也不要在 adapter 内部各自临时拼接。`upgrade --all` 在 degraded ledger 下的最终合同是“warning 可见后拒绝继续”，不是“成功返回 warning result”。

### 5. Status 与文档

- `PluginStatusReport` 增加可选 `installOptions` / `skillTriggerPreference` 字段，并增加只读 runtime 对比结果，例如 `skillTriggerRuntimeMatches?: SkillTriggerPreference[]`、`skillTriggerRuntimeState?: 'matched' | 'mixed' | 'unknown'`、`skillTriggerDrift?: 'yes' | 'no' | 'unknown'`。
- `status` 输出每个插件当前 scope record 记录的偏好：`skillTriggerLedger=default|manual|auto`。
- `status` 的 skill trigger runtime 比对必须继承现有 catalog 只读合同：只有 `resolveCurrentCatalog()` 返回 `source: 'local'`，并且本地 marketplace 已通过 layout / freshness 校验时，才允许读取 `~/.aw/plugins/<plugin>/<platform>/skills`。如果当前 catalog 因 `~/.aw` 缺失、stale、bundle fingerprint 不匹配或 layout 不健康而回退到 embedded，status 仍可基于 embedded catalog 展示插件基础状态和 ledger 偏好，但 skill trigger runtime / drift 一律输出 `unknown`，且不能为了比对去修复、物化或读取不可信的本地 skill 文件。
- `status` 同时从 pristine embedded bundle 的 manifest policy 和平台 skill 文件分别计算 `default`、`manual`、`auto` 三种期望物化结果，再和可信的当前 `~/.aw` 平台 skill 文件做语义比对；如果 embedded pristine skill 本身缺失或不可解析，候选签名直接进入 `unknown`，不要因为算不出三种候选而让 status 失败：
  - 当前文件只匹配一个偏好时输出对应值，例如 `skillTriggerRuntime=manual`。
  - 当前文件同时匹配多个偏好时输出候选集合，例如 `skillTriggerRuntime=matches(default,auto)`；这不是 drift，ledger 为其中任一值都算匹配。
  - 当前文件无法对应任何一个单一偏好，但各 skill 呈现不同候选或用户手工改写时输出 `skillTriggerRuntime=mixed`，并按 ledger 期望直接比较后决定 drift。
  - 文件缺失、解析失败、插件已不在当前 catalog、当前 catalog 不是可信 local，或 ledger 是 degraded 时输出 `skillTriggerRuntime=unknown` / `skillTriggerDrift=unknown`。
- drift 判断不要先反推出唯一 runtime 偏好再和 ledger 比；应直接比较“当前文件是否和当前 scope ledger 偏好的期望物化结果语义等价”。常见 drift 原因包括其他项目/其他 scope 最近安装了同名插件、手工改写 `~/.aw`、或旧版本 CLI 未重放偏好。
- 如果可信 local marketplace 的 `.agents-plugin/plugin.json` 与 embedded manifest 的 `skillTriggers` 不一致，status 可以额外提示 local manifest drift / tamper evidence，但候选签名和 drift 判定仍以 embedded manifest 为准。不能因为 local manifest 删除某个 skill 或改了 `allowInstallOverride`，就把 runtime 误判为匹配。
- status drift 检查不能修改本地 marketplace；它只报告当前状态。
- 更新：
  - `docs/plugin-installation.md`
  - `docs/plugin-authoring.md`
  - `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md`
  - `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`
  - `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js`：新建 skill 默认可先不生成 `skillTriggers`，保持保守不可覆盖；如加参数再生成。
  - `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`

## 测试计划

### Unit

- `manifest.test.ts`
  - 接受合法 `skillTriggers`
  - 拒绝未知字段
  - 拒绝没有 `skills` 却声明 `skillTriggers`
  - source manifest 拒绝指向不存在 skill 目录的 key
  - bundle mode 接受保留 `skillTriggers` 但没有 source `./skills` 目录的 bundle source manifest
- 新增 `skill-trigger-preferences.test.ts`
  - Codex `manual/auto/default` 正确改写或保留 `allow_implicit_invocation`
  - Claude `manual/auto/default` 正确改写 frontmatter
  - Claude pristine 默认 `user-invocable: false` 的 skill：`manual` 会临时写回 `user-invocable: true`；`auto` / `default` 会从 pristine 恢复 `false`，不能永久打开手动入口
  - 不允许覆盖的 skill 保留 pristine 默认，并返回 warning
  - `default` 物化面对内部结构损坏的 `SKILL.md` / `openai.yaml` 时，不解析、不 fail fast，仍从 embedded pristine 恢复目标平台 `skills` 子树
  - `allowInstallOverride: false` 的 skill 即使内部结构损坏，`manual|auto` 也只返回 warning 并保持 pristine，不应被额外解析成安装失败
  - 同一插件存在多个 skill 时，损坏的非覆盖 skill 或无关 skill 不应阻塞另一个允许覆盖 skill 的 `manual|auto` 物化
  - `allowInstallOverride: true` 的 Codex skill 缺少 `agents/openai.yaml`、YAML 非法或 `policy` 不是 object 时，`manual|auto` 物化在提交前失败，错误指向具体文件
  - `allowInstallOverride: true` 的 Claude skill 缺少 frontmatter、frontmatter YAML 非法或 root 不是 object 时，`manual|auto` 物化在提交前失败，错误指向具体文件
  - 先 manual 后 default 会从 embedded pristine 恢复，不残留上次 patch
  - materialize 在提交前失败不改 `~/.aw`，提交后 rollback 能恢复旧子树
  - `buildSkillTriggerMaterializationSignature()` 对 YAML 字段顺序、注释和格式变化不敏感，只比较平台实际消费的触发语义
  - `buildSkillTriggerMaterializationSignature()` 能识别 `default` / `auto` 在某个 fixture 上语义等价，也能识别多 skill 或覆盖面变化导致的语义差异
  - `buildSkillTriggerMaterializationSignature()` 面对 embedded pristine `SKILL.md` / `openai.yaml` 缺失或不可解析时返回结构化 `unknown`，包含具体路径和原因，不抛错中断 status / replay / warning 调用方
  - `bestEffortReplay` 模式下，ledger 恢复 `manual|auto` 遇到 malformed pristine skill 时跳过该 `plugin/platform` 覆盖、保留 pristine 子树并返回 warning；`strictExplicit` 模式下同一 fixture 必须 fail fast
  - `resolveSkillTriggerPolicies()` 只读取 embedded bundle；即使传入的 marketplace/runtime root 下 local manifest 把 `allowInstallOverride` 改成 `false` 或删除某个 skill，policy map 仍保持 embedded 结果
  - `materializeSkillTriggerPreference()` 和 `buildSkillTriggerMaterializationSignature()` 面对被篡改的 local manifest 时，仍按 embedded policy 覆盖和计算候选签名，不把 local manifest 当成事实来源
  - `collectSkillTriggerSiblingConflictWarnings()` 在 effective scope 不变但 runtime 语义变化时会返回 warning，在 scope 切换但 runtime 语义等价时不会误报
  - `collectSkillTriggerSiblingConflictWarnings()` 遇到任一候选签名为 `unknown` 时返回 skipped diagnostics，不生成确定性 conflict warning，也不让命令失败
  - `collectSkillTriggerSiblingConflictWarnings()` 面对 degraded ledger 会拒绝或返回 skipped 状态，调用方不能拿 degraded sibling record 生成确定性 warning
- `local-plugin` / `bundle-layout` 测试确认 `skillTriggers` 进入 bundle source manifest。
- `bundle-layout` 测试确认同一插件 build 成 bundle 后 layout 校验仍通过；`initializeLocalMarketplace()` 复制 bundle 并校验 layout 时不会因为 `skillTriggers` 假设 source `./skills` 目录而误报。若 layout 校验继续保持浅校验，要有测试证明不可解析 skill 文件会在 install-time materializer 报出精确错误，而不是在 layout 阶段被泛化吞掉。
- `installed-ledger.test.ts`
  - 旧账本没有 `installOptions` 仍能通过 validator
  - 新账本带 `installOptions.skillTriggerPreference` 和 scope record 顶层 `skillTriggerWriteOrder` 能通过 validator
  - 非法偏好值、非法 write order 或非法 `installOptions` 结构会被拒绝
- `local-marketplace.test.ts`
  - available ledger 下，`initializeLocalMarketplace({ force: true })` 重建后按 ledger 重放偏好
  - available ledger 下，`initializeLocalMarketplace()` replay 面对同一 `plugin/platform` 的多条冲突 scope record 时，复用 `selectEffectiveSkillTriggerRecord()` 选出同一共享 marketplace 胜者
  - replay 面对同一 `plugin/platform` 的冲突 scope record 时，只物化胜者；落选记录即使是 `manual|auto` 且对应 skill 文件损坏，也不应让 rebuild 失败
  - 两条冲突 scope record 拥有相同 `updatedAt` 时，`skillTriggerWriteOrder` 较大的记录稳定获胜
  - 旧 ledger 记录同时缺少 `skillTriggerWriteOrder` 且 `updatedAt` 相同，scope identity 兜底排序稳定，不依赖对象遍历顺序
  - available ledger 下，config 损坏触发的非 force 修复会重放偏好
  - available ledger 下，embedded bundle 指纹变化触发刷新后会重放偏好
  - available ledger 下，embedded bundle 指纹变化或 `aw init --force` 导致 replay 后的有效物化语义变化时，`EnsureLocalMarketplaceResult.warnings` 会返回 sibling conflict warning；如果语义等价则不误报
  - available ledger 下，`aw init --force`、stale refresh 或 bundle fingerprint refresh 遇到 malformed embedded pristine skill 时，不让 `initializeLocalMarketplace()` 整体失败；对应 `plugin/platform` 保留 pristine、跳过确定性 replay / warning，并通过 `EnsureLocalMarketplaceResult.warnings` 暴露原因
  - `installed.json` 为 `operation_interrupted_after_native_write` 等 degraded 状态时，`initializeLocalMarketplace({ force: true })` 跳过 replay、保留 pristine bundle、保留 degraded ledger 并返回 warning
  - degraded ledger 下的非 force stale refresh / bundle fingerprint refresh 同样跳过 replay
  - warning 内容在 `EnsureLocalMarketplaceResult.warnings` 中稳定返回，调用方可以直接汇入 CLI 输出
  - local marketplace fresh 且 layout 健康，但 `~/.aw/plugins/<plugin>/.agents-plugin/plugin.json` 被手工改写时，replay 仍按 embedded policy 生效；如果实现报告 local manifest drift / tamper warning，warning 不得改变物化结果

### Integration

- `cli.test.ts`
  - `aw install git-commit --platform codex --skill-trigger manual` 后，`~/.aw/plugins/git-commit/codex/skills/commit/agents/openai.yaml` 为 `false`。
  - `--skill-trigger auto` 后恢复 `true`。
  - 未允许覆盖的 fixture skill 即使传 `manual` 也保持默认，并输出 warning。
  - `~/.aw/plugins/git-commit/.agents-plugin/plugin.json` 被手工改成 `allowInstallOverride: false` 或删掉某个 `skillTriggers` entry，但 local catalog 仍 fresh 且 layout 健康时，`install --skill-trigger manual|auto` 仍按 embedded manifest 覆盖。
  - 同样的 local manifest 篡改场景下，rebuild replay、status 候选签名和 sibling conflict warning 的覆盖面仍来自 embedded manifest；不能因为 local manifest 少了 entry 而漏报 drift 或跳过物化。
  - available ledger 下，同一 target 已安装为 `manual` 后，重复 `install` 且未传 `--skill-trigger` 会沿用 ledger 中的 `manual`，不会重置为 `default`。
  - 先 `install --platform codex --skill-trigger manual`，再 `install --platform both` 且未传偏好时，Codex 保持 `manual`，新装 Claude 使用 `default`。
  - 显式 `install --skill-trigger default` 会重置已有 target 的偏好，并和未传参数路径分开测试。
  - available ledger 下，`upgrade` 未传偏好时沿用 ledger 中的偏好。
  - available ledger 下，显式 `upgrade plugin-a plugin-b` 未传偏好时，分别沿用两个插件各自 ledger 中的偏好。
  - available ledger 下，`upgrade plugin-a --platform both` 未传偏好时，Codex 和 Claude 可以恢复各自不同的 ledger 偏好。
  - available ledger 下，`upgrade --all` 对多个已安装插件按 ledger 偏好逐个恢复。
  - `upgrade --all --skill-trigger manual` 报错。
  - 先在一个 scope 安装同一 `plugin/platform` 为 `manual`，再在另一个 scope 安装为 `auto` 或 `default`，验证最新安装成为共享 marketplace 胜者，并且本次 install warning 指出被覆盖的 sibling scope。
  - 同一 `plugin/platform` 的 sibling scope 记录拥有相同 `updatedAt` 时，install / explicit upgrade 的 warning 仍按 `skillTriggerWriteOrder` 稳定判断新胜者，不依赖对象遍历顺序。
  - 当前 scope 已经是共享 marketplace 胜者时，重复 `install --skill-trigger manual|default|auto` 或显式 `upgrade --skill-trigger ...` 只要改变了有效物化语义，就会立刻返回 sibling conflict warning，即使 effective scope identity 没有变化。
  - 当前胜者 scope 显式把偏好从 `default` 改成 `manual`，或从 `manual` 改回 `default`，如果 sibling scope 的期望语义与新 runtime 不等价，会立刻 warning。
  - 显式 `upgrade` / `upgrade --all` 沿用同一 scope 的同一偏好值，但新 bundle 的 pristine skill 文件或 `allowInstallOverride` 覆盖面让实际物化语义变化时，也会返回 sibling conflict warning。
  - 语义等价的重写不会误报：例如某个 fixture 上 `default` 和 `auto` 物化结果一致时，scope 切换或当前 scope 重写不应产生 sibling conflict warning。
  - 旧 scope 执行 `status` 时能看到预期 skill trigger drift；新胜者 scope 不应误报 drift。
  - 显式 `upgrade` 写入导致有效物化语义变化时同样输出 sibling conflict warning；warning 只包含真正被覆盖且语义不等价的 sibling scope，不能重复或误报。
  - `upgrade --all` 写入导致有效物化语义变化时也必须立刻输出 sibling conflict warning；warning 只包含真正被覆盖且语义不等价的 sibling scope，不能把仅由 status 后续展示的 mismatch 当成唯一提示。
  - `upgrade --all` 即使偏好值本身没变，也要在 `skillTriggerWriteOrder` 导致共享 marketplace 胜者切换且 sibling 语义不等价时输出 warning，不能因为“按 ledger 偏好恢复”而漏报本次命令造成的 drift。
  - degraded ledger 下，已受管 target 重复 `install` 且未传 `--skill-trigger` 会在 native state 写入前被拒绝，并提示显式传入 `--skill-trigger default|manual|auto`。
  - degraded ledger 下，显式 `upgrade` 未传 `--skill-trigger` 会在 native state 写入前被拒绝；显式传入 `--skill-trigger` 的路径仍可继续，并保留 degraded ledger 状态。
  - degraded ledger 下，未受管的新安装 target 未传 `--skill-trigger` 仍按 `default` 安装；该路径不能从 degraded ledger 继承历史偏好。
  - degraded ledger 下，显式 `install --skill-trigger ...` / 显式 `upgrade --skill-trigger ...` 即使同一 `plugin/platform` 还残留 sibling scope record，也只按本次 CLI 偏好物化；不会调用 sibling 胜者选举，不会返回基于 degraded sibling record 的 conflict warning，成功后 `status` 仍把 skill trigger runtime / drift 输出为 `unknown`。
  - degraded ledger 下，显式继续执行后写回的当前 scope record 只能作为诊断信息；后续 rebuild / status / warning 不能把这些 degraded 记录突然当成 available ledger 使用。
  - degraded ledger 下执行 uninstall 时，如果实现允许继续，不能用旧 sibling record 重新选举有效偏好；命令应返回跳过 skill trigger re-election 的 warning，`status` 继续输出 `unknown`。
  - 卸载最新胜者 scope 后，剩余 scope record 的偏好会重新成为共享 marketplace 的有效策略。
  - 卸载最新胜者 scope 后，剩余记录里即使存在相同 `updatedAt`，也复用 `selectEffectiveSkillTriggerRecord()` 得到稳定重选结果。
  - 卸载最后一个 managed scope 后，目标平台 `skills` 子树恢复到 pristine 默认。
  - 卸载已写 native state 后重物化失败，会按 native write 失败语义回滚或标记 degraded。
  - 物化成功后 `installPlugin()` 失败会恢复旧 `skills` 子树；恢复失败时 ledger 标记为 degraded。
  - 物化成功后 `installExtensions()` 失败会恢复旧 `skills` 子树并保持 tracking 回滚。
  - available ledger 下，`aw init --force`、stale refresh、bundle 指纹变更刷新后，`~/.aw` 里的 skill trigger 与 ledger 匹配。
  - `aw init --force`、`aw install ...` 因 stale refresh / bundle 指纹变更触发自动重建、显式 `aw upgrade ...` 遇到 degraded ledger 时跳过 replay，并输出 warning。
  - `aw upgrade --all` 遇到 degraded ledger 时，先执行 command preparation 并让 replay skip warning 可见，然后拒绝继续；测试不能期待它成功返回 warning result。
  - `resolveUpgradeAllPlatforms()` / `listManagedPluginNamesForPlatform()` 不会绕过新的 command preparation 读取旧 ledger 视图。
  - 同一条 install / upgrade 命令里即使 command preparation 和 adapter 防线都触发 ensure，也不会吞掉或重复打印 degraded replay warning。
  - `allowInstallOverride: true` 的 skill 文件不可解析时，`aw install --skill-trigger manual|auto` 在 native install 前失败，错误包含具体 platform / skill / 文件路径。
  - malformed embedded pristine skill 下，`aw init --force` / stale refresh / `upgrade --all` 不崩溃，跳过确定性 signature / replay / sibling conflict warning 并输出 warning；只有显式 `install --skill-trigger manual|auto` / 显式 `upgrade --skill-trigger manual|auto` 因同一 skill fail fast。
  - `status` 展示 `skillTriggerLedger` 和 runtime 匹配结果，并在 ledger 期望和 marketplace 当前文件不一致时输出 drift warning。
  - `default` 和 `auto` 物化结果完全相同的 fixture 输出 `matches(default,auto)`，ledger 为两者之一时不误报 drift。
  - 多 skill 默认值不一致的 fixture 能正确比对候选集合，不把 runtime 压成唯一偏好。
  - 手工改成 mixed state 后，`status` 输出 `mixed`，并基于当前 scope ledger 期望报告 drift。
  - `~/.aw` stale 时，`status` 继续保持只读，不物化 `~/.aw/plugins/...`，并把 skill trigger runtime / drift 输出为 `unknown`。
  - `~/.aw` layout 不健康但 `config.json` 看起来新鲜时，`status` 回退 embedded catalog，保持只读，并把 skill trigger runtime / drift 输出为 `unknown`。
  - degraded ledger 下的 `status` 输出 skill trigger drift 为 `unknown`。
  - 本地 marketplace 仍是健康 `source: local` 时，如果目标平台 skill 文件被手工删除，`status` 输出 `skillTriggerRuntime=unknown` / `skillTriggerDrift=unknown`，且命令不崩溃。
  - 本地 marketplace 仍是健康 `source: local` 时，如果目标平台 `SKILL.md` frontmatter 或 `openai.yaml` 不可解析，`status` 输出 `unknown`，不把解析失败误报成确定 drift。
  - embedded pristine `SKILL.md` frontmatter 或 `openai.yaml` 不可解析时，`status` 的候选签名输出 `unknown`，不因无法计算 `default/manual/auto` 候选而崩溃。
  - status 命中 historical fallback、当前 catalog 已缺失该插件时，skill trigger runtime / drift 直接输出 `unknown`，不尝试从历史记录重建或比对 skill 文件。
- 新增 CLI 入口集成测试（建议 `cli-entry.test.ts`）：常规 integration 必须保持 build-free，直接 import 源码入口 `runCli()` / `buildProgram()`，注入 `cwd/env/stdout/stderr`，并继续用 `tests/helpers/embedded-root.ts` + `setEmbeddedPluginsRootOverrideForTests()` 指向 synthetic embedded root；不要在 integration 中 `execFile('node', ['packages/cli/dist/index.js', ...])`，也不要为了入口测试临时执行 `pnpm build`。
  - 非法 `--skill-trigger` 值在 Commander 入口层被拒绝，exit code 非 0，stderr 包含可读错误。
  - `install --skill-trigger manual|auto|default` 和显式 `upgrade --skill-trigger manual|auto|default` 能从 CLI 参数解析传到 command options，最终行为与 command-level 测试一致。
  - `upgrade --all --skill-trigger manual` 直接拒绝，且不是被内部 helper 静默忽略。
  - degraded ledger 下 `upgrade --all` 先在 stdout / stderr 中打印 replay-skip warning，再以非零退出拒绝继续；测试要断言 warning 顺序早于最终 error message。
  - degraded ledger 下显式 `upgrade plugin` 未传 `--skill-trigger` 时，同样先打印 preparation 产生的 replay-skip warning，再以非零退出提示用户显式传参。
  - `aw init --force`、`aw install ...`、显式 `aw upgrade ...` 触发自动重建并产生 `EnsureLocalMarketplaceResult.warnings` 时，CLI 入口只打印一次 warning，不吞掉、不重复。
- `authoring-tools.test.ts`
  - `validate_plugin.js` 校验 `skillTriggers`。
  - 作者文档示例能通过脚本校验。

### Smoke

- `pnpm test:smoke:build` 确认 build 后 `plugins-dist` 包含新字段且 bundle layout 校验通过。
- smoke 层验证真实 `dist/index.js` 可启动并使用内置 `plugins-dist`，例如 `node packages/cli/dist/index.js --help`、非法参数错误出口，以及最小 `aw init --force` / catalog 读取；这层只兜真实 build 产物，不替代上面的 build-free CLI 入口 integration。
- 如涉及依赖变更，跑 `pnpm build` 和 `pnpm test:unit`。

## 风险与后续

- 共享 marketplace 边界：当前 `~/.aw` 只有一份同名插件 bundle，不能同时服务多个 project 的不同 native skill 策略。若未来必须支持 per-project 并存，需要设计按 scope key 生成独立 marketplace 或插件别名，这会影响 Claude/Codex 原生安装模型和 ledger。
- YAML 保真：使用 `yaml` 重新序列化会改变被 patch 文件的格式。因为目标是 `~/.aw` 运行时副本，不影响源码；测试只应断言语义，不应依赖原格式。
- 多 skill 细粒度偏好：source contract 已按 skill 建模，但 CLI 首版只支持全局 `manual|auto|default` 偏好。后续可扩展重复参数或 `plugin/skill=mode` 语法。
- 上游平台字段变化：触发字段属于 Claude / Codex 原生 contract。后续如果平台改名或新增策略，需要更新 patch helper 和作者文档。
