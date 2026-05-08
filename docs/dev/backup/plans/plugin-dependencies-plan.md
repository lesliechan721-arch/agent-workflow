# 插件依赖与自动安装执行计划

日期：2026-05-06  
来源：[`../specs/plugin-dependencies.md`](../specs/plugin-dependencies.md)  
状态：待执行

## 需求来源

本计划落实 `docs/dev/specs/plugin-dependencies.md`。如果实现过程中发现本计划和 spec 不一致，先回到 spec 校准需求，再更新计划；不要让实现按过期计划继续推进。

本轮改造的主线是：

- 插件可以在 source manifest 顶层通过 `dependencies.plugins` 声明对其它 AW 插件的依赖。
- `aw install <plugin>`、显式 `aw upgrade <plugin>` 和 `aw upgrade --all` 都必须先解析依赖图，再按依赖拓扑顺序写入。
- 依赖按父插件本次已选 platform 生效，dependency entry 只能用 `when.platforms` 表达平台条件，不能覆盖安装 platform。
- 依赖按 location-aware 规则判断是否满足，尤其要严格区分 `user`、当前 `project` 和其它历史 project。
- ledger 只持久化安装来源和 canonical outgoing dependency edges；`dependents`、`ref-count`、`autoRemovable` 只能从 edge 图现算。
- `uninstall` 要保护仍被依赖的插件，并自动清理不再需要、且没有被显式保留的自动依赖。
- `status`、主控制台、默认输出和 JSON receipt 要能表达依赖健康、依赖引用、自动依赖和可清理状态。
- CLI manifest 合同、bundle staging 校验、作者工具、公开文档和测试夹具必须同步。

## 首版交付目标

首版要交付六层能力。

第一层是 manifest 合同：

- `PluginManifestSource` 支持顶层 `dependencies`。
- `dependencies` 只允许 `plugins` 字段。
- `dependencies.plugins[]` 只允许 `name`、`target`、`inheritInstallOptions`、`when`。
- `target.scope` 只允许 `user` 或 `project`，不能写 `target.platform`。
- `when.platforms` 只允许 `codex` 和 `claude`，必须非空且不能重复。
- 同一 manifest 内同名直接依赖的平台条件不能重叠。
- source manifest 和 build 后 staging `.agents-plugin/plugin.json` 使用同一套依赖校验语义。
- `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 和平台 marketplace manifest 不写入 AW 自管依赖字段。

第二层是统一 location planner：

- 新增统一 planner，集中处理依赖展开、location 选址、已有 edge 保留、拓扑排序、跳过传播和只读投影。
- `install`、`upgrade`、`upgrade --all`、`uninstall`、`status` 和主控制台不能各自实现一套 scope fallback。
- planner 的节点身份使用 `(plugin, platform, scope, projectKey)`，同一 plugin 在不同 location 下是不同节点。
- planner 必须区分用户显式目标、已满足依赖、待安装自动依赖、待升级依赖、待卸载自动依赖。

第三层是 ledger 图：

- 每个 installed scope record 记录当前安装是否被用户显式保留，以及当前安装是否由依赖自动创建。
- 自动依赖安装只能持久化“引用归零时允许自动清理”这类策略位；`autoRemovable` 这个名字只用于 status / 控制台从 edge 图、安装来源和 degraded 状态推导出的只读投影。
- 每个 scope record 持久化 outgoing dependency edges，edge 端点包含 plugin、platform、scope、projectKey。
- edge 记录声明来源，包括 dependency entry、`inheritInstallOptions`、生效平台条件、目标 scope 约束和最终满足位置。
- 读路径从 outgoing edges 构建 incoming index，供卸载保护、自动清理、status 和控制台使用。
- 首版不做 legacy ledger 迁移或 backfill；缺少依赖 metadata 的开发期 ledger 在依赖相关动作中 fail closed。

第四层是写命令行为：

- `install` 在第一笔写状态前完成完整图级 preflight。
- 缺失依赖自动安装；已满足依赖不重复安装，但要写入父插件 edge。
- `upgrade <plugin>` 先安装缺失依赖、再升级已安装依赖、最后升级父插件。
- `upgrade --all` 只把显式保留安装作为根，从 current catalog 展开目标依赖图；旧 edge 中已不再需要的自动依赖不阻塞父插件升级。
- `uninstall` 保护仍被其它插件依赖的目标，允许同命令卸载完整 dependent 集合，并在父插件卸载后反向拓扑清理自动依赖。

第五层是只读状态和输出：

- `status` 展示 `dependencies.declared`、`resolved`、`satisfied`、`missing`、`dependents`、`autoInstalled`、`autoRemovable`、`catalogDrift`。
- 当前安装健康和 current catalog drift 分层，不因 current catalog 新增依赖直接把旧安装判为缺失依赖。
- 主控制台复用 status 的只读依赖投影，不触发安装、修复或自动清理。
- JSON receipt 区分用户显式目标和自动依赖目标，actions 能区分依赖安装、依赖升级和自动依赖卸载。
- 默认人类输出说明自动依赖行为，但不暴露 ledger edge、ref-count 等内部结构。

第六层是作者工具、文档和测试：

- `.agents/skills/create-agent-workflows-plugin/` 的 manifest 参考、校验脚本、示例和夹具同步更新。
- `docs/plugin-authoring.md`、`docs/plugin-installation.md`、`docs/architecture.md` 和 `docs/testing.md` 补齐依赖语义。
- 单元测试覆盖 manifest、planner、ledger、写命令、status、receipt 和作者工具。
- 集成测试覆盖真实 CLI 安装、升级、卸载、自动清理、跨 scope 和平台条件。

## 执行边界

本轮覆盖：

- source manifest、runtime bundle manifest 和 build staging manifest 的 `dependencies.plugins`。
- 当前 AW catalog 内插件依赖，不支持外部 marketplace、URL、npm 包、git source 或本地路径依赖。
- Codex 和 Claude Code 两个平台内的依赖图展开。
- user scope、当前 project scope 和 Codex project installability 规则。
- `install`、`upgrade`、`upgrade --all`、`uninstall`、`status`、主控制台模型、默认输出和 JSON receipt。
- installed ledger 的安装来源和 canonical outgoing dependency edges。
- 作者工具、公开文档、开发文档和测试夹具。

本轮不覆盖：

- 版本约束、semver resolution、多个版本并存。
- 跨 marketplace dependency。
- dependency entry 覆盖安装 platform。
- 按 OS、CPU、宿主版本、配置值或 feature flag 选择依赖。
- `--no-dependencies`、确认式依赖安装或脚本化交互流程。
- 把依赖字段写入 Codex / Claude 原生 manifest。
- AW 之外的原生平台安装路径自动补齐 AW 依赖。
- 旧版用户 ledger 的自动迁移、历史 edge 推断或 backfill。

## 总体方案

### Manifest 合同

修改范围：

- `packages/cli/src/types.ts`
- `packages/cli/src/utils/manifest.ts`
- `packages/cli/src/utils/bundle-layout.ts`
- `packages/cli/src/generators/local-plugin.ts`
- `packages/cli/tests/unit/manifest.test.ts`
- `packages/cli/tests/unit/manifest-coverage.test.ts`
- `packages/cli/tests/smoke/build-smoke.test.ts`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`
- `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`

任务：

- [ ] 新增 `PluginDependenciesConfig`、`PluginDependencyEntry`、`PluginDependencyTarget`、`PluginDependencyWhen` 等类型。
- [ ] 在 manifest normalizer 中校验 `dependencies` 顶层白名单。
- [ ] 校验 `dependencies.plugins` 数组形状，空数组允许但构建和作者工具给 warning。
- [ ] 校验 dependency entry 字段白名单，拒绝 `version`、`range`、`platform`、`target.platform`、`marketplace`、`source`、`optional`、`dev`、`peer` 等字段。
- [ ] 校验 dependency `name` 使用和 manifest `name` 相同的安全命名规则。
- [ ] 校验 dependency `name` 不能等于当前插件自身。
- [ ] 校验 `target.scope`、`when.platforms` 和 `inheritInstallOptions` 类型。
- [ ] 校验同一 manifest 内同名依赖的平台条件不重叠；省略 `when` 视为同时覆盖 `codex` 和 `claude`。
- [ ] 把 catalog-level 依赖存在性校验放在 current catalog 解析后执行，避免单个 manifest normalizer 强依赖全 catalog。
- [ ] build 流程在 `scripts.node.build` 改写 staging manifest 后，重新校验 staging `.agents-plugin/plugin.json` 的依赖合同。
- [ ] 平台 manifest 生成时明确过滤 `dependencies`，防止 Codex / Claude 原生 manifest 收到未知字段。
- [ ] 作者工具 validator 与 CLI 校验保持同一语义，至少覆盖字段白名单、自依赖、catalog 可解析、平台条件和同名重叠。

完成标准：

- CLI 能读取并保留 source/runtime `.agents-plugin/plugin.json` 中的合法依赖声明。
- `pnpm build` 会拒绝 build script 生成的非法 staging 依赖声明。
- 平台原生 manifest 和平台 marketplace manifest 不包含 `dependencies`。
- 作者工具不会接受 CLI 会拒绝的依赖字段。

### Location 与图模型

建议新增模块：

- `packages/cli/src/utils/plugin-dependency-location.ts`
- `packages/cli/src/utils/plugin-dependency-graph.ts`
- `packages/cli/src/utils/plugin-dependency-planner.ts`

核心类型建议：

```ts
interface PluginLocation {
  plugin: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  projectKey: string | null;
}

interface PlannedDependencyEdge {
  dependent: PluginLocation;
  dependency: PluginLocation;
  entry: PluginDependencyEntry;
  manifestPlugin: string;
  manifestVersion: string;
}

type PlannedNodeReason =
  | 'requested'
  | 'alreadySatisfiedDependency'
  | 'installDependency'
  | 'upgradeDependency'
  | 'uninstallAutoDependency';
```

任务：

- [ ] 建立稳定 location identity serializer，用于排序、去重、ledger edge 比较、receipt 和测试断言。
- [ ] 当前命令不在项目内且目标 scope 为 `project` 时，在 planner 阶段 fail fast。
- [ ] `--platform auto` 的解析继续在依赖展开前完成，planner 只消费已确定的 platform 集合。
- [ ] 每个平台独立展开生效依赖图，过滤当前 platform 不生效的 dependency entry。
- [ ] 当前 platform 不生效的 entry 不参与 platform products 校验、scope installability、循环检测、满足检查、自动安装或 edge 写入。
- [ ] 所有 entry 的结构校验不受当前安装 platform 影响，非法 `when.platforms` 或自依赖始终失败。
- [ ] 直接依赖顺序保留 manifest 数组顺序；用户显式目标保留命令行顺序；独立子图按首次出现顺序稳定排序。
- [ ] 循环依赖错误输出完整链路，例如 `a -> b -> c -> a`。
- [ ] 多路径指向同一 location 时只规划一次写入，但为每个 dependent 提交独立 outgoing edge。
- [ ] planner 输入模型区分 current catalog manifest 和 installed snapshot manifest：install / upgrade 使用 current catalog 展开目标图，status 可用 snapshot-first 的只读健康层。
- [ ] planner 输出 graph-level preflight 需要覆盖的所有待写 location。

完成标准：

- planner 单测能只用 catalog manifest、installed snapshot manifest、ledger fixture 和 health fixture 验证依赖图展开，不需要真实 adapter 写文件。
- 循环、自依赖、缺失 catalog 依赖、同名重叠平台条件都在写状态前失败。

### Location-Aware 满足规则

修改范围：

- 新增 planner 模块
- `packages/cli/src/commands/codex-project-installability.ts`
- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/console-model.ts`
- `packages/cli/src/adapters/codex.ts`
- `packages/cli/src/adapters/claude.ts`

任务：

- [ ] 定义依赖满足健康条件：必须有完整 AW-managed 安装证据；external-only、breadcrumb-only、enabled-only、cache-only、tracking 损坏或需要 repair 的状态都不算满足。
- [ ] user 父插件只能由同 platform 的 user scope 健康依赖满足。
- [ ] user 父插件遇到当前 platform 生效且 `target.scope: "project"` 的依赖时，在写状态前失败。
- [ ] project 父插件省略 `target.scope` 时，先选当前 project scope；当前 project 缺失或不健康时，允许 fallback 到 user scope 健康依赖。
- [ ] 显式 `target.scope: "user"` 只检查 user scope，缺失时安装到 user scope。
- [ ] 显式 `target.scope: "project"` 只检查当前 project scope，缺失时安装到当前 project scope，不允许 user fallback。
- [ ] 如果 dependent 已有 outgoing edge 指向仍健康、可见且仍满足 manifest target 约束的位置，继续保留该 edge。
- [ ] 只有旧 edge 不健康、不可见或不再满足 target 约束时，才按确定性规则重新选址。
- [ ] Codex project scope 缺失依赖安装前复用现有 project installability：纯 native-only、`apps` 或缺少 repo-managed surface 的插件必须失败。
- [ ] required config、external ownership、tracking identity、role namespace、project safety 等 preflight 要覆盖所有待写依赖节点。

完成标准：

- 单测覆盖 user 父插件不能依赖 project、project 父插件省略 scope fallback user、显式 project 不 fallback、显式 user 不被 project 满足。
- status 只读路径使用相同规则投影，不迁移 edge。

### Ledger 合同

修改范围：

- `packages/cli/src/types.ts`
- `packages/cli/src/utils/local-marketplace.ts`
- `packages/cli/src/commands/install.ts`
- `packages/cli/src/commands/upgrade.ts`
- `packages/cli/src/commands/uninstall.ts`
- `packages/cli/tests/unit/installed-ledger.test.ts`
- `packages/cli/tests/unit/local-marketplace.test.ts`

任务：

- [ ] 扩展 `InstalledScopeRecord`，新增安装来源字段，能表达 explicit 保留、auto-installed 来源和“引用归零时允许自动清理”的策略语义；字段命名必须避开只读投影 `autoRemovable`。
- [ ] 扩展 `InstalledScopeRecord`，新增 `dependencyEdges` 或等价字段，只存 canonical outgoing edges。
- [ ] edge 端点必须包含 `plugin`、`platform`、`scope`、`projectKey`，user scope 的 `projectKey` 固定为 `null` 或省略并在读取时规范化。
- [ ] edge 记录 dependency entry 的声明摘要，包括 `name`、`target.scope`、`inheritInstallOptions` 和 `when.platforms`。
- [ ] `validateInstalledLedger()` 严格校验新字段；缺字段的开发期 ledger 在依赖相关动作中 fail closed。
- [ ] 新增 graph helper，从 ledger outgoing edges 构建 incoming dependents index。
- [ ] 禁止持久化 `dependents`、`ref-count` 和派生的 `autoRemovable` 真值。
- [ ] 用户显式安装一个已自动安装的依赖时，把 explicit 保留标记置为 true，之后父插件卸载不能自动删除它。
- [ ] 同一 dependent 重复 install 或 upgrade 时覆盖同一 edge，不增加重复 ref。
- [ ] 父插件卸载时先移除 outgoing refs，再从 incoming index 计算自动清理候选。
- [ ] ledger degraded、edge 不完整或 tracking identity 损坏时，不执行自动依赖清理。

完成标准：

- 新 ledger schema 能精确表达同一插件在 `codex/user`、`codex/project:<key>`、`claude/user` 等不同位置的依赖引用。
- 自动清理候选完全从 canonical outgoing edges 推导。

### Install 图级事务

修改范围：

- `packages/cli/src/commands/install.ts`
- `packages/cli/src/commands/platform-resolution.ts`
- `packages/cli/src/commands/common.ts`
- `packages/cli/src/output/command-receipt.ts`
- `packages/cli/tests/unit/install-command.test.ts`
- `packages/cli/tests/integration/cli.test.ts`

任务：

- [ ] 保持现有显式目标解析和 platform auto 解析顺序，依赖不参与 platform 自动选择。
- [ ] 在准备写状态前调用 planner，得到完整 location-level install graph。
- [ ] 对所有待写 node 统一执行 preflight，包括 platform products、scope installability、required config、external ownership、tracking identity、Codex project safety、role/MCP namespace 和 install options。
- [ ] 依赖安装选项默认不继承父插件；只有 `inheritInstallOptions: true` 时继承插件级安装选项。
- [ ] 多个父插件在同一命令中对同一缺失依赖产生冲突安装选项时，在写状态前失败。
- [ ] 按拓扑顺序安装依赖和父插件，依赖先写，父插件后写。
- [ ] 新装的 auto dependency 标记为自动依赖；显式目标标记为 explicit。
- [ ] 父插件成功安装后再提交自己的 outgoing dependency edges。
- [ ] 父插件失败前不能提前写入该父插件的 edge。
- [ ] 后续父插件失败时，新装 auto dependency 如果尚未被任何成功 dependent edge 引用，优先回滚卸载。
- [ ] 新装 auto dependency 已经被其它成功 dependent 引用时，不因后续另一个父插件失败而卸载。
- [ ] 无法完整回滚时 fail closed，不留下失败父插件的成功 edge，并把新建自动依赖标记成可诊断的 degraded 或 cleanup-blocked 状态。
- [ ] 默认输出说明自动安装了哪些依赖。
- [ ] JSON receipt 中每个 target 带 `requested`；自动依赖 target 带 `dependencyOf`。

完成标准：

- `aw install workflow-pack -p codex -s project` 能自动补齐生效依赖，再安装父插件。
- 任一图级 preflight 失败时，不写 native、artifact、tracking、ledger 或 snapshot。
- JSON receipt 能区分用户显式目标和自动依赖目标。

### Upgrade 行为

修改范围：

- `packages/cli/src/commands/upgrade.ts`
- `packages/cli/src/output/command-receipt.ts`
- `packages/cli/tests/unit/upgrade-command.test.ts`
- `packages/cli/tests/integration/upgrade-command.test.ts`

任务：

- [ ] 显式 `aw upgrade <plugin...>` 复用 planner 展开 current catalog 依赖图。
- [ ] 缺失依赖先安装，已安装依赖先升级，父插件最后升级。
- [ ] `upgrade` 复用阶段 4 的通用 graph write executor，不再把 planner 产物拆回旧的逐 `platform -> target` 执行边界。
- [ ] graph executor 支持同一张图内混合节点动作：缺失自动依赖为 `installDependency`，已安装依赖为 `upgradeDependency`，用户显式父插件为 `upgrade`。
- [ ] `upgrade` 失败收口遵守 install 相同的图级事务合同：graph-level preflight 在第一笔写状态前完成、dependent 成功后才提交 edge、失败父插件不留下 planned edge，无法完整回滚时写入 degraded / cleanup-blocked。
- [ ] catalog 缺失、capabilityChanged、tracking 损坏、required config 缺失、external ownership 和 Codex project safety 继续按现有 upgrade 安全规则处理。
- [ ] breadcrumb-only 或其它非完整受管状态不能作为依赖满足或 upgrade source。
- [ ] 升级成功后刷新当前 platform 生效的 dependency refs：新增写入、删除移除、平台条件不再生效的 edge 移除。
- [ ] `upgrade --all` 根集合只包含 explicit 保留安装。
- [ ] auto-installed location 只有从 explicit root 的 current catalog 目标依赖图可达时，才参与 upgrade-all 前置图。
- [ ] current catalog 目标图内依赖 skipped 时，依赖它的父插件也 skipped，原因指向依赖未满足或依赖升级失败。
- [ ] 旧 edge 指向但 current catalog 不再需要的 auto dependency 不阻塞父插件升级；父插件升级成功刷新 refs 后再进入自动清理候选。
- [ ] upgrade receipt actions 区分 `upgradeDependency` 和用户显式 `upgrade`。

完成标准：

- 显式 upgrade 和 upgrade-all 都不会在依赖失败后继续升级父插件。
- 删除的依赖 ref 只在父插件升级成功后从 ledger 移除。
- 缺失依赖安装、既有依赖升级和父插件升级在同一张 location-level 图里完成事务管理。
- 依赖升级失败、父插件升级失败和无法完整回滚都会按 graph executor 的 fail-closed 语义收口。

### Uninstall 与自动清理

修改范围：

- `packages/cli/src/commands/uninstall.ts`
- `packages/cli/src/commands/discovery.ts`
- `packages/cli/src/commands/interactive.ts`
- `packages/cli/src/commands/console-model.ts`
- `packages/cli/src/output/command-receipt.ts`
- `packages/cli/tests/unit/uninstall-command.test.ts`
- `packages/cli/tests/integration/cli.test.ts`

任务：

- [ ] uninstall planner 先从 ledger outgoing edges 构建 incoming dependents index。
- [ ] 用户显式卸载目标仍被其它 installed dependent 引用时失败，并列出 dependent location。
- [ ] 如果用户同一命令内卸载所有 dependents，允许继续。
- [ ] 父插件先卸载，再按反向拓扑卸载不再需要的自动依赖。
- [ ] 自动清理候选必须来自 canonical incoming edge，且位于当前命令可操作的同 platform user scope 或当前 project scope。
- [ ] 其它历史 project scope 的自动依赖不能被当前 cwd 的卸载命令跨项目删除。
- [ ] 自动依赖只有未被 explicit 保留、没有其它 installed dependent、状态不是 external-only 或 identity 不完整时才可清理。
- [ ] ledger degraded、dependency refs 不完整或 tracking identity 损坏时，不执行高风险自动清理。
- [ ] Codex user breadcrumb-only cleanup 继续按现有 native recovery 语义处理，但不能被当作完整依赖满足。
- [ ] receipt actions 区分用户显式 `uninstall` 和 `uninstallAutoDependency`。
- [ ] 默认输出说明随父插件自动清理的依赖。

完成标准：

- 卸载父插件会自动移除引用归零的自动依赖。
- 显式安装保留过的依赖不会被父插件卸载连带删除。
- 仍有 dependents 的插件不能被单独卸载。

### Status 与控制台投影

修改范围：

- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/console-model.ts`
- `packages/cli/src/commands/discovery.ts`
- `packages/cli/src/types.ts`
- `packages/cli/src/output/model.ts`
- `packages/cli/tests/unit/adapter-status.test.ts`
- `packages/cli/tests/unit/console-model.test.ts`
- `packages/cli/tests/unit/status-dependencies.test.ts`
- `packages/cli/tests/integration/discovery.test.ts`

任务：

- [ ] `status` 使用 planner 只读投影依赖关系，不迁移 edge、不安装依赖、不触发自动清理。
- [ ] planner 的只读输入模型加入 installed snapshot manifest；写命令使用 current catalog 展开目标图，status 优先用 snapshot 判定当前安装健康，snapshot 不可用时才带来源诊断 fallback。
- [ ] 在 `types.ts` 增加 status dependencies payload 类型，并把 `PluginStatusReport.dependencies` 作为稳定 JSON schema 字段。
- [ ] 当前安装健康优先依据 installed snapshot manifest 中的 `dependencies` 和 ledger outgoing edges。
- [ ] installed snapshot 缺失或损坏时，才按既有 `healthSource` 降级到 current catalog、historical 或 none，并在 verbose/json 中标出来源。
- [ ] current catalog drift 单独展示，不直接写入 `dependencies.missing`。
- [ ] 输出 `dependencies.declared`，展示 current catalog 直接依赖和 `when.platforms`。
- [ ] 输出 `dependencies.resolved`，展示当前安装健康层解析后的生效依赖目标和来源。
- [ ] 输出 `dependencies.satisfied`，展示依赖满足位置。
- [ ] 输出 `dependencies.missing`，只展示当前安装健康层缺失、损坏或不可用的依赖。
- [ ] 输出 `dependencies.dependents`，由 ledger outgoing edges 反向推导。
- [ ] 输出 `dependencies.autoInstalled` 和 `dependencies.autoRemovable`。
- [ ] 输出 `dependencies.catalogDrift`，展示新增、删除、平台条件变化和 target scope 变化。
- [ ] 父插件自身健康但当前安装健康层依赖缺失时，友好状态进入需要处理。
- [ ] 当前 platform 不生效的 entry 只出现在 declared 诊断，不影响 ready。
- [ ] 自动依赖没有 dependents 且未 explicit 保留时，控制台可展示清理动作；真正清理必须走 destructive 确认。

完成标准：

- `aw status --json` 能稳定表达依赖声明、满足位置、缺失依赖、被依赖关系和 catalog drift。
- 主控制台不需要重新实现依赖判定。

### 输出与 Receipt

修改范围：

- `packages/cli/src/output/command-receipt.ts`
- `packages/cli/src/output/model.ts`
- `packages/cli/src/output/reporter.ts`
- `packages/cli/src/output/debug-log.ts`
- `packages/cli/src/commands/install.ts`
- `packages/cli/src/commands/upgrade.ts`
- `packages/cli/src/commands/uninstall.ts`
- `packages/cli/tests/unit/command-receipt.test.ts`
- `packages/cli/tests/integration/cli-entry-json-harness.test.ts`

任务：

- [ ] 扩展 receipt target：`requested: boolean`、`dependencyOf?: PluginLocation[]`。
- [ ] 扩展 action type：`installDependency`、`upgradeDependency`、`uninstallAutoDependency`，并保留用户显式动作。
- [ ] `plugins` 包含本次所有受影响插件，包括自动依赖。
- [ ] `warnings[]` 中依赖 warning 必须包含插件名、platform、scope 和可复制命令。
- [ ] 默认输出使用短句说明自动依赖行为，例如“已安装 workflow-pack，并自动安装依赖 git-commit。”
- [ ] 依赖缺少 required config 的失败输出指向依赖插件和配置 key。
- [ ] 依赖相关 debug event 使用 location identity，避免只按插件名造成跨 scope 混淆。
- [ ] 补 `command-receipt` 单测，覆盖 JSON target/action schema、`requested` / `dependencyOf` 去重、依赖 action type、warning 字段和默认输出摘要。

完成标准：

- `--json` stdout 仍是单一可解析 JSON。
- 默认人类输出不暴露内部 edge、ref-count 或 ledger 字段名。

## 阶段计划

### 阶段 0：基线梳理与 fixture 准备

- [ ] 锁定现有 `install`、`upgrade`、`uninstall`、`status`、`console-model`、`local-marketplace` 的关键测试入口。
- [ ] 新增最小 fixture 插件：
  - 无依赖父插件。
  - 同 scope 依赖父插件。
  - Codex-only 依赖和 Claude-only 依赖。
  - project 父插件依赖 user scope 插件。
  - project 父插件显式依赖 project scope 插件。
  - 循环依赖 fixture。
  - 同名平台条件重叠 fixture。
- [ ] 为 planner 准备轻量 catalog / ledger / health fixture builder。
- [ ] fixture builder 支持 installed snapshot manifest，并能表达 snapshot 与 current catalog dependency drift。
- [ ] 补一个当前行为回归测试，证明父插件现在不会自动安装依赖，作为后续行为变更的对照。

完成标准：测试 fixture 可以独立表达 spec 中所有核心依赖组合。

### 阶段 1：manifest schema 与作者工具

- [ ] 扩展 CLI 类型和 manifest normalizer。
- [ ] 添加 catalog-level dependency reference validator。
- [ ] build staging manifest 后重新校验依赖合同。
- [ ] 确保平台原生 manifest 过滤 `dependencies`。
- [ ] 更新作者工具 validator 和 manifest spec。
- [ ] 建立 CLI validator 与作者工具 validator 的 parity fixture，同一组非法 manifest 必须同时被 CLI 和 `validate_plugin.js` 拒绝。
- [ ] 补 manifest / authoring-tools 单测。

完成标准：合法依赖声明能通过 CLI 和作者工具；非法字段、非法平台条件、自依赖和同名重叠会失败。

### 阶段 2：ledger schema 与 location 图基础

- [ ] 扩展 installed ledger 类型和 validator。
- [ ] 添加 location identity helper。
- [ ] 添加 outgoing edge normalizer 和 incoming index builder。
- [ ] 添加 explicit 保留、auto-installed 来源和 `autoCleanupAllowed`（引用归零时允许自动清理）这类策略字段；`autoRemovable` 仍只作为读路径投影。
- [ ] 添加 ledger fixture 和 schema 单测。

完成标准：ledger 能表达 location-level outgoing edges，读路径能稳定推导 dependents。

### 阶段 3：统一 planner

- [ ] 实现 install / 显式 upgrade 的依赖图展开和拓扑排序。
- [ ] 实现 location-aware 满足规则和已有 edge 保留规则。
- [ ] 实现 platform condition 过滤、platform products 校验、循环检测和缺失依赖校验。
- [ ] 实现 install options 继承和冲突检测。
- [ ] 实现 upgrade-all root 选择、目标图展开和 skipped 传播模型。
- [ ] 实现 uninstall 保护和自动清理 planning。
- [ ] 实现 status 只读投影模型。
- [ ] status planner 单测覆盖 installed snapshot manifest、snapshot 不可用 fallback 和 current catalog drift。
- [ ] 补 planner 单测，优先覆盖 scope fallback、显式 target 硬约束、循环和排序。

完成标准：planner 可以在不执行 adapter 写入的情况下产出 install、upgrade、uninstall 和 status 所需的稳定计划。

### 阶段 4：graph write executor 与 install 接入

- [ ] 在 `installCommand()` 中接入 planner。
- [ ] 调整 preflight，让所有待写 location 在第一笔写状态前完成校验。
- [ ] 先从 `installTargetsOnPlatforms()` 拆出“单个 location node 原子安装器”，只负责一个 node 的 native / artifact / tracking / ledger / snapshot 写入和该 node 的回滚。
- [ ] 新增通用 graph write executor，按拓扑顺序调用单节点安装器，并统一管理 graph-level preflight、已成功 dependent edge 集、dependent edge 延迟提交、共享 auto dependency 回滚归属和 fail-closed 写回。
- [ ] graph write executor 的节点动作先接入 install 所需的 `installDependency` / `install`，接口预留阶段 5 的 `upgradeDependency` / `upgrade`，但事务合同只实现一套。
- [ ] 旧的 `platform -> target` 双层循环不能继续作为依赖事务边界；保留的旧逻辑只能作为单节点执行细节逐步迁移。
- [ ] 自动依赖写入安装来源。
- [ ] 父插件成功后提交 outgoing edges。
- [ ] 实现失败回滚和 fail-closed degraded / cleanup-blocked 语义。
- [ ] 扩展 install receipt 和默认输出。
- [ ] 补 install 单元和集成测试，单测必须覆盖 `--platform auto` 不受依赖影响、图级 preflight 只读失败、父插件失败后的 rollback / degraded / cleanup-blocked。

完成标准：安装父插件能自动补齐缺失依赖；任一依赖 preflight 失败时命令完全只读。

### 阶段 5：upgrade 接入

- [ ] 显式 upgrade 接入 planner，先处理依赖，后处理父插件。
- [ ] 缺失依赖走自动 install，已安装依赖走 upgrade。
- [ ] 显式 upgrade 和 upgrade-all 都复用阶段 4 的 graph write executor；阶段 5 只扩展 upgrade 节点动作和 upgrade-specific preflight，不新增一套平行事务执行器。
- [ ] graph write executor 支持同一图内混合执行 `installDependency`、`upgradeDependency` 和用户显式 `upgrade`，并保持依赖先于 dependent 的拓扑顺序。
- [ ] `upgrade.ts` 不能在 planner 之后回退到逐批调用 `installTargetsOnPlatforms(..., operation: 'upgrade')` 作为事务边界；旧 install path 只能保留在单节点执行细节中。
- [ ] `upgrade` 失败收口和 install 共用同一套 edge 延迟提交、共享 auto dependency 回滚归属和 fail-closed degraded / cleanup-blocked 写回逻辑。
- [ ] 升级成功后刷新 current platform 生效 refs。
- [ ] `upgrade --all` 改为 explicit roots + current catalog target graph。
- [ ] 对依赖 skipped 做父插件 skipped 传播。
- [ ] 把不再需要的旧 auto dependency 放入自动清理候选。
- [ ] 扩展 upgrade receipt。
- [ ] 补 upgrade 单元和集成测试，必须覆盖依赖升级失败后父插件不继续、edge 不提前提交、旧 ref 只在父插件成功后移除、无法完整回滚时进入 degraded / cleanup-blocked。

完成标准：upgrade 复用 graph write executor 完成图级事务；不会绕过依赖失败继续升级父插件；upgrade-all 不把孤立自动依赖当根。

### 阶段 6：uninstall 与自动清理接入

- [ ] uninstall 接入 planner 的 incoming index。
- [ ] 实现仍被依赖目标的卸载保护。
- [ ] 支持同命令卸载完整 dependent 集合。
- [ ] 父插件卸载后按反向拓扑自动清理引用归零的自动依赖。
- [ ] explicit 保留依赖不自动删除。
- [ ] degraded 或不可信状态下跳过自动清理并给可行动错误。
- [ ] 扩展 uninstall receipt 和默认输出。
- [ ] 补 uninstall 单元和集成测试。

完成标准：卸载父插件能安全清理自动依赖，同时不会破坏仍依赖它的其它插件。

### 阶段 7：status、discovery 与控制台

- [ ] `status` 接入 planner 只读投影。
- [ ] 扩展 status JSON schema 的 dependencies 字段。
- [ ] 补 `types.ts` 中 status dependencies payload，并用 snapshot fixture 覆盖 snapshot-first、fallback source 和 current catalog drift。
- [ ] 扩展默认 status 文本和 verbose 诊断。
- [ ] `console-model` 复用同一投影，新增依赖缺失、可清理自动依赖等友好原因。
- [ ] discovery / 交互候选识别 auto-installed 和被依赖保护状态。
- [ ] 补 status、console-model 和 discovery 测试。

完成标准：用户能通过 `aw status` 和主控制台看懂依赖是否满足、谁依赖谁、哪些自动依赖可清理。

### 阶段 8：文档、作者技能和示例

- [ ] 更新 `docs/architecture.md`：补 dependency planner、ledger edge 和写命令顺序。
- [ ] 更新 `docs/plugin-authoring.md`：说明 `dependencies.plugins` 字段、平台条件、scope target 和限制。
- [ ] 更新 `docs/plugin-installation.md`：说明自动安装、升级顺序、卸载自动清理和错误排查。
- [ ] 更新 `docs/testing.md`：补依赖 planner、ledger edge 和跨 scope 测试约定。
- [ ] 更新 `.agents/skills/create-agent-workflows-plugin/SKILL.md` 和 references。
- [ ] 更新 comprehensive example，加入一个带平台条件和 scope target 的依赖示例。
- [ ] 更新作者工具相关测试。

完成标准：公开文档、作者工具和 CLI 行为没有互相冲突的说法。

### 阶段 9：最终验证

- [ ] 跑依赖相关 Vitest 文件。
- [ ] 跑完整单元测试。
- [ ] 跑完整集成测试。
- [ ] 跑 build smoke。
- [ ] 检查 JSON receipt stdout 没有混入 warning、verbose 或 debug 文案。
- [ ] 检查 `pnpm build` 产物中 runtime `.agents-plugin/plugin.json` 保留 `dependencies`，平台 manifest 不包含 `dependencies`。

必跑命令：

```bash
pnpm test:unit
pnpm test:integration
pnpm test:smoke:build
```

完成标准：核心命令、状态投影、作者工具和 build 产物都通过依赖相关验收。

## 测试重点

单元测试重点：

- manifest 接受合法 `dependencies.plugins`。
- manifest 拒绝未知字段、非法 `target.scope`、非法 `when.platforms`、重复平台、自依赖和同名平台条件重叠。
- staging manifest 被 build script 改坏时 build 失败。
- 平台原生 manifest 不包含 `dependencies`。
- planner 过滤当前 platform 不生效的 dependency entry。
- planner 对 `--platform both` 分平台展开不同依赖图。
- planner 对 project 父插件省略 `target.scope` 时优先 project，再 fallback user。
- planner 对显式 `target.scope: "project"` 禁止 user fallback。
- planner 对 user 父插件依赖 project scope 失败。
- planner / command 证明 `--platform auto` 在依赖展开前完成，依赖声明不会改变平台自动选择结果。
- planner 保留已有 healthy edge，不因另一个位置后来健康而迁移。
- 循环依赖输出完整链路。
- 多父插件共享同一缺失依赖时只安装一次。
- 多父插件对同一缺失依赖产生冲突继承安装选项时失败。
- CLI validator 与作者工具 validator 使用同一组非法 manifest parity fixture。
- ledger validator 校验安装来源和 outgoing edges。
- incoming dependents 从 outgoing edges 推导。
- ledger / planner 覆盖重复 install、重复 upgrade、install 后 upgrade 三条路径，确认同一 `dependent location + dependency location` 只保留一条 canonical edge。
- install 图级 preflight 失败时不写 native、artifact、tracking、ledger 或 snapshot。
- install 写父插件 edge 发生在父插件成功之后。
- 父插件失败时未被成功 edge 引用的新 auto dependency 会回滚；无法完整回滚时进入 degraded / cleanup-blocked，并且不留下失败父插件 edge。
- 已被其它成功 dependent edge 引用的新 auto dependency，不因后续父插件失败被卸载。
- upgrade 的缺失依赖安装、既有依赖升级和父插件升级共用 graph write executor；依赖升级失败时父插件不继续，失败父插件 edge 不提交。
- upgrade 删除的旧 dependency ref 只在父插件升级成功后移除；父插件升级失败时旧 ref 保持不变。
- upgrade 无法完整回滚时进入 degraded / cleanup-blocked，不留下失败父插件的新成功 edge。
- explicit install 一个 auto dependency 后，父插件卸载不会自动删除它。
- upgrade 成功刷新新增、删除和平台条件变化后的 refs。
- upgrade-all 只把 explicit record 当根。
- uninstall 保护仍被依赖目标。
- uninstall 放行同命令卸载完整 dependent 集合，并按反向拓扑移除目标与自动依赖。
- status 区分当前安装健康缺失依赖和 current catalog drift。
- status 覆盖当前 platform 不生效的 dependency entry 只进入 `declared`，不影响 ready / needsAttention。
- status 覆盖 installed snapshot 自洽但 current catalog 新增依赖时，只展示 catalog drift 或 upgrade 建议，不把当前安装判成 needsAttention。
- status 通过 `types.ts` 中的 dependencies payload 表达 declared、resolved、satisfied、missing、dependents、autoInstalled、autoRemovable 和 catalogDrift。
- `console-model` 覆盖依赖投影的友好状态：缺失的当前健康层依赖进入 needsAttention，纯 catalog drift 不打坏 ready，可清理 auto dependency 只在引用归零且未 explicit 保留时展示清理动作。
- `command-receipt` 单测覆盖 JSON / human output、依赖 action type、target 去重、`requested` 和 `dependencyOf`。

集成测试重点：

- `aw install workflow-pack -p claude -s user` 自动安装同 scope 依赖。
- `aw install workflow-pack -p codex -s user` 只展开 Codex 生效依赖，不因 Claude-only 依赖失败。
- `aw install workflow-pack -p claude -s user` 只展开 Claude 生效依赖，不因 Codex-only 依赖失败。
- `aw install repo-workflow -p codex -s project` 能依赖 Codex user scope 插件。
- 显式 `target.scope: "project"` 的依赖只能由当前项目满足。
- 已健康安装的依赖不重复安装，但父插件 ledger 写入 edge。
- required config 缺失时错误指向依赖插件。
- `aw upgrade workflow-pack` 补齐新增依赖并刷新 refs。
- `aw upgrade --all` 不把孤立 auto dependency 当根。
- 卸载父插件自动清理引用归零的 auto dependency。
- 仍被其它插件依赖的插件不能被单独卸载。
- 同一条 `aw uninstall ...` 同时包含完整 dependent 集合时允许继续，并验证最终 ledger / native 状态不留下断裂依赖引用。
- `aw status --json` 展示 declared、resolved、satisfied、missing、dependents、autoInstalled、autoRemovable、catalogDrift。
- 默认输出说明自动安装或自动清理行为。

## 关键风险

- 图级 preflight 如果仍散落在 command 和 adapter 内，容易出现依赖已经写入、父插件 preflight 才失败的半提交状态。
- upgrade 如果在 planner 之后继续走旧的逐批 `installTargetsOnPlatforms(..., operation: 'upgrade')` 边界，会绕开 graph write executor 的 edge 延迟提交和 fail-closed 回滚合同。
- location-aware 规则一旦在 install、upgrade、uninstall、status 中重复实现，就很容易出现 `target.scope: "project"` 被 user fallback 错误满足的问题。
- `upgrade --all` 根集合如果继续按所有 managed records 计算，会把孤立 auto dependency 错当成用户想升级的插件。
- status 如果直接用 current catalog 依赖声明判断旧安装，会把 snapshot 自洽的旧安装误报成缺依赖。
- 自动清理必须 fail closed；ledger edge、tracking identity 或 native recovery 不可信时，不应猜测 ref-count 后删除插件。
- Codex project scope 的 installability 要在依赖缺失安装前检查，否则会把 native-only 依赖写进 project scope 的错误路径。
- JSON receipt schema 变化会影响脚本调用方，必须通过兼容字段和测试锁住结构。

## 最终验收

- 插件作者可以在 `.agents-plugin/plugin.json` 顶层声明 `dependencies.plugins`。
- `aw install <plugin>` 会按当前 platform 生效依赖图自动补齐缺失依赖。
- 依赖安装顺序稳定，依赖先于父插件写入。
- 自依赖、循环依赖、缺失依赖、平台不兼容、scope 不可安装和安装选项冲突都会在写状态前失败。
- project 父插件省略 `target.scope` 时可复用健康 user 依赖；显式 `target.scope` 始终是硬约束。
- ledger 能记录 explicit / auto-installed 来源和 canonical outgoing dependency edges。
- 卸载父插件会自动清理引用归零、未显式保留且状态可信的自动依赖。
- `upgrade <plugin>` 和 `upgrade --all` 都复用 graph write executor 按依赖拓扑执行，并正确刷新 refs。
- `aw status` 和主控制台能显示依赖健康、被依赖关系、自动安装来源和可清理状态。
- JSON receipt 能区分用户显式目标和自动依赖目标。
- 作者工具、公开文档和 build smoke 与 CLI 依赖合同保持一致。
