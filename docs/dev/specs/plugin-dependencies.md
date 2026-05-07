# 插件依赖与自动安装需求 Spec

日期：2026-05-06

## 背景

AW 当前的插件模型只表达单个插件自身能力。`aw install <plugin>` 会把用户显式传入的插件解析成 target，再按平台和 scope 逐个安装；manifest、catalog、ledger、tracking、status 和作者工具都没有插件间依赖关系。

这会让“一个插件复用另一个插件能力”的场景缺少可靠边界：父插件无法声明运行前必须存在的基础插件，安装时也无法自动补齐依赖。用户需要手工知道安装顺序，容易出现父插件安装成功但运行时缺少依赖能力的问题。

还有一类跨平台组合场景无法表达：同一个父插件面向 Codex 安装时可能需要 Codex-only 依赖，面向 Claude Code 安装时可能需要 Claude-only 依赖。依赖声明如果只能表达无条件依赖，并要求所有依赖同时兼容所有候选平台，就会把本应按安装平台分流的依赖提前判定为不支持平台。

本需求为 AW 增加插件间依赖声明。插件可以在 manifest 中声明依赖其它插件；安装父插件时，AW 必须先确认依赖已经安装，缺失时自动安装依赖，并在卸载时按依赖引用关系清理不再需要的自动依赖。

## 调研核对结论

- 源码 manifest 位于 `plugins/<name>/.agents-plugin/plugin.json`，当前由 `packages/cli/src/utils/manifest.ts` 严格白名单校验；新增依赖字段必须进入 source/bundle manifest schema。
- runtime bundle 会保留 `.agents-plugin/plugin.json` 作为 AW 运行时真值；`.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json` 只承载平台原生可识别能力，不应承载 AW 自管依赖语义。
- catalog 解析通过 `resolvePluginsFromCatalog()` 读取当前 catalog 下所有插件 source manifest，因此依赖图可以只依赖当前 AW catalog，不需要扩展平台 marketplace manifest。
- `installCommand()` 当前先解析用户显式目标，再解析 platform、做 preflight、准备 local marketplace，最后进入 `installTargetsOnPlatforms()`。依赖图展开必须发生在写状态之前，且平台解析和 preflight 要覆盖展开后的完整目标集。
- `upgradeCommand()` 显式升级复用 install 流水线；`upgrade --all` 会从 ledger/status 中筛选 ready targets。新增依赖会影响显式 upgrade 和 upgrade-all 的候选展开、跳过原因和顺序。
- `uninstallCommand()` 当前只处理用户传入目标，不理解其它插件是否依赖它。自动依赖清理和被依赖保护必须依赖持久化的引用关系，不能只靠当前 catalog 反推。
- `installed.json` 现在按 plugin/platform/scope 记录安装状态、能力快照、install options、lifecycle snapshot 和 Codex shared native refs；没有显式安装与依赖安装的区分，也没有 dependent/ref-count。
- `status` 和主控制台候选来自 ledger、tracking、native/runtime evidence 和 current catalog。依赖缺失、依赖引用和可清理的自动依赖必须进入 status/console 的只读投影。
- `.agents/skills/create-agent-workflows-plugin/` 有独立作者校验脚本和 manifest 参考文档。新增 manifest 字段时必须同步更新作者工具，避免 CLI 接受而作者工具误报。

## 已确认决策

- manifest 使用顶层 `dependencies` 字段，插件依赖写在 `dependencies.plugins`。
- 第一版不支持版本约束；依赖只引用当前 AW catalog 中的插件名。
- 第一版只允许依赖当前 AW catalog / marketplace 内的插件，不支持外部 marketplace、URL、npm 包、git source 或跨 marketplace dependency。
- `aw install <plugin>` 默认自动安装所有缺失依赖，不新增确认步骤或必选 flag。
- 依赖允许跨 scope；依赖条目只能覆盖 `target.scope`，不能指定另一个安装目标 platform。
- 依赖条目可用 `when.platforms` 声明平台条件。平台条件只决定该 dependency entry 是否在当前安装平台生效；依赖真正安装的平台仍是父插件本次已经选定的平台。
- `--platform auto` 必须先按现有平台推断规则确定父插件目标平台，再展开该平台生效的依赖；依赖条件不参与平台选择。
- 判断依赖是否满足时，第一版采用 location-aware 规则：user scope 的父插件只能由 user scope 依赖满足；project scope 的父插件在依赖省略 `target.scope` 时，可以由当前 project scope 或 user scope 依赖满足；其它历史 project scope 不算当前命令可用依赖。
- dependency entry 的 `target.scope` 是硬约束，也是缺失时的安装位置。显式 `target.scope: "user"` 只能由 user scope 满足；显式 `target.scope: "project"` 只能由当前 project scope 满足。
- 当多个位置都能满足同一依赖时，ledger edge 选址必须稳定：已有 healthy edge 优先保留；新 edge 若声明 `target.scope`，只检查该 scope；省略 `target.scope` 时先选默认父 scope 对应位置，再按 location-aware 可见性 fallback。
- 依赖条目使用对象形式。每个条目必须写 `name`，可选 `target.scope`、`inheritInstallOptions` 和 `when.platforms`。
- 依赖安装选项默认不继承父插件。只有依赖条目显式写 `inheritInstallOptions: true` 时，依赖才继承父插件的插件级安装选项。
- `aw upgrade <plugin>` 必须补齐新增依赖，顺序为依赖先安装或升级，父插件后升级。
- `aw uninstall <plugin>` 会自动卸载不再被任何插件需要、且最初由依赖自动安装的依赖插件；显式安装过的依赖不被自动卸载。
- ledger 必须记录安装来源和 canonical outgoing dependency edges。`dependents`、`ref-count` 和 `autoRemovable` 不能作为独立真值持久化，只能在读路径从 edge 图推导，供卸载保护、自动清理、status 和控制台使用。

## 目标

1. 插件作者可以在 `.agents-plugin/plugin.json` 中声明插件依赖。
2. `aw install <plugin>` 在写父插件前自动解析当前目标平台生效的完整依赖图，先安装缺失依赖。
3. 安装顺序稳定满足依赖拓扑：依赖先于依赖它的插件写入。
4. 循环依赖、自依赖、缺失依赖、当前平台生效但不支持目标 platform/scope 的依赖在任何写状态之前失败。
5. 依赖安装可跨 scope，例如 Codex project 插件可以依赖同平台 user scope 插件。
6. 依赖声明可按安装平台生效，例如 Codex 安装依赖 Codex-only 插件，Claude Code 安装依赖 Claude-only 插件。
7. 同一 platform 下按 location-aware 规则检查依赖是否满足，不重复安装；显式 `target.scope: "user"` 必须由 user 位置满足，显式 `target.scope: "project"` 必须由当前 project 位置满足；只有省略 `target.scope` 的 project 父插件可在当前 project 位置缺失时复用健康的 user 位置。
8. 自动依赖写入 ledger 安装来源；父插件成功后写入 outgoing dependency edges，卸载父插件时自动清理不再需要且未被显式安装保留的依赖。
9. `aw upgrade <plugin>` 和 `aw upgrade --all` 维护依赖顺序，先处理依赖，再处理父插件。
10. `aw status` 能报告依赖是否满足、哪些依赖由当前插件引用、哪些自动依赖可随父插件清理。
11. JSON receipt 和默认输出能区分用户显式请求插件与自动依赖插件。

## 非目标

- 不支持依赖版本范围、多个版本并存或 semver resolution。
- 不支持外部 marketplace、远程 source、npm package、git URL 或本地路径作为依赖来源。
- 不把依赖字段写入 Claude/Codex 平台原生 manifest。
- 不保证 AW 之外的原生平台安装路径会自动安装 AW 依赖；依赖语义只由 AW CLI 执行。
- 不改变 AW config 的合并规则，也不让父插件配置自动成为依赖插件配置。
- 不支持按 OS、CPU、宿主版本、配置值或 feature flag 选择依赖；第一版只支持按 AW 安装平台选择依赖。
- 不新增 `--no-dependencies` 或脚本化确认流程；依赖自动安装是默认行为。

## Manifest 合同

插件依赖声明写在 source manifest 顶层：

```json
{
  "name": "workflow-pack",
  "version": "0.1.0",
  "description": "组合多个 AW 插件能力的工作流。",
  "dependencies": {
    "plugins": [
      {
        "name": "git-commit",
        "inheritInstallOptions": true
      },
      {
        "name": "codex-explore",
        "when": {
          "platforms": ["codex"]
        },
        "target": {
          "scope": "user"
        }
      },
      {
        "name": "claude-review",
        "when": {
          "platforms": ["claude"]
        }
      }
    ]
  },
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "NONE"
    }
  }
}
```

字段规则：

- `dependencies` 可省略。存在时只允许 `plugins` 字段。
- `dependencies.plugins` 必须是数组。空数组等价于无依赖，但构建和作者工具应提示删除空 block。
- 每个 dependency entry 必须是对象，只允许 `name`、`target`、`inheritInstallOptions`、`when`。
- `name` 必须是当前 AW catalog 中的插件名，使用与 manifest `name` 相同的安全命名规则。
- `name` 不能等于当前插件自身。
- `target` 可省略。存在时只允许 `scope` 字段。
- `target.scope` 只能是 `user` 或 `project`。声明后是满足位置和缺失安装位置的硬约束；省略时，依赖缺失时安装到父插件当前命令的 scope。
- `when` 可省略。存在时只允许且必须包含 `platforms` 字段。
- `when.platforms` 必须是非空数组，元素只能是 `codex` 或 `claude`，同一数组中不能重复。
- 省略 `when` 时，依赖对所有安装平台生效。
- `inheritInstallOptions` 是 boolean，省略时等价于 `false`。
- 不允许 `version`、`range`、`platform`、`marketplace`、`source`、`optional`、`dev`、`peer` 等字段。特别是 dependency entry 不能写 `target.platform`，`when.platforms` 不是安装目标覆盖。
- 同一插件 manifest 内同名直接依赖可以在平台条件互斥时重复声明。若两个同名 entry 的生效平台有交集，则视为 manifest 错误，即使命名的 `target.scope` 或 `inheritInstallOptions` 不同也必须失败。

`dependencies` 保留在 runtime bundle 的 `.agents-plugin/plugin.json` 中，供 AW 命令读取。构建生成的 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 和根级 platform marketplace manifest 不写入该字段。

source manifest 和 build 后 staging manifest 都必须执行同一套 `dependencies` contract 校验。`scripts.node.build` 可以改写 staging manifest，因此只校验源码 manifest 不够；build 后重新读取的 staging manifest 才是 marketplace entry、bundle source manifest、platform manifest base 和运行时文件收集的真值。若 staging manifest 生成非法依赖声明，`pnpm build` / bundle 生成必须失败。

## 依赖目标语义

依赖平台分为“生效条件”和“安装目标”两层：

- 生效条件来自 dependency entry 的 `when.platforms`。省略时表示该 entry 对所有安装平台生效。
- 安装目标 platform 始终是父插件本次已经选定的平台。依赖条目不能指定另一个 platform，也不会触发跨平台安装。
- 父插件安装到 `codex` 时，只展开未声明 `when.platforms` 或包含 `codex` 的 dependency entry，依赖也按 `codex` 解析和安装。
- 父插件安装到 `claude` 时，只展开未声明 `when.platforms` 或包含 `claude` 的 dependency entry，依赖也按 `claude` 解析和安装。
- `--platform both` 会分别在 Codex 和 Claude Code 平台上解析依赖图；每个平台只校验和安装该平台生效的依赖。
- 当前平台不生效的 dependency entry 不参与 platform products 校验、scope installability 校验、循环依赖图校验、满足检查、自动安装计划或 ledger ref 写入。

每个 dependency entry 的结构校验不受当前安装平台影响。即使某个 entry 当前不生效，也必须满足字段白名单、`name` 可解析、不能自依赖，以及同名依赖条件不能重叠等 manifest-level 规则。

`--platform auto` 的平台推断必须先于依赖图展开：

- CLI 先按用户显式目标插件自身的 platform 可用性、现有 ledger/status 和当前命令上下文确定目标 platform。
- 平台推断成功后，只展开该 platform 生效的依赖。
- 如果按现有规则无法唯一确定目标 platform，命令仍应失败并要求用户显式传 `--platform`；不能因为某个平台的依赖集更容易满足就自动选择它。
- 如果平台推断选出多个 platform，按每个 platform 独立展开和校验生效依赖。

依赖 scope 的含义由 dependent location 的可见性和 dependency entry 的 `target.scope` 共同决定：

- 满足检查只在同一 platform 内进行。
- user scope 的父插件只允许 user scope 中健康的 AW-managed 依赖满足；当前 project scope 安装不能满足 user 父插件。
- user scope 的父插件若遇到当前 platform 生效、且 `target.scope: "project"` 的依赖条目，命令必须在写状态前失败；第一版不允许 user location 依赖 project location。
- project scope 的父插件若省略 `target.scope`，可由当前 project scope 或 user scope 中健康的 AW-managed 依赖满足；其它 project scope 的安装不可见，不能满足当前命令依赖。
- `target.scope: "user"` 是硬约束。无论父插件安装到哪个 scope，该依赖都只允许 user scope 满足，缺失时也安装到 user scope。
- `target.scope: "project"` 是硬约束。该依赖只允许当前 project scope 满足，缺失时也安装到当前 project scope；健康的 user scope 安装不能作为 fallback。
- 省略 `target.scope` 且父插件安装到 project scope 时，project 位置是满足位置首选和缺失安装位置。若当前 project 位置缺失，健康的 user scope 安装可以作为 fallback 满足该依赖。
- 省略 `target.scope` 且父插件安装到 user scope 时，user 位置是唯一满足候选和缺失安装位置。
- 若依赖未被满足，CLI 使用 dependency entry 的 `target.scope` 作为安装位置；未声明时使用父插件当前命令 scope。
- 当前命令不在项目内、无法解析 project key，且依赖缺失时目标 scope 为 `project`，命令必须在写状态前失败。

满足位置必须按确定性规则选择：

- 若 dependent location 已有 outgoing edge 指向某个仍健康、当前可见、且仍符合 manifest target 约束的位置，继续保留该 edge，不因为另一个位置后来也安装成功而迁移。
- 若没有可保留的 edge，CLI 先尝试 `target.scope` 指定的位置；省略 `target.scope` 时先尝试父插件当前命令 scope 对应的位置。
- 对 project 父插件，若 dependency entry 省略 `target.scope`，且首选 project 位置不存在或不健康，则可 fallback 到 user scope 的健康安装。显式 `target.scope: "project"` 不允许 fallback。
- 同一条 edge 只能在已有位置不健康、不可见，或 manifest target 约束改变时按上述规则重算；`status` 只读，不迁移 edge。

Codex project scope 仍保持原有隔离规则。若依赖缺失且目标为 `codex/project`，该依赖必须满足 Codex project installability：不能是纯 native-only 插件，不能声明 `apps`，并且要有 repo-managed surface。若依赖缺失且目标为 `codex/user`，走 Codex native plugin install 路径。

## 统一 Location Planner

依赖实现必须把 location 选址、依赖图展开和 ledger edge 投影收口到同一层 planner 中，不能在 `install`、`upgrade`、`uninstall` 和 `status` 四条命令里各自实现一套 fallback 判断。

planner 的输入至少包括：

- current catalog 中的 source manifest 和本次命令选定的显式目标 location。
- 当前 ledger 中的 canonical outgoing dependency edges、安装来源和 scope record。
- 当前 platform/scope/projectKey 的健康状态投影、scope installability、required config 和 install options。

planner 必须统一产出：

- install / 显式 upgrade 的 location-level 写入顺序、已满足依赖位置和待提交 outgoing edges。
- `upgrade --all` 的显式保留根集合、current catalog 目标依赖前置图、skipped 传播关系和自动清理候选。
- uninstall 的被依赖保护、允许同命令一起卸载的 dependent 集合和自动清理计划。
- status 的 installed health、catalog drift、dependents、autoInstalled 和 autoRemovable 只读投影。

同一套 planner 必须拥有 location-aware scope 规则，尤其是显式 `target.scope` 的硬约束：`target.scope: "project"` 不能在 install、upgrade、uninstall 或 status 任一读写路径里被 user scope fallback 满足。`status` 只能使用 planner 做只读投影，不能迁移 edge、安装依赖或触发自动清理。

## 安装行为

`aw install <plugin...>` 的目标解析顺序如下：

1. 从 current catalog 读取用户显式请求插件和所有 catalog 插件 source manifest。
2. 解析用户显式目标的目标 platform。`--platform auto` 先按现有平台推断规则选择 platform，不把尚未展开的依赖作为选择依据。
3. 按每个已选 platform 递归展开该 platform 生效的 `dependencies.plugins`，形成平台内完整依赖图。
4. 校验依赖图：插件存在、自依赖、重复依赖、循环依赖、当前平台生效依赖的平台产品限制、scope installability。
5. 按每个 platform 计算生效依赖是否已经满足；未满足的依赖加入自动安装计划。
6. 对所有将要写入的目标做图级 preflight：Codex project safety、required config、tracking identity、external ownership、install options、role namespace 等都必须在第一笔写状态前完成。
7. 按拓扑顺序执行安装：依赖先写，父插件后写。
8. 每个成功安装的自动依赖都标记安装来源；父插件成功后一次性写入自己的 outgoing dependency refs。

安装顺序必须稳定：

- 用户显式请求插件保留命令行顺序。
- 同一插件在当前 platform 生效的依赖保留 manifest 中的数组顺序；不生效的 entry 被过滤后不占排序位置。
- 多个路径指向同一依赖时，只安装一次；引用关系通过所有 dependent 的 outgoing edge 表达。
- 若两个子图彼此独立，保持首次出现在展开图中的顺序。

如果依赖已经满足，CLI 不重复安装该依赖，但仍按满足位置选址规则记录父插件对已满足位置的 dependency ref。依赖满足的健康条件是目标位置存在完整 AW-managed 安装证据；external-only、breadcrumb-only、enabled-only、cache-only、tracking 损坏或 status 需要 repair 的状态不算满足。

自动依赖安装使用依赖插件自己的 manifest、config、lifecycle、artifact renderer 和平台能力。父插件不能替依赖提供 config 值；依赖缺少 required config 时，整个 install 在写状态前失败，并提示配置依赖插件。

### 图级事务与失败收口

install / upgrade 不能把依赖安装简单叠加到现有“逐 platform、逐 target 直接提交”的执行模型上。写状态前必须先规划 location-level 图，节点身份为 `(plugin, platform, scope, projectKey)`，并在同一张图内区分用户显式目标、已满足依赖和本命令新建的自动依赖。

事务合同如下：

- 图级 preflight 必须覆盖所有将要写入的 location node，并在第一笔 native/artifact/tracking/ledger 写入前完成。
- dependency edge 只在 dependent location 成功安装或升级后提交。父插件失败前，不能提前把该父插件的 outgoing edge 写入 ledger。
- 同一命令中新装的 auto dependency 如果还没有被任何已成功提交的 dependent edge 引用，后续父插件失败时应优先回滚卸载。
- 同一命令中新装的 auto dependency 如果已经被其它成功 dependent 引用，后续另一个父插件失败时不能回滚该依赖，只丢弃失败父插件的 planned edge。
- 已满足的既有依赖不因后续父插件失败被卸载，也不写入失败父插件的 edge。
- 若 native/artifact/tracking 已经写出且无法完整回滚，ledger 必须 fail closed：不能留下失败父插件的成功 edge；新建自动依赖若无法回滚，应保持可识别的 degraded 或 cleanup-blocked 状态，阻止后续自动清理依据不完整 ref 继续动作，并提示用户 repair install、status 诊断或显式 cleanup。
- 回滚和 degraded 标记也以 location node 为单位，避免一个 platform/scope 的失败污染其它已成功提交的位置。

## 安装选项继承

`inheritInstallOptions` 只影响插件级安装选项，不影响命令级执行环境。

命令级选项始终覆盖整次命令：

- `cwd`
- `platform`
- `scope` 的父插件默认目标
- `scriptTimeoutMs`
- `json` / `verbose` / `debug`
- 注入的 runtime context、env 和 adapter

插件级安装选项包括当前已有的 `requestedSkillTrigger`，以及未来同类“写入某个插件运行时偏好”的选项。

规则如下：

- `inheritInstallOptions: false` 或省略时，依赖按 fresh install / ledger 继承规则解析自己的 install options。
- `inheritInstallOptions: true` 时，依赖继承父插件本次命令里的插件级安装选项。
- 继承只沿当前 dependency edge 生效。若依赖 A 继承父插件选项，A 自己声明依赖 B 时，B 是否继承取决于 A -> B 的 dependency entry。
- 若多个父插件在同一命令中引用同一个缺失依赖，并给出冲突的继承后安装选项，命令必须在写状态前失败，提示用户拆分命令或显式安装该依赖。
- 若依赖已经满足，不因为 `inheritInstallOptions` 重新物化 skill trigger 或其它运行时偏好。

## 升级行为

显式升级 `aw upgrade <plugin...>` 必须先解析目标 platform，再使用 current catalog 展开该 platform 生效的依赖图，并按依赖拓扑顺序处理：

1. 缺失依赖先安装。
2. 已安装依赖先升级。
3. 父插件最后升级。

依赖升级仍遵守当前 upgrade 安全规则：

- catalog 缺失的依赖不能升级，命令失败。
- capabilityChanged、tracking 损坏、required config 缺失、external ownership、Codex project safety 等按现有 upgrade 规则处理。
- Codex user breadcrumb-only 状态不能进入 upgrade；若依赖处于 breadcrumb-only，显式 upgrade 必须失败并提示先 repair install 或 uninstall cleanup。

`aw upgrade --all` 的候选集不能简单使用“当前 scope/platform 下所有 managed 插件”。根集合和依赖前置图必须分开计算：

- 显式保留安装的 location 是 upgrade-all 根。
- auto-installed location 不是 upgrade-all 根；它只有从某个显式保留根按 current catalog 中当前 platform 生效的依赖声明递归可达时，才作为该根的被依赖节点参与升级图。
- 旧 ledger edge 仍引用、但已经不在 current catalog 目标依赖图中的 auto-installed location，不能仅凭旧 incoming edge 进入升级前置图；这些旧 edge 只用于在父插件升级成功前保护既有安装状态。
- 没有 incoming edge、未被显式保留、且不在 current catalog 目标依赖图中的 auto-installed location 不是 upgrade-all 根；它应进入自动清理候选，而不是先参与 ready/skipped 判定。

upgrade-all 先从显式保留根展开 current catalog 中当前 platform 生效的依赖图，只处理这张目标图内的依赖前置。若某个 ready 父插件在目标图内依赖的插件需要安装或升级，依赖先处理。目标图内的某个依赖 skipped 时，依赖它的父插件也必须 skipped，原因指向依赖未满足或依赖升级失败，不能继续升级父插件。旧 edge 指向、但目标图已不再需要的自动依赖，不能反过来阻塞父插件升级；父插件升级成功并刷新 refs 后，它们再进入自动清理候选。

升级成功后，ledger 中当前 platform 的 dependency refs 必须和 current catalog 中该 platform 生效的依赖声明一致，并使用与 install 相同的满足位置选址规则：

- 新增依赖写入新 ref。
- 删除的依赖 ref、或因 `when.platforms` 改动后在当前 platform 不再生效的依赖 ref，被移除。
- 不再被任何插件需要、且未被显式安装保留的自动依赖进入自动清理流程。自动清理前必须重新从 canonical outgoing edges 推导 incoming edge；不能依赖持久化的 ref-count。

## 卸载行为

`aw uninstall <plugin...>` 分两类目标：

- 用户显式卸载目标。
- 因依赖引用归零而自动清理的依赖目标。

卸载父插件时，CLI 必须先读取 ledger dependency refs，计算移除这些父插件后哪些依赖不再被任何插件需要。只有同时满足下面条件的依赖才会被自动卸载：

- 该依赖 location 来自 canonical incoming edge，且位于当前命令可操作的同一 platform user scope 或当前 project scope；其它 project scope 不能被当前 cwd 的自动清理跨项目删除。
- 该依赖最初由依赖自动安装，或当前 ledger 标记它仍可自动清理。
- 没有其它 installed dependent 引用它。
- 用户没有显式安装保留该依赖。
- 当前状态不是 external-only 或 identity 不完整的高风险状态。

自动清理顺序必须是父插件先卸载，再按反向拓扑卸载不再需要的依赖。这样父插件的 lifecycle 和 artifact 清理仍能看到卸载前的依赖状态；依赖只在父插件已清理后移除。

如果用户显式卸载一个仍被其它插件依赖的插件：

- 若该插件是自动依赖且仍有 dependents，CLI 不直接卸载它；必须失败并列出依赖它的插件位置。
- 若用户在同一条命令里同时卸载所有 dependents，则允许继续，并按反向拓扑清理。
- 若该插件被显式安装保留，但仍有 dependents，直接卸载同样必须失败，避免留下破损父插件。

Codex user breadcrumb-only cleanup 仍遵循既有 native recovery 语义。breadcrumb 不能被当作完整依赖安装，也不能提供 dependent ref；如果某个父插件依赖的目标只有 breadcrumb-only evidence，父插件 status 必须显示依赖未满足。

## Ledger 合同

ledger 必须能按 platform + scope + projectKey 精确表达依赖来源和 canonical outgoing dependency edges。每个 installed scope record 至少需要持久化以下真值：

- 当前安装是否由用户显式请求保留。
- 当前安装是否由依赖自动创建，且在引用归零时是否允许自动清理。
- 当前安装的 outgoing dependency edges 指向哪些其它插件位置。
- 每条 edge 的声明来源：dependent location、dependency satisfied location、manifest entry、`inheritInstallOptions`、生效的 `when.platforms` 条件，以及缺失时会使用的 `target.scope`。

`dependents`、`ref-count`、`autoRemovable` 和“哪些其它插件位置依赖当前安装”都必须从 canonical outgoing edges 现算，不能作为独立字段持久化为真值。status、uninstall 保护和自动清理 planning 读取 ledger 时，应先构建 location graph，再由 edge 反向索引得到 incoming dependents。

scope record 的 edge 端点必须以位置身份为单位，而不是只按插件名：

```json
{
  "plugin": "codex-explore",
  "platform": "codex",
  "scope": "user",
  "projectKey": null
}
```

project scope 的 `projectKey` 必须使用现有 Codex / Claude project key 解析结果；user scope 的 `projectKey` 为 `null` 或省略。

引用写入规则：

- 用户显式安装插件时，该 scope record 标记为 explicit。
- 依赖自动安装插件时，该 scope record 标记为 auto-installed。
- 自动安装的插件后来被用户显式 `aw install <dependency>` 时，explicit 标记必须置为 true；之后父插件卸载不能自动删除它。
- 同一 dependent 重复 install 或 upgrade 不增加重复 ref；ref 以 dependent location + dependency location 唯一。
- uninstall 父插件时必须先移除 outgoing refs，再判断依赖是否引用归零。
- ledger degraded 时，不能隐式执行高风险自动清理；缺少可信 ref 时必须 fail closed，并提示用户修复 ledger/status 后重试。

### 首版 ledger 兼容边界

本需求仍处开发阶段，尚未发布到需要兼容历史 `installed.json` 的用户版本。首版实现不定义 legacy ledger 迁移、backfill 或历史 ref 推断合同。

- 新的 ledger schema 可以直接把安装来源、auto-installed 状态和 outgoing dependency edges 作为必需语义加入。
- 缺少依赖 metadata 的开发期 ledger 不能被实现者自行猜测为某种依赖图；涉及依赖保护、upgrade-all 根集合或自动清理时必须 fail closed。
- 首版不需要把旧 record 默认当作 explicit，也不需要从 current catalog 回填 dependency edges。开发环境若存在旧 ledger，应通过重新安装、清理或重建测试 fixture 生成新结构。

## Status 与控制台行为

`aw status` 必须展示依赖健康，但不能为了诊断安装或修复依赖。

依赖状态必须区分“当前安装健康”和“current catalog drift”两层真值：

- 当前安装健康优先依据 installed snapshot manifest 中记录的 `dependencies` 和 ledger canonical outgoing edges 判定。只有 installed snapshot 缺失或损坏时，才按既有 `healthSource` 规则降级到 current catalog、historical 或 none，并在 verbose/json 诊断中标出来源。
- current catalog 中的依赖新增、删除、平台条件变化或 target scope 变化，应作为独立 drift / upgrade 诊断展示，不直接改写当前安装健康结论。
- 如果旧安装的 installed snapshot 仍自洽，只是 current catalog 新增了依赖，`status` 不能把该旧安装直接标成依赖缺失；下一步应提示 upgrade 或 repair install，让写命令按 current catalog 刷新 refs。
- 如果 current catalog 已删除某条依赖，但旧 installed snapshot 和 ledger edge 仍记录它，`status` 仍按当前安装健康层检查这条旧依赖是否自洽；它只有在父插件成功 upgrade 并移除 outgoing ref 后，才进入自动清理候选。

每个 plugin status 至少要能表达：

- `dependencies.declared`：current catalog 中声明的直接依赖，包含 `when.platforms` 条件。
- `dependencies.resolved`：当前安装健康层中按该 location 的 platform/scope 解析后的生效依赖目标；优先来自 installed snapshot manifest，fallback 时必须带来源诊断。
- `dependencies.satisfied`：当前安装健康层中已满足依赖及其按 ledger edge / 选址规则确定的满足位置。
- `dependencies.missing`：当前安装健康层中缺失、损坏或不可用的依赖；current catalog drift 不能直接塞进该字段。
- `dependencies.dependents`：当前插件被哪些已安装插件引用；该字段由 ledger outgoing edges 反向推导。
- `dependencies.autoInstalled`：当前 scope record 是否由依赖自动创建。
- `dependencies.autoRemovable`：若卸载 dependents，当前插件是否可自动清理；该字段由安装来源、incoming edge 和 degraded 状态推导。
- `dependencies.catalogDrift`：current catalog 的依赖声明与 installed snapshot / ledger refs 的差异，例如新增依赖、删除依赖、平台条件变化或 target scope 变化；该字段用于解释 upgrade / repair install 建议，不作为当前安装缺依赖的真值。

友好状态投影规则：

- 父插件自身健康但当前安装健康层的依赖缺失时，不显示为完全 ready，应进入 needsAttention。
- 当前 platform 不生效的 dependency entry 只出现在 declared 诊断中，不应让父插件进入 needsAttention。
- current catalog drift 可以展示 upgrade / repair install 建议，但不能仅因新 catalog 新增依赖就把 installed snapshot 自洽的旧安装判为 needsAttention。
- 缺失依赖的下一步是 `aw install <parent> ...`，因为 install 会自动补齐依赖并刷新 refs。
- 自动依赖没有 dependents 且未 explicit 保留时，可显示为可清理；控制台清理动作必须带 destructive 确认。
- status 只读，不执行 dependency graph install、lifecycle、renderer、marketplace refresh 或 native RPC。

## 输出与 Receipt

写命令的默认输出应说明自动依赖行为，但避免展示内部 ledger 细节。

`--json` receipt 必须区分显式目标和自动依赖目标：

- `plugins` 包含本次命令所有受影响插件，含用户显式请求插件和自动依赖插件。
- `targets[]` 中每个 target 必须带 `requested: boolean`。
- 自动依赖 target 必须带 `dependencyOf`，列出触发它的父插件位置。
- `actions[]` 必须能区分 `installDependency`、`upgradeDependency`、`uninstallAutoDependency` 和用户显式动作。
- `warnings[]` 中依赖相关 warning 必须包含插件名、platform、scope 和可复制命令。

默认人类输出示例：

```text
已安装 workflow-pack，并自动安装依赖 git-commit。
```

依赖缺少 required config 的失败输出应指向依赖插件：

```text
依赖插件 codex-explore 缺少必填配置 explorerModel。请先运行 aw config set codex-explore explorerModel <value>。
```

## 错误处理

### 缺失依赖

如果 dependency `name` 不在 current catalog 中，install / upgrade 必须在写状态前失败：

```text
插件 workflow-pack 依赖 catalog 中不存在的插件 missing-plugin。
```

### 循环依赖

循环依赖必须在写状态前失败，并输出完整链路：

```text
检测到插件循环依赖：a -> b -> c -> a。
```

### 不支持平台

若当前 platform 生效的依赖与该依赖插件的 `marketplace.policy.products` 不兼容，命令失败：

```text
插件 workflow-pack 在 Claude Code 上依赖 codex-explore，但 codex-explore 只支持 CODEX。
```

如果 `codex-explore` 的 dependency entry 声明了 `when.platforms: ["codex"]`，则它在 Claude Code 安装中不生效，不应触发上述错误。

### 条件字段错误

`when.platforms` 包含未知平台、空数组、重复值，或同名依赖的生效平台有交集时，install / upgrade 必须在写状态前失败：

```text
插件 workflow-pack 对依赖 git-commit 声明了重叠的平台条件 codex。
```

### 不支持 scope

若依赖缺失且目标 scope 无法安装，命令失败：

```text
插件 workflow-pack 依赖 codex-explore，但 codex-explore 不能安装到 codex/project scope。
```

若 user scope 父插件声明当前 platform 生效的 project scope 依赖，命令失败：

```text
插件 workflow-pack 安装到 user scope 时不能依赖 project scope 插件 repo-helper；请将依赖改为 user scope，或把 workflow-pack 安装到 project scope。
```

### 安装选项冲突

同一命令内多个父插件对同一缺失依赖产生不同继承安装选项时，命令失败：

```text
依赖插件 git-commit 收到冲突的安装选项；请先显式安装 git-commit，或拆分本次 install 命令。
```

### 自动清理不可信

ledger degraded、tracking identity 损坏或 dependency refs 不完整时，不执行自动依赖清理：

```text
installed.json 当前不可完全信任，无法安全自动卸载依赖 git-commit；请先运行 aw status --verbose 检查后重试。
```

## 作者工具与文档合同

新增 `dependencies` 后，作者工具必须与 CLI manifest contract 保持一致：

- `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md` 记录字段、示例和限制。
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js` 校验字段白名单、entry 形状、自依赖、当前 workspace catalog 中可解析依赖、`when.platforms` 取值，以及同名依赖平台条件是否重叠。
- CLI source manifest 校验、bundle staging manifest 校验和作者工具校验必须共享同一语义；尤其是 `scripts.node.build` 改写 staging manifest 后，仍要重新校验最终 `.agents-plugin/plugin.json` 中的 `dependencies`。
- 作者工具不能接受 CLI 会拒绝的字段，例如 `version`、`target.platform`、`platform`、`optional`。
- 若依赖目标为 `project` 且插件可能面向 Codex，应沿用现有 Codex project scope 限制提示。
- `docs/plugin-authoring.md` 和 `docs/plugin-installation.md` 需要说明依赖自动安装、跨 scope 目标、平台条件、升级和卸载自动清理行为。

## 示例

### 同 scope 依赖

```json
{
  "dependencies": {
    "plugins": [
      {
        "name": "git-commit"
      }
    ]
  }
}
```

用户运行：

```bash
aw install workflow-pack -p claude -s user
```

若 `git-commit` 未在 Claude user scope 健康安装，CLI 会先安装 `git-commit -p claude -s user`，再安装 `workflow-pack -p claude -s user`。

若同一个依赖未声明 `target.scope`，且父插件安装到 project scope，CLI 优先使用当前 project scope 的健康安装；当前 project scope 缺失但 user scope 健康时，edge 指向 user scope，不重复安装 project 依赖。

### Codex project 插件依赖 user scope 插件

```json
{
  "dependencies": {
    "plugins": [
      {
        "name": "codex-explore",
        "target": {
          "scope": "user"
        }
      }
    ]
  }
}
```

用户运行：

```bash
aw install repo-workflow -p codex -s project
```

若 `codex-explore` 未在 Codex user scope 健康安装，CLI 会先走 Codex user native install 安装 `codex-explore`，再写当前仓库的 `repo-workflow` project artifacts。即使当前 project scope 已安装同名插件，也不能满足这个显式 `target.scope: "user"` 依赖。

### Codex project 插件依赖 project scope 插件

```json
{
  "dependencies": {
    "plugins": [
      {
        "name": "repo-helper",
        "target": {
          "scope": "project"
        }
      }
    ]
  }
}
```

用户运行：

```bash
aw install repo-workflow -p codex -s project
```

若 `repo-helper` 未在当前项目的 Codex project scope 健康安装，CLI 会先把 `repo-helper` 安装到当前项目，再安装 `repo-workflow`。即使同一用户已经在 Codex user scope 安装了 `repo-helper`，也不能满足这个显式 `target.scope: "project"` 依赖。

### 按平台选择依赖

```json
{
  "dependencies": {
    "plugins": [
      {
        "name": "codex-explore",
        "when": {
          "platforms": ["codex"]
        }
      },
      {
        "name": "claude-review",
        "when": {
          "platforms": ["claude"]
        }
      }
    ]
  }
}
```

用户运行：

```bash
aw install workflow-pack -p codex -s user
```

CLI 只展开并安装 `codex-explore`。即使 `claude-review` 是 Claude-only 插件，也不会因为它不支持 Codex 而失败。

用户运行：

```bash
aw install workflow-pack -p claude -s user
```

CLI 只展开并安装 `claude-review`。`--platform both` 时，Codex 和 Claude Code 会分别解析各自生效的依赖图。

### 显式继承 skill trigger 安装选项

```json
{
  "dependencies": {
    "plugins": [
      {
        "name": "git-commit",
        "inheritInstallOptions": true
      }
    ]
  }
}
```

用户运行：

```bash
aw install workflow-pack -p claude -s user --skill-trigger manual
```

如果 `git-commit` 缺失，依赖安装会继承本次 `--skill-trigger manual`。若 `git-commit` 已经满足，CLI 不会因为继承声明重写已有安装偏好。
