# `aw` 版本管理需求 Spec

日期：2026-05-15
状态：需求确认稿
基线需求：`docs/dev/specs/aw-tui-ux-polish-followup.md`
文档规范：`docs/dev/spec-plan-writing-guide.md`

## 文档定位

这份 Spec 只定义 `aw` CLI、插件、`@yiliang/aw-plugins` 远程 catalog 包和插件依赖版本管理的需求边界、现状探查结论、公开合同和验收标准，不写实现计划、阶段拆分、测试文件清单或迁移步骤。

本文件以 `docs/dev/specs/aw-tui-ux-polish-followup.md` 中已经确认的“版本号规范化”和“版本比较结果驱动可升级状态”为基线，并继续扩展出插件独立发布、独立更新、CLI 兼容性声明和依赖最小版本约束。若本文件和前置 Spec 对本地 catalog `sourceVersion` 的语义描述不同，以本文件的拆分语义为准：CLI 版本、catalog 发布版本和插件版本必须分开管理，不能继续用 CLI package version 代表所有 catalog 新鲜度。

## 背景

当前项目里至少存在两套用户可见版本：`@yiliang/aw` CLI package version，以及每个插件 manifest 中的 `version`。两者表面上都是版本号，但现有系统几乎没有统一规范：manifest 只校验字符串，运行时比较多处仍是字符串相等或不等，本地 catalog 的新鲜度也把 CLI 版本和 bundle fingerprint 混在一起判断。

更大的问题是插件发版依赖 CLI 发版。源码插件在 `pnpm build` 时被打进 `packages/cli/plugins-dist/`，再跟随 CLI npm 包发布。只要一个插件需要更新，即使 CLI 本身没有变化，也必须重新发布 CLI，用户也必须升级 CLI 才能拿到插件更新。这让插件迭代、修复和回滚都绑在 CLI 发布节奏上，版本责任不清晰。

本轮目标是把 CLI 和插件的版本责任拆开：CLI 负责提供运行时能力、命令合同和兼容性校验；插件通过独立 npm 包 `@yiliang/aw-plugins` 发布 catalog 和全部构建后插件 artifact，并通过 sidecar npm 包 `@yiliang/aw-plugins-manifest` 发布可独立获取的轻量 catalog manifest；用户通过 `aw` 现有安装和升级流程获取当前可用 catalog 中的插件。最新 catalog 只保存当前官方最新插件快照，不在同一个 catalog 内保留历史插件 artifact 或同一插件的多版本索引；但 catalog 需要保存轻量历史版本记录，并把它作为历史兼容查询和发布递增校验的唯一版本依据。旧 CLI 需要兼容时，应通过 catalog 历史记录找到仍支持当前 CLI 的最新 catalog package version；取不到可用历史记录时，不能改用 npm registry 的历史版本信息猜测。插件依赖也需要从“只知道依赖谁”升级为“知道最低需要哪个依赖版本”，但不引入完整 semver range，避免依赖解析复杂度过早膨胀。

## 现状探查结论

这一节只记录会影响需求边界的事实，不描述执行步骤。

### CLI 版本和本地 catalog 当前绑定在一起

- CLI 发布版本来自 `packages/cli/package.json`，根目录 `package.json` 也保存同一版本，并通过 `scripts/release/sync-version.mjs` 和 `Makefile` 的 release 入口同步。
- `packages/cli/src/utils/local-marketplace.ts` 会读取 CLI package version，并把它写入 `~/.aw/config.json` 的 `sourceVersion`。
- `packages/cli/src/utils/local-marketplace.ts` 当前用 `config.sourceVersion !== sourceVersion` 和 `bundleFingerprint !== bundleFingerprint` 判断本地 marketplace 是否新鲜。
- `packages/cli/src/utils/plugin-catalog.ts` 当前把本地 catalog 是否匹配当前 CLI version 和 bundle fingerprint 作为 local / embedded catalog 选择条件。
- 这些路径说明本地 catalog 新鲜度仍以 CLI package version 为中心，无法表达“CLI 未变，但远程插件 catalog 已更新”。

### 插件版本存在字段，但没有严格版本规范

- 插件 manifest 的 `version` 定义在 `packages/cli/src/types.ts` 的 `PluginManifestSource.version`。
- `packages/cli/src/utils/manifest.ts` 的 manifest 校验目前只要求 `version` 是字符串，不拒绝 `v1.2.3`、`1.2`、`latest` 或 `^1.2.3` 这类不符合严格 SemVer 2.0.0 的写法。
- `docs/dev/specs/aw-tui-ux-polish-followup.md` 已经把严格 SemVer 2.0.0 作为基线要求，并明确“规范化”不能自动清洗非法输入。
- 运行时参与比较的已安装版本来自 install record 的 `resolvedVersion` 或等价的已安装 source version。该字段当前也是字符串。

### 可升级判断已经有正确方向，但还没有统一版本比较

- `docs/dev/specs/aw-tui-ux-polish-followup.md` 已确认用户可见 `可升级` 只能由语义版本比较驱动。
- 当前 `packages/cli/src/commands/status.ts` 有只看 `resolvedVersion` 和 current catalog `manifest.version` 不一致的辅助逻辑，但仍是字符串不等。
- 当前 `packages/cli/src/commands/status.ts` 还会在版本相同但 bundle fingerprint 不同的情况下返回可升级证据，这和“同版本内容变化不能显示可升级”的基线要求冲突。
- 当前 `packages/cli/src/commands/console-model.ts` 会把 install-state projection 中的 `upgradeAvailable` 直接投影成首页状态，历史漂移信号仍可能影响用户看到的升级状态。

### 插件发布被 CLI bundle 绑定

- `packages/cli/scripts/bundle-plugins.ts` 默认把源码插件打包到 `packages/cli/plugins-dist/`。
- `packages/cli/package.json` 的 `files` 包含 `plugins-dist/`，`build` 和 `prepack` 都会生成这份 runtime bundle。
- `docs/architecture.md` 描述的三层分发模型是源码插件经 `pnpm build` 进入 CLI npm 包，再由 `aw init` 或安装流程同步到 `~/.aw`。
- 因此当前插件 artifact 的发布边界就是 CLI npm 包边界，插件没有独立发布身份。

### 依赖当前没有版本约束

- `packages/cli/src/types.ts` 的 `PluginDependencyEntry` 只有 `name`、`target`、`inheritInstallOptions` 和 `when`。
- `packages/cli/src/utils/manifest.ts` 当前只允许这些字段，并拒绝 `version`、`range`、`marketplace`、`source`、`optional`、`dev`、`peer` 和 platform override。
- `docs/plugin-authoring.md` 和 `.agents/skills/create-agent-workflows-plugin/SKILL.md` 也明确首版依赖不支持版本或 range。
- 状态输出中的 `dependencies` 是只读投影，包含 declared、resolved、satisfied、missing、catalogDrift 等信息，但没有依赖版本比较结果，也没有“不满足最低依赖版本”的稳定状态。

### 插件作者工具和公开文档必须同步调整

- `.agents/skills/create-agent-workflows-plugin/` 目前把 `--version <semver>` 作为脚手架参数，但仍说明依赖不能写版本。
- `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md` 和 `docs/plugin-authoring.md` 都把源码 manifest 作为唯一手写真值，并描述现有 dependencies 字段白名单。
- 项目维护原则要求：改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发/安装流程，或任何会影响插件作者使用方式的能力时，必须同步检查插件作者工具、模板、示例和测试夹具。

## 已确认决策

1. 插件独立更新采用 `@yiliang/aw-plugins` npm 包模型。该包每次发布都包含一个 catalog 版本和该 catalog 引用的全部构建后插件 artifact；CLI npm 包不再携带 embedded catalog、`plugins-dist/` 插件快照或离线插件兜底。
2. Catalog manifest 和插件 manifest 都必须声明最低可用 CLI 版本。Catalog 级 `compatibility.aw.minVersion` 是整包门槛，包内任一插件 manifest 的 `compatibility.aw.minVersion` 不能高于 catalog 级门槛，避免 catalog 判定可用后插件安装又被 CLI 版本阻止。
3. 本期明确接受 catalog 级最低 CLI 版本的整包门槛取舍：只要新 catalog 因任一插件或运行时能力要求提高了 catalog 级 `compatibility.aw.minVersion`，旧 CLI 就整体回退到历史兼容 catalog，不能继续消费该新 catalog 内其它仍可能单独兼容的插件更新。本期不做按插件过滤的细粒度兼容 catalog。
4. 兼容性判断前，CLI 只能通过 `@yiliang/aw-plugins-manifest` sidecar npm 包读取轻量 catalog manifest；不能为了读取 manifest 先下载完整 `@yiliang/aw-plugins` artifact tarball。sidecar package 与完整 catalog package 使用相同 catalog version 和发布轨道，manifest 必须声明完整 catalog package 的 name、version 和 channel；完整 npm tarball integrity 属于 registry/package metadata 分发校验，不写入 `catalog-manifest.json`。
5. 依赖版本约束本期只支持“最低依赖版本”，不支持完整 semver range、上界、peer、optional、dev 或跨 marketplace 依赖。
6. 父插件安装或升级时，如果依赖已安装但版本低于最低要求，CLI 自动把依赖升级纳入同一依赖图预检和同一写事务。任一目标失败时，本次写命令整体失败，不能留下部分更新。
7. 每个 `@yiliang/aw-plugins` catalog package 只包含当前快照中每个插件的一个版本；最新官方 catalog 不保留历史插件 artifact，也不在包内提供同一插件的多版本索引。Catalog manifest 必须保留轻量历史版本记录，记录已发布 catalog version、catalog 最低 CLI 版本、各插件版本、各插件最低 CLI 版本、artifact digest 和 manifest digest；运行时和发布侧只能以这份历史记录作为版本真值，不能用 npm metadata 补齐或替代。
8. 当默认 latest / beta catalog 的最低 CLI 版本高于当前 CLI 时，CLI 不能写入该不兼容 catalog；它应提示用户升级 `aw`，并根据 sidecar catalog manifest 中的历史版本记录查询仍支持当前 CLI 的最新历史 catalog package。历史记录缺失、schema 不支持、非法或不可获取时，本次 catalog 解析失败为 `catalogHistoryUnavailable`；不能改用 npm metadata 推测兼容历史版本。
9. 官方 catalog 不允许用仅 build metadata 不同的新版本替换同一插件；需要改变 artifact 身份时必须发布一个 SemVer 优先级不同的新版本。
10. `latest` catalog 代表稳定分发面：目标发布轨道为 `latest` 时，catalog 快照内所有插件 `version` 都必须是 stable SemVer；`beta` catalog 可以包含 stable 或 prerelease 插件版本。把 beta 插件转为 latest 发布时，任何 prerelease 插件都必须改用新的 stable 插件版本，不能把 prerelease 插件版本原样放进 latest。
11. Catalog 发布前必须先获取目标发布轨道最新已发布 sidecar catalog manifest 的历史版本记录，把本次准备发布的 catalog version、catalog 最低 CLI 版本、插件版本、插件最低 CLI 版本、artifact digest 和 manifest digest 追加进去，并在真正发布前校验版本递增关系。发布门禁还必须读取官方 `latest` 和 `beta` 两条可用历史记录的并集，用来校验同一官方 catalog 源内 `plugin@version` 的摘要不可变；不满足时发布失败。
12. `aw init` 本期改为远程 catalog 和 artifact cache 的预热入口，不再把 CLI 包内 embedded 插件快照同步到 `~/.aw`。

## 目标、范围与非目标

### 目标

1. CLI package version、catalog 发布版本、catalog 最低 CLI 版本、插件 manifest version、插件最低 CLI 版本、已安装插件版本和依赖最低版本统一遵守严格 SemVer 2.0.0。
2. 版本规范化只解析合法 SemVer，不自动修复或宽松接受非法输入。
3. 插件发布从 CLI npm 包发布中解耦，单个插件版本更新不要求发布新的 CLI package。
4. CLI 能先从 `@yiliang/aw-plugins-manifest` 获取 catalog 级兼容门槛、catalog 历史版本记录、插件版本、artifact 定位、integrity、插件兼容性和依赖最低版本信息，再在兼容性通过后从 `@yiliang/aw-plugins` 获取完整插件 artifact。
5. Catalog 能保存官方历史版本记录，使 CLI 和发布脚本不依赖 npm registry 的历史版本列表来判断兼容历史 catalog 和发布递增关系。
6. 本地 catalog 元数据能区分 CLI 版本、catalog 版本、catalog 来源和 artifact 内容 fingerprint。
7. CLI package 不再把 embedded catalog 或构建后插件快照作为发布内容；无网络且无与请求匹配的有效本地 catalog 缓存时，安装、升级和需要 current catalog 的发现类能力必须明确失败或展示 catalog 不可用。
8. 有效本地 catalog 缓存必须按本次 catalog 选择器匹配，不能把 `latest`、`beta` 或显式 exact catalog version 的缓存互相替代。
9. 需要 user-scope native runtime 的安装、升级、重装或 native repair，必须把本次选中的 current catalog materialize 成可校验的 active local marketplace/runtime view；native 平台只能消费这份 active view，不能直接把任意 catalog cache entry 当成当前 runtime。
10. `aw init`、`aw install`、`aw upgrade`、`aw upgrade --all`、`aw uninstall`、`aw status`、`aw config`、`aw diagnose`、`aw cleanup`、`repair`、`reinstall`、主控制台、发现类页面和 TUI 使用同一套 current catalog 解析结果，只是不同入口对 catalog unavailable 的可继续范围不同。
11. 用户可见 `可升级` 只表示 current catalog 中的插件版本高于已安装版本。
12. 默认 channel 存在更新但最新 catalog 要求更高 CLI 时，不能显示成插件可升级，必须展示为 catalog 更新被当前 CLI 版本阻止，并提示升级 `aw`。
13. Catalog manifest 和插件 manifest 支持声明最低 CLI 版本，发布侧和运行时都要校验；插件最低 CLI 版本不能高于 catalog 级最低 CLI 版本。
14. 插件 manifest 的 `dependencies.plugins[]` 支持声明依赖插件的最低版本。
15. 父插件安装或升级时，依赖缺失或依赖版本过低都在写入前统一解析，并自动安装或升级到 current catalog 中满足最低版本的插件版本。
16. 状态、JSON 和 TUI 能展示依赖版本比较结果，包括已安装依赖版本、最低要求、current catalog 候选版本和是否需要依赖升级。
17. 插件 artifact 以 `name@version` 为不可变身份；同一插件版本不能被静默替换成不同内容。
18. `@yiliang/aw-plugins` 发布、打包和 catalog 生成阶段必须阻断非法版本、缺失兼容性声明、插件最低 CLI 版本高于 catalog 门槛、无法解析的依赖最低版本、artifact integrity 不一致和历史版本记录递增关系破坏。
19. 发布脚本必须拆分 CLI 发布和 catalog 发布，并提供显式组合发布入口；组合发布默认先发布 CLI，再发布 `@yiliang/aw-plugins`。
20. 插件作者工具、manifest 参考文档、公开安装文档、安装技术细节文档、测试指南和测试夹具必须随新版本合同同步更新。
21. 成功安装、升级，或通过 current catalog 成功重建本地 artifact 的 repair，必须在提交表示成功的 install record 前持久化可校验 historical runtime / snapshot；后续 catalog cache 重建、轮转或清理不能删除仍被已安装位置引用的 historical runtime。
22. 既有用户机器上的 legacy install record、本地 marketplace config 和本地 cache 必须有运行时解释规则，不能因为字段缺失或旧 schema 让状态命令崩溃或退回字符串比较。

### 范围

- 定义远程 catalog 作为插件独立更新来源后的用户可见版本合同。
- 定义 CLI、catalog、插件和已安装记录之间的版本身份边界。
- 定义 catalog 级最低 CLI 兼容门槛、插件最低 CLI 兼容版本的 manifest 合同、发布门禁和运行时行为。
- 定义 catalog 历史版本记录的内容、递增规则、发布前校验和运行时历史兼容 catalog 查询边界。
- 定义插件依赖最低版本的 manifest 合同、解析规则、写命令行为和状态展示。
- 定义 current catalog 选择、sidecar catalog manifest 获取、完整 npm catalog 包获取、本地缓存和远程刷新在需求层面的行为边界。
- 定义 current catalog materialize 到 active local marketplace/runtime view 的合同，确保 user-scope native runtime 消费的就是本次选中的 catalog snapshot。
- 定义 `config`、`diagnose`、`cleanup`、`uninstall`、`repair`、`reinstall`、状态查看、主控制台和发现类入口消费 current catalog 时的降级边界。
- 定义升级状态、异常状态、CLI 输出、JSON 和 TUI 展示需要表达的版本信息。
- 定义移除 embedded catalog 后 `aw init`、`uninstall`、`repair`、`reinstall`、主控制台和发现类入口的用户可见行为边界。
- 定义 legacy install record、旧本地 catalog config 和旧缓存的运行时兼容合同。
- 纳入 `.agents/skills/create-agent-workflows-plugin/`、`docs/plugin-authoring.md`、`docs/plugin-installation.md`、`docs/plugin-installation-technical-details.md`、`docs/testing.md` 和架构文档的维护边界。

### 非目标

- 不在本 Spec 中写具体实现阶段、测试文件清单、迁移脚本或代码结构。
- 不设计第三方 marketplace、多远程源优先级、信任根管理、签名体系或账号鉴权。本期只要求一个官方 npm catalog 包 `@yiliang/aw-plugins`。
- 不实现完整 semver range 依赖解析。依赖只支持最低版本，不支持上界、`^`、`~`、比较器组合、optional、peer、dev 或跨 marketplace 依赖。
- 不设计 CLI 自更新机制。Catalog 更新被当前 CLI 版本阻止时，可以提示用户升级 CLI，但 `aw` 不负责自动升级自己。
- 不支持同一 plugin/location 同时安装多个版本。
- 不在最新 catalog 内保留同一插件的多版本 artifact 或可安装多版本索引。旧 CLI 兼容通过 catalog 历史版本记录定位历史 `@yiliang/aw-plugins` package version，再下载对应历史包；latest catalog 只保存历史元数据，不保存历史 artifact。
- 不支持在一个对当前 CLI 不兼容的新 catalog 内按插件过滤可用项。即使其中部分插件本身仍可能兼容旧 CLI，本期也整体回退到历史兼容 catalog。
- 不设计多维护者同时发布同一个 catalog channel 的竞态控制、分布式锁或自动冲突合并。官方发布流程可以通过串行发布控制并发；发布前只需要校验当时获取到的最新历史版本记录。
- 不把 `aw status` 或 TUI 状态查看变成自动插件升级入口。状态可以刷新 catalog 和展示结果，但不能隐式修改已安装插件。
- 不把同版本 artifact 内容变化解释成插件升级。同名同版本不同 digest 是发布一致性或 catalog integrity 问题。
- 不重新设计 scope、platform、SkillTrigger、配置分层或动态 artifact 机制；只在版本合同需要时补充它们的版本输入。

## 术语与状态模型

### CLI 版本

CLI 版本指 `@yiliang/aw` 发布包的 package version，当前源头是 `packages/cli/package.json`。如果 release 流程同步根目录 `package.json`，两个 package version 必须同时满足严格 SemVer 2.0.0。

CLI 版本表达运行时能力边界。Catalog 能否被当前 CLI 使用，先由 catalog manifest 的最低 CLI 版本声明和当前 CLI 版本比较决定；插件能否进入安装或升级流程，还要满足插件 manifest 的最低 CLI 版本声明。官方发布门禁必须保证包内所有插件的最低 CLI 版本都不高于 catalog 级最低 CLI 版本。

### 插件版本

插件版本指源码 manifest `.agents-plugin/plugin.json` 中的 `version`。每个发布到远程 catalog 的插件 artifact 必须保留同一个 manifest version。

`plugin name + plugin version` 是远程 artifact 的不可变身份。同一 catalog 源内，已经发布的 `name@version` 不能指向不同 digest、不同 manifest 或不同 runtime 内容。需要改变内容时必须发布新版本。

官方 catalog 还必须把“同一插件的 SemVer 优先级”作为发布唯一性边界。`1.2.3+build.1` 和 `1.2.3+build.2` 虽然是不同字符串身份，但 SemVer 优先级相同，不能同时出现在同一个官方 catalog，也不能在后续官方 catalog 版本中作为同一插件的新发布替换彼此。确实需要改变内容时，应发布 `1.2.4` 或 `1.2.4-beta.1` 这类优先级不同且符合 SemVer 的版本，不能只改 build metadata。

### Catalog 版本

Catalog 版本指 `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins` 共享的 npm package version。它描述“插件索引和全部构建后插件 artifact 这一批数据”的版本，不等于 CLI 版本，也不等于任一插件版本。Catalog 可以额外保存 revision、发布时间或内容 digest 作为不可变构建身份，但这些辅助字段不能替代 catalog version。

每个 catalog version 必须在 `@yiliang/aw-plugins-manifest` package metadata、`@yiliang/aw-plugins` package metadata 和 catalog manifest 中声明相同的 `compatibility.aw.minVersion`。该字段是整个 catalog package 的最低可用 CLI 版本，也是 CLI 是否能把该 catalog 写入本地 cache 的第一层门槛。包内任一插件 manifest 的 `compatibility.aw.minVersion` 都不能高于 catalog 级 `compatibility.aw.minVersion`；运行时遇到该约束被破坏时，必须把该 catalog 视为不一致，而不是先接受 catalog 再在插件安装阶段失败。

本期接受 catalog 级 `compatibility.aw.minVersion` 作为整包兼容门槛。换句话说，CLI 只会在 catalog package 这个粒度上选择 current catalog；不会在一个 catalog 级最低 CLI 版本过高的新 catalog 内筛出“单个插件仍兼容当前 CLI”的子集继续使用。这样可以保持 catalog 快照、依赖解析和 artifact integrity 的边界简单稳定，代价是旧 CLI 可能只能看到历史兼容 catalog 中的插件版本。

本地 catalog 元数据必须至少能表达这些语义：

- 当前 catalog 来源：remote npm packages 或 cache fallback。
- 当前 catalog 发布身份：catalog version，以及可选的 catalog revision。
- 本次缓存写入对应的 catalog 选择器：默认 channel、显式 dist-tag 或显式 exact catalog version。
- 缓存身份：至少能区分 catalog channel 和 catalog version，避免 `latest`、`beta` 或显式版本互相覆盖。
- catalog 级最低 CLI 版本。
- 写入或刷新该 catalog 的 CLI 版本。
- catalog 对应的 artifact integrity 信息。

落地时可以适配现有 config 字段，但这些语义不能继续合并成一个 `sourceVersion`。远程 catalog 开启后，用 CLI package version 判断 catalog 是否新鲜是不充分的。

### Catalog cache 与 active local marketplace

本地 catalog cache 和 active local marketplace/runtime view 是两个不同概念：

- `catalog cache` 可以保存多个 catalog entry，用于索引、artifact 缓存和离线 fallback。它必须按 selector、channel、catalog version、schema、integrity 和最低 CLI 版本隔离，允许 `latest`、`beta` 和显式 exact catalog version 并存。
- `active local marketplace/runtime view` 是 user-scope native 安装或 native repair 前 materialize 出来的当前视图，落在 canonical `AW_HOME` / `~/.aw` marketplace 边界内，供 Claude Code native plugin runtime 和 Codex user scope `codex plugin marketplace add <canonical ~/.aw>` 消费。它不是多版本索引，也不能被任意 cache entry 直接替代。

凡是本次命令会调用 user-scope native 平台安装、升级、重装或需要 native marketplace 的 repair，CLI 必须先把已经解析出的 current catalog snapshot materialize 成 active view，并在 active view 元数据中记录请求 selector、实际 channel、catalog version、catalog 最低 CLI 版本、sidecar manifest identity、artifact digest / manifest digest、写入 CLI version 和 materializedAt。平台 adapter 在调用原生安装前必须校验 active view 身份与本次 current catalog 一致；不一致、缺失或校验失败时，必须先重建 active view 或让本次命令失败，不能让 native 平台消费上一轮 selector 的残留视图。

切换 `latest` / `beta` / 显式 exact catalog version 时，active view 必须按本次选中的 catalog identity 原子替换或重建。`aw init` 只预热 catalog/cache，不因预热某个 selector 就把它写活成 native runtime；只有真正需要 user-scope native runtime 的写命令或 native repair 才 materialize active view。Codex project scope 和其它 repo-visible artifact 路径只消费 current catalog 与 install record 证据，不注册或复用 user-scope active marketplace。

Active view 不能作为 catalog 历史查询、版本递增校验或 artifact 不可变判断的真值；这些判断仍以 sidecar catalog manifest、历史版本记录和 artifact digest 为准。Catalog cache cleanup 也不能把 active view 当成 historical runtime 的替代来源，成功写入的 install record 必须继续绑定独立的 historical runtime / snapshot。

### Catalog 发布轨道

Catalog 发布轨道指 `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins` 的官方 npm dist-tag 语义，本期只包含 `latest` 和 `beta`。发布轨道必须是 catalog package 内部可校验的真值，而不是发布后可随意移动的外部标签：

- `latest` 只能发布 stable SemVer catalog version，例如 `1.2.3`。
- `beta` 只能发布 prerelease SemVer catalog version，例如 `1.2.3-beta.1`。
- `latest` catalog 快照内每个插件 version 也必须是 stable SemVer；prerelease 插件 version 只能出现在 `beta` catalog。
- `beta` catalog 可以包含 stable 或 prerelease 插件 version；stable 插件 version 出现在 beta 快照中，不影响后续在 latest 快照中复用同一 `plugin@version` 和摘要。
- 同一个 catalog version 只能属于一个发布轨道；`history.channel` 必须和两个 catalog package 的发布轨道一致。
- 已发布的同一个 catalog package version 不能后来从 `beta` 改挂到 `latest`，也不能从 `latest` 改挂到 `beta`。如果要把某次 beta 内容作为稳定版发布，必须发布新的 stable catalog version；只有插件 version 都已是 stable 且 artifact 未变化时，才可以保留同一批插件 version 和 digest。若 beta 快照中存在 prerelease 插件 version，进入 latest 前必须发布对应 stable 插件 version，并重新生成 manifest、artifact digest、manifest digest 和历史记录。
- 历史记录递增校验按发布轨道分别执行。运行时通过历史记录查询兼容 catalog 时，只能在当前默认轨道或用户显式指定的 dist-tag 轨道内查询，不能跨轨道寻找历史兼容版本。`plugin@version` 不可变性不是运行时回退规则，而是官方 catalog 源级发布门禁；发布时必须合并校验 `latest` 和 `beta` 两条历史记录中的已发布插件身份。

### Catalog 历史版本记录

Catalog 历史版本记录是随 `@yiliang/aw-plugins-manifest` sidecar manifest 发布的轻量索引，并在完整 `@yiliang/aw-plugins` tarball 内保留同一份 manifest，用来保存官方已经发布过的 catalog 快照版本，以及这些快照中的插件版本和不可变摘要。它不是可安装插件索引，也不包含历史 artifact；CLI 真正安装或升级时，仍只能使用本次 current catalog package 自己携带的单版本快照。

每个 catalog version 的 catalog manifest 必须带有历史版本记录。历史版本记录只能以 sidecar catalog manifest 中的字段为准；package metadata 不能作为历史兼容查询、发布递增校验或插件版本判断的依据。该记录至少包含：

- 历史记录 schema version。
- channel 或等价发布轨道标识。
- 每次 catalog 发布的 catalog version。
- 每次 catalog 发布的 catalog 级 `compatibility.aw.minVersion`。
- 每次 catalog 发布时快照内每个插件的插件名、插件 version、插件 `compatibility.aw.minVersion`、`artifactDigest` 和 `manifestDigest`。
- 可选的 catalog revision、发布时间或发布来源诊断信息。

历史记录必须按同一发布轨道内的 catalog version SemVer 优先级严格递增。每次 catalog 发布前，发布脚本必须先获取目标发布轨道最新已发布 sidecar catalog manifest 中的历史版本记录，再把本次准备发布的 catalog version、catalog 最低 CLI 版本、插件版本、插件最低 CLI 版本、artifact digest 和 manifest digest 追加为新记录，之后再生成 sidecar 和完整 catalog tarball。除明确的首次发布外，发布脚本不能在无法获取或无法校验目标发布轨道最新历史记录时自行合成一份历史记录继续发布。

发布门禁还必须获取官方 `latest` 和 `beta` 两条可用发布轨道的最新 sidecar catalog manifest，并把其中的历史版本记录合并成只读校验输入，用于判断同一官方 catalog 源内 `plugin@version` 的 artifact digest / manifest digest 是否不可变，以及同一插件是否使用了 SemVer 优先级相同但 build metadata 不同的替代版本。某条轨道尚未发布时可以视为空历史；只要该轨道已经存在，发布脚本就不能在无法获取或无法校验其历史记录时跳过全局不可变校验。

版本递增校验必须区分 catalog 快照和插件 artifact：

- 本次 catalog version 必须严格高于历史记录中的最高 catalog version。
- 本次 catalog version 必须符合发布轨道要求：`latest` 为 stable version，`beta` 为 prerelease version。
- 目标发布轨道为 `latest` 时，当前快照内每个插件 version 必须是 stable SemVer；目标发布轨道为 `beta` 时，插件 version 可以是 stable 或 prerelease SemVer。
- 同一插件如果在新 catalog 中仍指向同一个已发布 artifact，且 `artifactDigest` 和 `manifestDigest` 都与官方 `latest` / `beta` 历史记录并集中同一 `plugin@version` 完全一致，可以继续记录同一个插件 version。
- 同一插件只要 manifest、runtime 内容、依赖声明、最低 CLI 版本或 platform 能力发生会改变 artifact 身份的变化，就必须发布严格高于该插件在目标发布轨道历史最高版本的新插件 version；如果本次 `artifactDigest` / `manifestDigest` 与官方 `latest` / `beta` 历史记录并集中同一 `plugin@version` 不一致，则该插件 version 已不可复用，必须改用符合目标轨道递增规则的新版本。
- 同一插件不能在官方 `latest` / `beta` 历史记录并集中出现 SemVer 优先级相同但 build metadata 不同的替代版本。
- catalog 级和插件级最低 CLI 版本必须是合法 SemVer；本次 release 的 catalog 级最低 CLI 版本必须覆盖当前 catalog 快照的真实运行时要求，插件级最低 CLI 版本必须覆盖对应插件 artifact 的真实运行时要求。历史记录保留每次 release 的门槛真值，但不要求同一发布轨道内最低 CLI 版本单调不降；后续 release 因能力回退、兼容性回补或快照内容变化而降低最低 CLI 版本时，降低本身不能作为发布失败条件。

历史记录中的 `artifactDigest` 必须基于构建后插件 artifact 的规范化完整内容计算，覆盖 manifest、runtime 文件、脚本、静态资源和会随包发布的能力声明；`manifestDigest` 必须基于规范化后的插件 manifest 计算。二者是发布门禁判断同一 `plugin@version` 是否不可变的权威证据，不能降级成可选诊断字段。

运行时可以使用历史版本记录来定位“仍支持当前 CLI 的最新历史 catalog package version”。CLI 只允许把历史记录当作选择历史 package 的索引；它不能从 latest catalog 的历史记录中直接安装历史插件，也不能把历史记录中的插件版本当作 current catalog 插件版本。历史记录缺失、schema version 不受当前 CLI 支持、内容非法或无法获取时，历史兼容 catalog 查询必须失败。

### Current Catalog

Current catalog 指当前命令或 TUI 本次使用的插件索引视图。它可以来自 sidecar manifest 判定兼容后的 `@yiliang/aw-plugins` 远程刷新结果或有效本地缓存。

每个 catalog package 是一个单版本插件快照：同一个 catalog 内每个插件名最多出现一个版本。Current catalog 面向安装和升级时只能使用该快照中的插件版本，不再在同一个 latest catalog 内按当前 CLI 解析“最高兼容插件版本”。

默认 channel 的 catalog 解析流程必须先尝试最新的 `@yiliang/aw-plugins-manifest`。只有 sidecar manifest 判定目标 catalog 兼容当前 CLI 后，CLI 才能下载或继续使用同版本 `@yiliang/aw-plugins`，校验并写入本地 cache；如果最新 catalog 要求更高 CLI，CLI 不能写入该不兼容 catalog，必须提示用户升级 `aw`，并通过 catalog 历史版本记录找到仍支持当前 CLI 的最新 catalog version。找到兼容历史 catalog 时，本次 current catalog 使用该历史 catalog，并在输出、JSON 和 verbose 诊断中说明 latest catalog 被当前 CLI 版本阻止、当前 `aw` 版本过低，以及实际使用的 catalog version。目标 catalog 被当前 CLI 版本或 catalog schema 支持范围阻止时，本次解析必须记录 `latestCatalogBlocked`。后续阻断状态必须按稳定映射收敛：历史记录缺失、schema 不受支持、非法或不可获取时，需要 current catalog 的命令失败为 `catalogHistoryUnavailable`；历史记录有效且确认没有兼容当前 CLI 的历史 catalog 时，失败为 `awVersionTooLow`，该否定结论不能被本地 cache 推翻；远程不可用、远程校验失败或其它原因导致最终拿不到已经允许使用的 current catalog，且没有允许使用的匹配 cache 时，失败为 `catalogUnavailable`。不能用本地 cache 或 npm metadata 绕过历史记录错误或历史记录给出的否定结论。Cache fallback 只用于已经解析出允许使用的 catalog identity 后，远程下载、校验或刷新失败的场景；命中的 cache 仍必须与本次 selector、channel / exact catalog version、schema、integrity 和最低 CLI 版本匹配。

本 Spec 把本次请求 catalog 的输入称为 catalog 选择器。选择器只能是默认 channel、显式 dist-tag 或显式 exact catalog version 三类之一。有效本地 cache fallback 必须同时满足 integrity 校验、当前 CLI 兼容性和选择器匹配：

- 默认 channel 使用本 CLI 类型对应的 `latest` 或 `beta` 缓存，只能命中同一 channel 下最后一次成功写入且兼容当前 CLI 的 catalog；稳定版 CLI 离线时不能使用上一次 beta 预热留下的缓存。
- 显式 dist-tag 只允许命中同一 dist-tag / channel 下最后一次成功写入且兼容当前 CLI 的 catalog；它不改变持久默认 channel，也不能借用另一个 channel 的缓存。
- 显式 exact catalog version 只允许命中同一 catalog version 的缓存；该缓存还必须通过 manifest channel、catalog version、artifact digest、schema version 和 `minAwVersion <= current CLI` 校验。exact version 不做历史回退，也不能退到任意旧缓存。
- 旧 `sourceVersion + bundleFingerprint` 单槽本地 marketplace 元数据不能被解释成有效远程 catalog cache。远程 catalog 模型启用后，cache 可以用任意物理布局实现，但需求层面必须允许不同 channel 和不同 catalog version 并存，并且每次 fallback 都能在 JSON / verbose 诊断中说明命中的 selector、channel、catalog version、minAwVersion 和 fallback reason。

### 版本规范化

所有参与比较的版本字段都必须先通过严格 SemVer 2.0.0 解析：

- CLI package version。
- catalog version。
- catalog 最低 CLI 版本。
- catalog 历史版本记录中的 catalog version 和 catalog 最低 CLI 版本。
- 插件 manifest version。
- 插件最低 CLI 版本。
- catalog 历史版本记录中的插件 version 和插件最低 CLI 版本。
- 依赖最低插件版本。
- 已安装插件 record 中的 `resolvedVersion` 或等价 source version。
- dependency edge 或依赖状态中记录的已解析依赖版本。

允许示例：

- `1.2.3`
- `1.2.3-beta.1`
- `1.2.3+build.5`
- `1.2.3-beta.1+build.5`

不允许示例：

- `v1.2.3`
- `1.2`
- `1.2.3.4`
- `latest`
- `^1.2.3`

比较规则遵守 SemVer 2.0.0：

- prerelease 低于对应 stable 版本。
- build metadata 不影响优先级。
- 版本相等但 build metadata 不同，不能被解释为可升级。
- 非法版本不能降级成字符串比较，也不能自动清洗后继续发布或运行。

## 远程 Catalog npm 包需求

### Catalog 包发布

官方远程 catalog 必须拆成两个独立 npm 包发布：`@yiliang/aw-plugins-manifest` 是轻量 manifest sidecar package，负责提供兼容性判断、历史版本记录和 artifact integrity 真值；`@yiliang/aw-plugins` 是完整 artifact catalog package，负责提供插件 artifact。`@yiliang/aw-plugins` 仍是 CLI 获取插件 artifact 的唯一官方远程来源。

发布合同：

- `@yiliang/aw-plugins-manifest` package version 和 `@yiliang/aw-plugins` package version 都等于 catalog version，必须是严格 SemVer 2.0.0。
- `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins` 使用和 `@yiliang/aw` 相同的官方 npm registry 约定，并支持 `beta` 和 `latest` dist-tag。
- `latest` dist-tag 只能发布 stable catalog version；`beta` dist-tag 只能发布 prerelease catalog version。
- 同一个 catalog version 只能发布到一个正式 dist-tag。发布成功状态下，两个 catalog package 的正式 dist-tag 必须一致；发布入口不能在两包正式 dist-tag 不一致时报告成功。发布完成后不能通过移动 dist-tag 改变该 version 的 `history.channel` 语义。
- `@yiliang/aw-plugins` 和 `@yiliang/aw` 独立发布；插件或 catalog 更新不要求重新发布 CLI。
- `@yiliang/aw-plugins-manifest` 每个版本只包含固定路径的 `catalog-manifest.json` 和必要 package metadata，不包含插件 artifact、runtime 快照或历史 artifact。
- 每个 `@yiliang/aw-plugins` 版本都是完整快照，不是增量包。包内必须包含该 catalog entry 引用的全部构建后插件 artifact。
- 每个 catalog version 必须在 sidecar manifest、完整 catalog tarball 内 manifest、两个 package 的 metadata 中声明相同的 catalog 级 `compatibility.aw.minVersion`。
- 每个 catalog version 的 sidecar manifest 和完整 catalog tarball 内 manifest 必须保存官方 catalog 历史版本记录，历史记录至少覆盖已发布 catalog version、catalog 最低 CLI 版本、各插件 version、各插件最低 CLI 版本、各插件 artifact digest 和 manifest digest。
- 最新官方 catalog 只包含当前官方最新插件快照；同一 catalog 内每个插件名最多出现一个版本，不保留历史插件 artifact，也不提供同一插件的多版本索引。
- 同一个 `@yiliang/aw-plugins` 版本发布后不可变，不能通过覆盖同版本 npm 包来修复 catalog 或插件内容。
- 同一官方 catalog 源内，已经发布过的 `plugin name + plugin version` 不能在后续 catalog 版本里指向不同 digest、不同 manifest 或不同 runtime 内容；这个约束跨 `latest` 和 `beta` 生效，不随发布轨道拆分。
- 同一官方 catalog 源内，同一插件不能用 SemVer 优先级相同但 build metadata 不同的版本作为新发布替代；只改 build metadata 不构成可发布的新插件版本。
- Catalog 发布前必须先读取目标发布轨道最新已发布 sidecar catalog manifest 中的历史版本记录，追加本次发布记录，并校验 catalog version 严格递增、插件版本递增关系、最低 CLI 版本合法且覆盖当前快照需求。发布门禁还必须读取官方 `latest` 和 `beta` 两条可用历史记录的并集，校验跨轨道 `plugin@version` 摘要不可变和 build metadata 优先级唯一性；校验失败时不能打包或发布。
- Catalog 发布采用完整 artifact catalog package 先就绪、sidecar manifest package 最后对外切换的合同。`@yiliang/aw-plugins` 必须先按本次 catalog version 发布或确认已存在，且通过 registry metadata、npm integrity、包内 manifest、artifact digest 和本次 staging manifest 的一致性校验；只有这些校验通过后，才能发布或提升 `@yiliang/aw-plugins-manifest` 到正式 `latest` / `beta`。
- 正式 `latest` / `beta` 的用户可见切换点是 sidecar manifest package。发布过程中不能先让正式 sidecar 指向一个尚未完整可取、尚未校验的 full catalog version。若 full package 已成功而 sidecar 发布、校验或正式 dist-tag 设置失败，latest / beta sidecar 仍必须停留在上一成功 catalog version，发布入口可以用同一 catalog version 进入恢复重跑。
- 恢复重跑同一 catalog version 时，发布入口必须把已经存在的一侧视为待校验事实，而不是重新覆盖：只有已发布 package 的 package metadata、catalog manifest、history release、artifact digest 和 registry integrity 都与本次生成产物一致时，才能跳过该侧并补齐另一侧或正式 dist-tag；任何不一致都必须失败并要求人工处理或发布更高 catalog version。
- CLI npm 包不再发布 `plugins-dist/` 或等价的完整插件快照；`@yiliang/aw` 的 npm package 只发布 CLI 运行时代码和必要的命令资源。
- 构建流程可以生成临时 staging 产物供 `@yiliang/aw-plugins` 打包使用，但这些产物不能作为 embedded catalog 随 CLI package 发布。

远程 catalog 的存在不能要求用户先升级 CLI 才能看到兼容的插件新版本。只要当前 CLI 满足目标 catalog 的最低 CLI 版本，用户就应该能通过 catalog 刷新和插件升级拿到该 catalog 中的插件版本。最新 catalog 要求更高 CLI，或最新 catalog 的历史记录 schema 已超出当前 CLI 支持范围时，CLI 应提醒用户升级 `aw`，并根据 sidecar manifest 中的 catalog 历史版本记录选择仍兼容当前 CLI 的历史 catalog；历史记录不可用或查不到兼容历史 catalog 时，不能把 latest catalog 当作可用 catalog，也不能改用 npm metadata 猜测。

### Catalog 获取

CLI 必须能从 npm registry 获取 `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins`。前者是轻量 catalog manifest sidecar package，后者是完整 artifact catalog package。两者的 package version 都等于 catalog version，发布轨道也必须一致：

- 稳定版 CLI 默认先获取 `@yiliang/aw-plugins-manifest@latest`。
- prerelease / beta CLI 默认先获取 `@yiliang/aw-plugins-manifest@beta`。
- 用户或测试流程可以通过命令级参数显式指定 catalog dist-tag 或 catalog version；dist-tag 和 catalog version 互斥，且只影响当前命令或本次 `aw init` 预热，不写入持久默认 channel。显式指定时必须体现在 JSON 和 verbose 诊断里。
- 所有脚本化 current-catalog 消费入口必须暴露同一组 selector 参数：`--catalog-channel <dist-tag>` 用于显式 dist-tag，`--catalog-version <semver>` 用于显式 exact catalog version；两者互斥。`aw init --channel <dist-tag>` 可以作为 `--catalog-channel` 的兼容别名，但内部语义仍必须落到同一 catalog 选择器。需要覆盖的入口至少包括 `aw init`、`aw install`、`aw upgrade`、`aw upgrade --all`、`aw reinstall`、`aw status`，以及在未安装或未消费 store 上需要 current catalog schema 的 `aw config list/get/set/unset`。
- 主控制台、TUI 状态页、发现页、可安装插件列表和可安装插件详情如果会解析 current catalog，也必须接收或继承同一 catalog 选择器。对 `aw status`、TUI 状态页这类可在无 current catalog 时继续展示本地状态的入口，selector 只影响可升级判断、候选版本、依赖候选和发现内容等 current-catalog 证据；不能因为传入 selector 而隐式修改安装状态。
- 兼容历史 catalog 查询只适用于默认 channel 或显式 dist-tag。用户显式指定精确 catalog version 时，CLI 只校验该版本；该版本不兼容当前 CLI 时，显式 catalog 解析失败，不做历史回退，任何依赖 current catalog 的动作都必须失败。
- CLI 可以用 npm package metadata 解析 dist-tag、tarball URL 和 npm integrity 这类分发信息；sidecar catalog manifest 负责提供目标版本的 catalog 级最低 CLI 版本、catalog version、发布轨道、历史版本记录、完整 catalog package identity 和 artifact digest。完整 npm tarball integrity 只来自 registry/package metadata，用于校验下载到的 package bytes，不能写入 `catalog-manifest.json`，也不能替代 sidecar manifest 参与兼容判断、历史查询或插件版本判断。
- CLI 必须先下载并校验 `@yiliang/aw-plugins-manifest` 的 npm tarball integrity，再读取其中固定路径的 `catalog-manifest.json`。该 sidecar tarball 只能包含 catalog manifest 和必要 package metadata，不能包含插件 artifact 或完整 runtime 快照。
- 只有 sidecar catalog manifest 表明目标 catalog 兼容当前 CLI 时，CLI 才能下载或继续使用对应版本的完整 `@yiliang/aw-plugins` tarball。下载后必须用 registry/package metadata 校验 npm tarball integrity，确认完整 tarball 内 catalog manifest 与 sidecar manifest byte-for-byte 一致，并校验每个插件 artifact digest，再写入本地 catalog 缓存。
- 默认 channel 或显式 dist-tag 的目标 catalog 不兼容当前 CLI 时，CLI 必须使用目标 sidecar catalog manifest 的历史版本记录，查询同一 channel / dist-tag 语义下仍支持当前 CLI 的最新历史 catalog package。找到候选历史版本后，CLI 还必须获取同版本 `@yiliang/aw-plugins-manifest`，校验它的 sidecar manifest 与目标历史记录一致且兼容当前 CLI，然后才能下载对应版本的完整 `@yiliang/aw-plugins` tarball。
- CLI 不能为了读取 catalog manifest、最低 CLI 版本或历史版本记录而先下载完整 `@yiliang/aw-plugins` tarball。sidecar manifest 缺失、无法下载、npm integrity 失败、schema 不受支持、内容非法或与完整 catalog package 不一致时，必须按 catalog manifest / history unavailable 或 integrity 错误处理；不能改用完整 catalog tarball、npm metadata 或 registry 版本列表补齐。
- 如果目标 catalog 的历史版本记录缺失、schema 不受支持、非法或无法获取，兼容历史 catalog 查询必须失败。该查询能成功时，后续下载、校验和缓存写入只针对找到的兼容 catalog；查询失败时不能写入不兼容 catalog，也不能改用 npm metadata 或 registry 版本列表推测兼容历史版本。
- CLI 不能从 `@yiliang/aw` package 内部读取 embedded catalog 或 embedded 插件 artifact。
- 当前机器已有与本次 catalog 选择器匹配的有效本地缓存时，CLI 只能在目标 catalog 本身兼容但远程不可用 / 远程校验失败，或已经通过有效历史记录解析出兼容历史 catalog identity 但后续下载 / 校验失败时，使用缓存作为 current catalog。输出必须说明来源是 cache fallback，以及缓存对应的 selector、catalog version、channel 和最低 CLI 版本。目标 catalog 的历史记录缺失、schema 不受支持、非法或无法获取，或历史记录有效且确认没有兼容当前 CLI 的历史 catalog 时，都不属于可 cache fallback 的情况。
- 如果没有与本次选择器匹配的有效缓存，且远程 npm catalog 无法获取、无法通过校验，或已经解析出的兼容 catalog 无法取得，需要 current catalog 的命令必须失败或展示 catalog unavailable；如果历史记录确认不存在兼容 catalog，则失败为 `awVersionTooLow`。任何场景都不能回退到 CLI 包内置插件快照。

### Catalog 内容

`@yiliang/aw-plugins-manifest` 的 `catalog-manifest.json` 是运行时读取 catalog manifest 的前置真值；完整 `@yiliang/aw-plugins` tarball 内也必须包含同一份 manifest。两处 manifest 必须 byte-for-byte 相同；`catalog-manifest.json` 不声明自身 digest，也不声明任一 npm tarball 的最终 integrity。不一致时按 catalog integrity 错误处理。

`catalog-manifest.json` 至少需要表达这些 catalog 级信息；package metadata 必须承载 npm 分发需要的 dist-tag、tarball URL、integrity 等信息，但不能作为 catalog 历史版本真值：

- manifest schema version。
- catalog version。
- catalog channel / 发布轨道。
- catalog revision、发布时间或内容 digest 这类辅助诊断信息。
- catalog 级最低 CLI 版本，即 `compatibility.aw.minVersion`。
- catalog 历史版本记录，即已发布 catalog version、catalog 最低 CLI 版本、插件 version、插件最低 CLI 版本、artifact digest 和 manifest digest 的轻量索引。
- sidecar package identity，即 `@yiliang/aw-plugins-manifest` 的 package name、version 和 channel。
- 完整 catalog package identity，即 `@yiliang/aw-plugins` 的 package name、version、channel 和 manifest 固定路径。完整 package 的 npm tarball integrity 必须从 registry/package metadata 校验，不能作为 manifest 字段。

`catalog-manifest.json` 对快照内每个插件版本至少需要表达这些信息：

- 插件名。
- 插件版本。
- 插件描述和 marketplace 展示信息。
- 支持平台和安装能力摘要。
- 插件 manifest 最低 CLI 版本，且不能高于 catalog 级最低 CLI 版本。
- 依赖插件及其最低版本要求。
- artifact 下载地址或等价定位信息。
- artifact integrity digest。
- artifact 大小、发布时间或 revision 这类辅助诊断信息。

因为完整 catalog 包已经包含全部构建后插件 artifact，artifact 定位可以是 `@yiliang/aw-plugins` tarball 内相对路径或等价的稳定定位信息。无论使用哪种布局，catalog entry、完整包内 artifact 和 digest 必须能一一对应，不能要求 CLI 再从 CLI package 或源码目录补齐插件内容。

Catalog manifest 中每个插件 entry 的稳定身份应是 `plugin name + plugin version`。同一个 catalog package 内，插件名必须唯一；如果同一个插件名在同一个 catalog 中出现多个版本，运行时应视为 catalog 不一致，发布门禁必须提前阻断。

历史版本记录应和当前 catalog 快照分开表达。当前快照的插件 entries 决定本次可安装、可升级和依赖解析的候选版本；历史版本记录只用于发布校验、兼容历史 catalog package 定位和诊断展示。历史记录中出现的旧插件版本不能被当前 catalog 直接安装，除非 CLI 已经下载并校验了对应历史 catalog package，并把它作为本次 current catalog。

依赖目标只在同一个 current catalog 快照内解析。如果父插件版本需要某个依赖最低版本，current catalog 中对应依赖插件的唯一版本必须满足该最低版本；否则父插件安装或升级在写入前失败。官方 catalog 发布门禁应保证同一快照内的依赖最低版本可以被快照内插件满足。

### Catalog 刷新与缓存

所有需要 current catalog 的入口都必须使用同一套 catalog 解析流程。该流程要先尝试默认或显式指定的远程 catalog，再判断 catalog 级最低 CLI 版本是否兼容当前 CLI；默认 channel 或显式 dist-tag 的最新 catalog 不兼容时，再优先按 catalog 历史版本记录查询历史兼容 catalog；只有已经解析出允许使用的 catalog identity 后，才可以根据与本次选择器匹配的本地有效缓存决定远程失败时是否可继续。

刷新远程 catalog 只更新本地 catalog 缓存和 artifact 缓存，不等于升级已安装插件。状态查看、首页打开或只读诊断不能因为 catalog 刷新而改写 install record、平台 runtime、project artifact identity 或 dynamic diagnostic cache。

本地 catalog cache 不能再是单槽“最后一次初始化”模型。`aw init --channel beta` 或显式 exact version 预热可以写入自己的 cache entry，但不能覆盖或污染默认 `latest` 路径；默认 channel、显式 dist-tag 和显式 exact version 的 fallback 命中范围必须按上文选择器规则判断。Cache cleanup 只能删除没有被选择器索引引用、没有被已安装位置引用、且不影响可验证 historical runtime 的 catalog / artifact 缓存。

命令层不能把显式 selector 只实现成 `aw init` 的预热能力。任何入口只要在本次执行中需要 current catalog 做安装、升级、重装、发现、可升级判断、依赖候选解析，或未安装配置 schema 解析，就必须把同一 catalog 选择器传入统一解析流程。未传 selector 时使用 CLI 类型决定的默认 channel；传入 selector 时，本次命令、JSON、verbose 诊断和 TUI 状态都必须能看见请求值和实际命中的 catalog identity。

命令层还必须把 current catalog 解析结果传给 active local marketplace materialize 流程。需要 user-scope native runtime 的安装、升级、重装或 native repair，在调用 Claude / Codex 原生能力前必须确认 active view 已经对应本次命中的 catalog identity；如果本次命令使用了 cache fallback，也只能 materialize 该 fallback 命中的 catalog snapshot，不能沿用另一个 selector 或旧 catalog version 的 active view。

远程不可用时：

- 如果存在通过校验且与本次选择器匹配的本地远程 catalog 缓存，可以继续使用缓存，并在用户输出中说明 catalog 来源、selector、catalog version、最低 CLI 版本和可能不是最新。
- 如果没有有效远程缓存，需要 current catalog 的命令不能继续安装、升级或展示可安装插件列表；只读状态可以展示已安装记录，但必须把 current catalog 标记为 unavailable。

### Current Catalog 消费矩阵

所有入口都必须调用同一套 current catalog 解析流程，并把解析结果作为结构化证据传给命令层。不同入口只能决定“没有 current catalog 时还能做多少事”，不能自行发明 embedded fallback 或跳过 catalog 历史记录规则。

统一解析结果在 JSON、verbose 诊断和 TUI 数据模型中必须能映射到稳定机器状态。字段名可以随实现方案落在各自 schema 内，但语义至少要覆盖，且不能把远程不可用、历史记录不可用和当前 CLI 版本过低互相替代：

- `catalogUnavailable`：目标远程 catalog 无法获取、远程校验 / integrity / manifest 一致性失败且没有按选择器允许使用的有效 cache fallback，或已经解析出的兼容 catalog 无法取得，并且在不属于下列专门状态的情况下最终拿不到 current catalog。
- `awVersionTooLow`：目标 catalog 的最低 `aw` 版本高于当前 CLI，历史记录有效且确认不存在兼容当前 CLI 的历史 catalog。该状态是历史记录给出的终止结论，不能用本地 cache fallback 改写。
- `latestCatalogBlocked`：latest / beta 目标 catalog 存在，但被当前 CLI 版本或 catalog schema 支持范围阻止。该状态可以作为历史兼容 catalog 或允许的 cache fallback 成功时的证据，也可以和后续阻断状态一起暴露，但不能替代终止原因。
- `catalogHistoryUnavailable`：需要用历史记录定位兼容 catalog，但历史记录缺失、非法、不可获取或 schema 不受支持。该状态必须作为历史查询失败的终止原因，不能降级成 `catalogUnavailable` 或 `awVersionTooLow`。
- `explicitCatalogIncompatible`：用户显式指定的精确 catalog version 不兼容当前 CLI；该场景不做历史回退。
- `cacheFallback`：本次在已经解析出允许使用的 catalog identity 后，使用了与请求选择器匹配的有效本地 cache，而不是刚下载的远程 catalog。
- `historicalRuntimeUnavailable`：已安装位置需要 historical lifecycle runtime 才能安全撤销或修复，但该 runtime 缺失、摘要不可信或 legacy 证据不足。
- `uninstallBlocked`：卸载因依赖保护、historical runtime 不可用、native transaction marker 未收口或 ownership 证据不足而被阻断。

入口消费规则如下：

| 入口 | 是否必须拿到 current catalog | 无 current catalog 时允许继续的证据层 | 用户可见状态和 JSON 语义 |
| --- | --- | --- | --- |
| `aw init` | 是，用于预热 catalog/cache | 仅允许在 catalog 解析规则允许时使用与本次选择器匹配的有效本地 cache；不能使用 embedded bundle | 成功时 receipt 说明请求 selector、实际预热的 catalog source/version/channel/minAwVersion 和 cache fallback 身份；失败时按统一状态映射返回 `catalogUnavailable`、`awVersionTooLow`、`catalogHistoryUnavailable` 或 `explicitCatalogIncompatible`，并在适用时暴露 `latestCatalogBlocked` 证据 |
| `aw install`、`aw upgrade`、`aw upgrade --all` | 是 | 只能使用已解析出的兼容远程 catalog、历史兼容 catalog 或允许的 cache fallback | 写入前失败，不修改 install record、平台 runtime 或 dependency index；需要 user-scope native runtime 时，原生平台调用前必须 materialize 并校验 active local marketplace/runtime view；JSON receipt 或错误 payload 必须暴露阻断 code |
| `aw uninstall` | 否 | install record、dependency index / incoming dependents、平台现场、project artifact identity、historical lifecycle runtime、shared runtime owner、native transaction marker、config store | 先用本地依赖图和 ownership 证据保护卸载边界；需要执行卸载 lifecycle 或撤销历史副作用时必须使用可校验 historical runtime。historical runtime 缺失、摘要不可信或 legacy 证据不足时 fail closed，返回 `historicalRuntimeUnavailable` 或 `uninstallBlocked`，提示先 `repair`；需要只清理可证明残留时转交 `cleanup`，`uninstall` 不能改用 current catalog 或 embedded bundle |
| `aw status`、主控制台首页、TUI 状态页 | 否，读取已安装状态可以继续 | install record、平台现场、project artifact identity、dynamic diagnostic cache、historical lifecycle runtime、dependency index、shared runtime owner、native transaction marker | 标记 catalog `unavailable` 或 `cacheFallback`；不能展示新的可安装版本，不能伪造 `可升级`，安装/升级/发现动作禁用 |
| 发现页、可安装插件列表、可安装插件详情 | 是 | 无 | 禁用或按统一状态映射失败；不能从历史记录或 install record 拼出可安装列表 |
| `aw config list/get/set/unset` | 视 schema 来源而定；已有安装位置优先使用 install record / historical bundle 中的 `config.schema`，未安装或显式按 current catalog 预置未消费的 config store 时才需要 current catalog | 已安装位置的 install record、historical runtime bundle 和 config store；预置未安装插件配置时只能使用 current catalog schema | 已安装位置的 historical schema 可用时，即使 current catalog unavailable 也可以读写；schema 缺失或损坏时失败为 `configSchemaUnavailable`；同一 config store 的多个已安装消费者 schema identity 不一致时失败为 `configSchemaConflict`；只有需要 current catalog schema 且拿不到 catalog 时才失败为 `catalogUnavailable` |
| `aw config reset` | 视目标 store 是否已被安装位置消费；已消费 store 不需要 current catalog，但必须走 installed historical refresh 合同；孤立残留 store 不需要 current catalog | 已消费路径使用 install record、historical runtime bundle、config store 和 dynamic artifact evidence；孤立残留路径只使用 config store 路径安全校验和本地 store 证据 | 已消费 store 的 reset 等价于删除该 store 中所有已写入 key，必须通过共享配置写入 helper，并在命中 `refreshKeys` 时按每个 installed consumer 的 historical runtime 刷新已安装 dynamic artifact；schema conflict 时 reset 可以作为整 store 清理动作，但不能任选一个 schema 解释输入；只有没有 installed consumer 的残留 store，才允许在用户确认后 raw 删除且不解析 schema、不安装插件、不刷新 artifact |
| `aw diagnose` | 否，current catalog 只是诊断证据层之一 | install record、平台现场、project artifact identity、dynamic diagnostic cache、historical lifecycle runtime、dependency index、shared owner、native marker、config store | 输出 catalog 证据缺失或 latest 被阻止；只读诊断不能因此改写状态，也不能展示 current catalog 才能确认的升级判断 |
| `aw cleanup` | 否，已有证据足以归类时可以继续 | install record、dependency index、平台现场、native marker、config store、historical lifecycle runtime、可定位本地残留；current catalog 只作为可选辅助证据 | 能生成计划时继续；如果目标只能靠 current catalog 才能识别，按统一状态映射阻断，或返回现有 cleanup blocking reason。不能回退 embedded bundle |
| `repair` | 视动作而定 | 修复已安装版本且 historical runtime/install record 证据可校验时可以继续 | 只重放已安装版本证据时允许；凡是需要远程 artifact、依赖解析、选择 current catalog 版本或替换版本的 repair，都必须拿到 current catalog |
| `reinstall` | 是 | 旧安装位置的 install record、平台现场、project artifact identity、historical lifecycle runtime、shared runtime owner、native transaction marker、config store 只用于安全撤销旧副作用，不能替代 current catalog | 作为“按 current catalog 重新安装”的入口，拿不到 current catalog 时写入前失败；已有安装位置需要撤销 lifecycle、dynamic artifact 或 native 副作用时，撤销阶段继承 `uninstall` 的 fail-closed 边界。historical runtime 缺失、摘要不可信或 legacy 证据不足时，本次 `reinstall` 在新安装前失败为 `historicalRuntimeUnavailable` 或对应卸载阻断状态；不使用 embedded bundle 或只靠历史记录中的插件版本重装 |

### AW Config schema 真值

`aw config list/get/set/unset` 的 schema-aware 行为必须先判断本次配置 store 是否已经被安装位置消费。只要目标 scope / project root 下存在该插件的健康 install record 和可校验 historical bundle，schema 真值就来自该已安装版本的 manifest，而不是 current catalog。配置写入后的 dynamic artifact refresh 继续使用同一个已安装位置的 historical runtime；不能出现“按 current catalog 新 schema 写入、再按旧 historical bundle 刷新”的错位。

未安装插件、未安装的另一层 scope，或用户在命令 / TUI 中明确选择“按 current catalog 预置配置”且目标 config store 尚未被任何已安装位置消费时，schema 真值才来自 current catalog。该路径拿不到 current catalog 或插件未声明 `config.schema` 时，schema-aware 读写必须失败为 `catalogUnavailable` 或 `configSchemaUnavailable`；不能宽松写入 raw key，也不能从 catalog 历史记录拼出 schema。

`aw config reset` 必须先判定目标 config store 是否仍被安装位置消费。只要存在健康 installed consumer，reset 就不是 raw-store 删除，而是一次 installed-aware config write：它删除该 store 中所有用户写入值，复用 `set/unset` 的共享写入 helper，receipt 暴露 `removedKeys` 和 `artifactRefresh`，并在删除的 key 命中已安装 artifact 的 `refreshKeys` 时按每个 installed consumer 的 historical runtime 刷新 dynamic artifact。schema identity 冲突时，reset 可以作为整 store 清理动作继续执行，但不能任选一个 schema 解释输入，也不能执行局部 key 写入。只有目标 store 没有任何 installed consumer，只是卸载后残留或无法从安装证据证明仍被消费时，才允许在插件名和路径安全校验通过、用户确认后 raw 删除 store；这条孤立残留路径不解析 current catalog schema、不安装插件、不刷新 artifact。

如果同一份 config store 可能被多个已安装位置消费，CLI 必须收集这些位置的 schema identity。全部 identity 一致时可以使用该 schema；不一致时，`list/get/set/unset` 必须失败为 `configSchemaConflict`，并在默认输出、JSON 和 TUI 中列出冲突的 plugin version、scope / projectKey、schema identity 和可用修复动作，例如升级到同一版本、卸载多余位置或使用 `config reset` 清理 store。CLI 不能在冲突时静默选择 current catalog schema，也不能任选一个 installed schema 继续写入。

JSON receipt 和 TUI 数据模型必须暴露 schema 来源，至少包括 `schemaSource`（`installedHistorical` 或 `currentCatalog`）、schema identity、plugin version、manifest digest，以及 current catalog version / channel 或 install record location 这类可审计证据。status、diagnose 和 config 向导展示配置问题时，也必须区分 `catalogUnavailable`、`configSchemaUnavailable` 和 `configSchemaConflict`。

### Catalog Integrity

CLI 下载或使用远程 artifact 前必须校验 catalog 中声明的 integrity digest。digest 不匹配时：

- 不能安装或升级该 artifact。
- 不能把该版本显示为可升级。
- 不能把同名同版本不同 digest 自动当成内容更新。
- 应展示为 catalog 或 artifact integrity 错误，并建议刷新 catalog 或稍后重试。

远程 catalog 中同一 `name@version` 指向多个不同 digest 时，应视为 catalog 不一致。CLI 不能自行选择其中一个继续安装。

远程 catalog 中同一插件名出现多个版本，或跨 catalog 发布时用 SemVer 优先级相同但 build metadata 不同的版本替换同一插件时，应视为 catalog 不一致。CLI 不能用时间戳、数组顺序、build metadata 字符串或 artifact digest 自行打破平局；官方发布门禁必须在 catalog 发布前阻断这类输入。

## Manifest 公开合同

### Catalog 最低 CLI 版本

Catalog manifest 必须新增固定字段 `compatibility.aw.minVersion` 表达整个 catalog package 的最低 CLI 版本。`@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins` package metadata 中也必须保存同一个值，便于 CLI 做早期诊断；真正写入 cache、选择历史 catalog 或判断插件版本时，仍必须以 sidecar catalog manifest 和 catalog 历史版本记录校验结果为准。

```json
{
  "compatibility": {
    "aw": {
      "minVersion": "1.0.0"
    }
  }
}
```

规则：

- `minVersion` 必须是严格 SemVer 2.0.0。
- 远程发布的 catalog 必须声明 catalog 级 `minVersion`。
- `@yiliang/aw-plugins-manifest` metadata、`@yiliang/aw-plugins` metadata 和 catalog manifest 中的 catalog 级 `minVersion` 必须一致。
- catalog 级 `minVersion` 必须大于或等于包内所有插件 manifest 的 `compatibility.aw.minVersion`。
- 当前 CLI 版本低于 catalog 级 `minVersion` 时，CLI 不能把该 catalog 写入本地 cache，也不能把其中任何插件显示为可安装或可升级。
- 运行时发现任一 package metadata、catalog manifest 和插件 manifest 的最低 CLI 版本关系不一致时，必须把该 catalog 视为不一致。

### Catalog 历史记录字段

Catalog manifest 必须包含稳定的历史版本记录字段。Package metadata 不能复制、摘要或替代这份历史记录来参与版本判断；如果实现为了展示或诊断冗余保存只读信息，也不能被 CLI 当作兼容历史查询或发布校验依据。具体字段名可以由实现方案确定，但公开语义必须等价于：

```json
{
  "history": {
    "schemaVersion": 1,
    "channel": "latest",
    "releases": [
      {
        "catalogVersion": "1.2.0",
        "minAwVersion": "1.0.0",
        "plugins": [
          {
            "name": "code-review",
            "version": "1.4.0",
            "minAwVersion": "1.0.0",
            "artifactDigest": "sha256:...",
            "manifestDigest": "sha256:..."
          }
        ]
      }
    ]
  }
}
```

规则：

- `history.schemaVersion` 必须存在，方便未来改变结构时给出兼容边界。
- `history.channel` 必须存在并等于本 package 的发布轨道；同一份历史记录只能包含该轨道内的 release。
- 当前 CLI 不支持 `history.schemaVersion` 时，必须把 latest catalog 视为当前 `aw` 不支持的新 catalog，并提示用户升级 `aw`；不能跳过历史记录去读 npm metadata。
- `catalogVersion`、`minAwVersion` 和插件 `version` / `minAwVersion` 都必须是严格 SemVer 2.0.0；插件 `artifactDigest` / `manifestDigest` 必须存在且符合实现规定的 digest 格式。
- `latest` 轨道的 `catalogVersion` 必须是 stable SemVer；`beta` 轨道的 `catalogVersion` 必须是 prerelease SemVer。
- `releases` 必须按 catalog version 严格递增排序，最后一条记录必须对应当前准备发布或当前 package 自己的 catalog version。
- 同一 release 中记录的插件集合必须能和该 catalog 快照中的插件 entries 对齐；允许额外保存摘要字段，但不能缺少插件 version、插件最低 CLI 版本、artifact digest 和 manifest digest。
- 同一发布轨道历史记录中，同一 `plugin@version` 的 `artifactDigest` 和 `manifestDigest` 必须始终完全一致；任何摘要差异都表示 artifact 身份已变化，发布门禁必须要求插件 version 严格递增。
- 发布门禁不能只用目标发布轨道历史记录判断 `plugin@version` 不可变性；它必须合并官方 `latest` 和 `beta` 两条可用历史记录，并用并集校验同一官方 catalog 源内已发布 `plugin@version` 的 `artifactDigest` / `manifestDigest` 不变，以及同一插件没有使用 SemVer 优先级相同但 build metadata 不同的替代版本。
- 历史记录不能被 CLI 当作多版本安装源，只能用于历史 package 定位、发布校验和诊断。

### 插件最低 CLI 版本

插件 manifest 必须新增固定字段 `compatibility.aw.minVersion` 表达最低 CLI 版本：

```json
{
  "compatibility": {
    "aw": {
      "minVersion": "1.0.0"
    }
  }
}
```

规则：

- `minVersion` 必须是严格 SemVer 2.0.0。
- 远程发布的插件必须声明 `minVersion`。
- 构建、打包、远程 catalog 发布和插件作者工具校验都要拒绝缺失或非法的 `minVersion`。
- 插件 `minVersion` 不能高于所在 catalog package 的 catalog 级 `minVersion`。
- 当前 CLI 版本低于 `minVersion` 时，该插件版本对当前 CLI 不可安装、不可升级，也不能作为依赖自动安装候选。
- 当前 CLI 版本等于或高于 `minVersion` 时，插件版本可以进入后续平台、scope、配置和依赖预检。

如果既有源码插件缺少最低 CLI 版本，过渡期可以由实现方案定义一次性默认值或迁移方式；发布到 `@yiliang/aw-plugins` 的插件不能缺失该字段。

### 依赖最低版本

`dependencies.plugins[]` 必须支持依赖最低版本声明。公开语义必须等价于：

```json
{
  "dependencies": {
    "plugins": [
      {
        "name": "base-plugin",
        "minVersion": "1.2.0"
      }
    ]
  }
}
```

规则：

- `minVersion` 可选；省略表示依赖任意版本，只要依赖位置健康且兼容当前 CLI 即可。
- `minVersion` 出现时必须是严格 SemVer 2.0.0。
- `minVersion` 表示依赖插件已安装版本必须语义上大于或等于该版本。
- `minVersion` 不支持 `^`、`~`、`>=`、`<`、`1.x` 或多个比较器。它不是完整 range。
- 依赖 entry 仍只允许当前 AW catalog 内插件，不支持外部 URL、npm、git、本地 path、跨 marketplace、optional、peer 或 dev 依赖。
- 既有 `target`、`inheritInstallOptions` 和 `when` 语义继续保留。

### Manifest 发布门禁

插件构建、插件发布和远程 catalog 生成必须统一执行这些门禁：

- `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins` 的 package version 必须相同，且都等于 catalog version。
- 发布成功状态下，`@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins` 的发布轨道必须相同；同一 catalog version 不能只完成其中一个 package，也不能让两个 package 最终使用不同正式 dist-tag。
- sidecar package 必须只包含固定路径的 `catalog-manifest.json` 和必要 package metadata，不能包含插件 artifact 或完整 runtime 快照。
- sidecar `catalog-manifest.json` 和完整 catalog tarball 内的 catalog manifest 必须 byte-for-byte 一致；不一致时发布门禁失败。
- sidecar manifest 中声明的完整 catalog package name、version、channel 和 manifest 固定路径必须与将要发布的 `@yiliang/aw-plugins` package 一致。完整 package 的 npm tarball integrity 只在 pack / registry metadata 层校验，不能回填进 `catalog-manifest.json`。
- 正式 channel 切换前，`@yiliang/aw-plugins` 必须已经按同一 catalog version 发布或存在，并通过 package metadata、registry integrity、完整 catalog manifest、artifact digest 和 sidecar staging manifest 的一致性校验。sidecar manifest package 是正式 `latest` / `beta` 的最后切换点，不能先于 full package 暴露新 catalog version。
- 恢复重跑同一 catalog version 只能补齐缺失的一侧 package 或正式 dist-tag；已存在 package 必须和本次产物完全一致，不能覆盖、重打或用 package metadata 改写历史版本记录。
- catalog 级最低 CLI 版本必须存在且是严格 SemVer。
- `@yiliang/aw-plugins-manifest` metadata、`@yiliang/aw-plugins` metadata 和 catalog manifest 的 catalog 级最低 CLI 版本必须一致。
- catalog 历史版本记录必须存在、schema version 合法，且最后一条记录必须对应本次准备发布的 catalog version。
- catalog 历史版本记录的 `channel` 必须匹配本次发布 dist-tag。
- catalog version 必须符合 dist-tag 的版本类型约束：`latest` 只接受 stable version，`beta` 只接受 prerelease version。
- 插件 version 必须符合目标发布轨道约束：`latest` catalog 快照只接受 stable 插件 version，`beta` catalog 快照接受 stable 或 prerelease 插件 version。
- 本次 catalog version 必须严格高于最新已发布历史记录中的最高 catalog version。
- 插件 manifest version 必须是严格 SemVer。
- 插件最低 CLI 版本必须存在且是严格 SemVer。
- 插件最低 CLI 版本不能高于 catalog 级最低 CLI 版本。
- 本次历史记录中的插件 version、插件最低 CLI 版本、artifact digest 和 manifest digest 必须与当前 catalog 快照中的插件 manifest、catalog entry 和构建产物一致。
- 同一插件如果相对目标发布轨道历史记录改变 artifact 身份，插件 version 必须严格高于该插件在目标发布轨道历史记录中的最高版本；未改变 artifact 身份时可以保持同一插件 version，但 `artifactDigest` 和 `manifestDigest` 必须和官方 `latest` / `beta` 历史记录并集中同一 `plugin@version` 对应的已发布 artifact 完全一致。
- catalog 级和插件级最低 CLI 版本必须覆盖当前 catalog 快照和插件 artifact 的真实运行时要求；发布门禁不能因为本次最低 CLI 版本低于目标发布轨道历史记录中的旧 release 而失败。
- 每个依赖最低版本如果存在，必须是严格 SemVer。
- 依赖目标必须能在将要发布的 catalog 快照中解析，且快照内依赖插件版本必须满足最低版本要求。
- artifact 中 manifest version 必须和 catalog entry 的插件版本一致。
- artifact digest 必须和 catalog entry 的 integrity 一致，manifest digest 必须和构建后 artifact 内的规范化 manifest 一致。
- 同一插件版本不能在官方 `latest` / `beta` 历史记录并集中覆盖已有 artifact digest 或 manifest digest。
- 同一 catalog package 内同一插件名只能出现一个版本。
- 同一插件不能在官方 `latest` / `beta` 历史记录并集中用多个 SemVer 优先级相同的版本替换彼此，包括仅 build metadata 不同的版本。

失败时必须明确指出插件名、字段路径和非法值，不能继续生成可发布 catalog 或 artifact。

## 版本比较与状态需求

### 插件可升级

用户可见 `可升级` 只表示：current catalog 快照中的插件版本语义上高于该位置已安装版本。

判断规则：

- current catalog 插件版本高于已安装版本：显示 `可升级`。
- current catalog 插件版本等于已安装版本：不显示 `可升级`。
- 已安装版本高于 current catalog 插件版本：显示 `异常`，原因是版本不一致或当前 CLI 无法验证该版本。
- 任一侧版本无法按严格 SemVer 解析：显示 `异常`，原因是版本号不符合规范。
- 默认 channel 存在更高 catalog version，但 latest catalog 要求更高 CLI 且本次使用了历史兼容 catalog，或已经解析出的兼容 catalog 因远程失败而命中本地 cache：不能显示成插件 `可升级`，应在状态详情中说明 catalog 更新被当前 `aw` 版本阻止。
- bundle fingerprint、source drift、project identity drift 或同版本内容变化不能触发 `可升级`。

### Catalog 版本阻止

当默认 channel 的 latest catalog 存在，但其 catalog 级最低 CLI 版本高于当前 CLI，或历史记录 schema 已超出当前 CLI 支持范围时：

- CLI 不能写入或使用这个不兼容 catalog。
- CLI 应读取 latest sidecar manifest 暴露的历史版本记录，并据此查询仍支持当前 CLI 的最新历史 catalog package。
- 历史版本记录缺失、schema 不受支持、非法或不可获取时，必须按查询失败处理；CLI 不能改用 npm metadata。
- 找到兼容历史 catalog 时，已安装插件仍按实际使用的 current catalog 判断健康和可升级状态。
- 通过有效历史记录确认查不到兼容历史 catalog 时，需要 current catalog 的命令失败为 `awVersionTooLow`；本地 cache 不能推翻这个否定结论。
- 如果已经找到兼容历史 catalog，但后续获取或校验对应 catalog package 失败，且本地有与该 selector / catalog identity 匹配的有效 cache，可以使用 cache，并必须展示 latest catalog 被当前 `aw` 版本阻止和 cache fallback 身份。
- CLI 输出、JSON 和 TUI 状态详情必须能展示“有更新的 catalog，但当前 aw 版本过低”。
- 输出中的建议应说明需要升级 `aw` CLI，而不是建议重复执行插件 upgrade。

### 依赖版本比较

依赖版本比较必须基于父插件实际生效的依赖声明：

- 已安装父插件的健康判断优先使用安装时接受并写入 record 的 dependency edge declaration，包括当时的 `minVersion`。
- Current catalog 中父插件新版本的依赖变化用于升级规划和 catalog drift 提示，不能单独把旧父插件安装判成不健康。
- 父插件升级时使用 current catalog 中新父插件版本的依赖声明。

每条依赖状态至少需要表达：

- 依赖插件名。
- 目标 scope 和平台推导结果。
- 声明的最低版本，若有。
- 当前满足该依赖的位置，若有。
- 已安装依赖版本，若有。
- current catalog 中的依赖候选版本，若有。
- 版本比较结果：满足、缺失、版本过低、可自动升级、catalog 更新被 CLI 版本阻止、catalog 缺失或未知。

依赖版本比较不能只作为人类文案存在。JSON 输出和 TUI 数据模型必须能稳定消费这些结果。

### 异常与警告边界

这些场景应是异常或阻断：

- 已安装插件版本不是合法 SemVer。
- 已安装依赖版本不是合法 SemVer，且该依赖需要参与最低版本比较。
- 插件 artifact digest 和 catalog integrity 不一致。
- Current catalog 中同一插件名出现多个版本。
- Catalog 级最低 CLI 版本缺失、非法，或低于包内任一插件最低 CLI 版本。
- 已安装父插件 record 中的依赖声明非法或无法解析。
- 依赖最低版本高于 current catalog 中依赖插件版本。
- 自动依赖升级预检失败。

这些场景不应直接变成异常：

- 远程 catalog 暂时不可用，但与本次选择器匹配的本地有效缓存可用。
- latest catalog 要求更高 CLI，但能找到兼容历史 catalog，或已解析出的兼容历史 catalog 在后续远程获取失败时命中匹配的本地 cache。
- Current catalog 中父插件的新版本调整了依赖声明，但当前已安装父插件仍满足安装时的依赖声明。
- 已安装版本和 current catalog 插件版本只存在 build metadata 差异时，不能显示成可升级；官方 catalog 发布门禁应阻断同插件同优先级替换，运行时遇到这类 catalog 输入时按 catalog 不一致处理。

## 安装与升级行为需求

### 插件安装

安装插件时，CLI 必须从 current catalog 使用该插件在当前快照中的版本。若 latest catalog 不兼容当前 CLI，CLI 应先按 catalog 解析规则尝试历史兼容 catalog；只有已经解析出允许使用的 catalog identity 后，远程获取或校验失败才可以按规则命中本地 cache。最终仍拿不到 current catalog 或 current catalog 中不存在用户请求的插件时，安装必须失败。

安装前必须解析完整依赖图：

- 缺失依赖自动安装。
- 已安装依赖版本低于声明的 `minVersion` 时自动升级。
- 已安装依赖版本满足 `minVersion` 时复用现有健康安装。
- 依赖候选版本来自 current catalog 中的依赖插件版本。
- 任一依赖无法解析、无法满足最低版本、catalog 更新被 CLI 版本阻止且没有兼容 current catalog，或预检失败时，父插件不能写入。

### 插件升级

升级插件时，CLI 必须使用 current catalog 中该插件的版本。Current catalog 来自最新兼容远程 catalog、历史兼容 catalog，或已经解析出允许使用的 catalog identity 后命中的有效本地 cache；不能使用被当前 CLI 版本阻止的 latest catalog，也不能用 cache 推翻历史记录确认无兼容 catalog 的结论。

升级父插件时，依赖处理规则和安装相同：

- 新父插件版本声明的依赖最低版本必须满足。
- 缺失依赖自动安装。
- 版本过低依赖自动升级。
- 自动依赖升级和父插件升级必须属于同一预检和写入事务。
- 任何目标失败都不能留下部分升级结果。

`upgrade --all` 仍只把用户显式保留的安装作为根。自动依赖只有在根插件升级需要时才被升级；孤立自动依赖不能因为 catalog 有新版本就被当作用户目标自动升级。

### Historical runtime 持久化

移除 embedded catalog 后，historical runtime / snapshot 是已安装版本的可重放证据，不能只是 current catalog cache 中某个目录的引用。

成功的 `install`、`upgrade`，以及依赖 current catalog 成功重建本地 artifact 的 `repair`，必须在提交表示成功的 install record 前，把该次接受的插件 artifact 持久化为可校验 historical runtime / snapshot。持久化失败时，本次写命令不能写入成功 record；如果平台 native 写入已经发生，必须留下可恢复的 transaction marker 或等价证据，让后续 `repair` / `cleanup` 收口。

Historical runtime 必须和 install record 或其同事务提交的 source evidence 稳定绑定，至少能验证 plugin version、artifact digest、manifest digest、bundle fingerprint、manifest path 和支持的 lifecycle / renderer 入口。后续 `uninstall`、只重放已安装版本的 `repair`、config schema 读取和 dynamic artifact refresh 必须使用这份绑定证据，不能拿 current catalog 中同名同版本插件直接替代，除非 digest、manifest version、bundle fingerprint 和路径边界都证明它就是同一 artifact。

Catalog cache 重建、`aw init --force`、channel 切换、cache cleanup 或旧 catalog 淘汰不能删除仍被任一健康 install record、project artifact identity、dynamic diagnostic cache 或 native recovery marker 引用的 historical runtime。只有在确认没有任何安装位置或恢复证据引用某个 exact runtime 后，清理流程才可以删除它，并且删除结果必须可诊断。

### Catalog 刷新与插件升级的边界

Catalog 刷新只改变“可见的 current catalog”。插件升级才改变已安装插件。

用户执行状态查看、TUI 首页或显式 catalog refresh 后，可能看到新的 `可升级`、`catalog 更新被 CLI 版本阻止` 或 `依赖可自动升级` 信息，但这些动作不能直接修改平台 runtime 或 install record。

### `aw init` 与旁路命令

移除 embedded catalog 后，`aw init` 的语义必须从“把 CLI npm 包内的插件快照同步到 `~/.aw`”改成“预热远程 catalog 和 artifact cache”：

- `aw init` 先拉取当前 channel 的 `@yiliang/aw-plugins-manifest`。latest sidecar manifest 表明 catalog 兼容当前 CLI 时，再拉取对应版本的完整 `@yiliang/aw-plugins`，用 registry/package metadata 校验 sidecar 和完整 catalog 的 npm integrity，确认两处 manifest byte-for-byte 一致，并校验 artifact digest 后写入本地 catalog/cache；latest catalog 不兼容当前 CLI 时，按同一 catalog 解析规则优先利用 sidecar manifest 中的 catalog 历史版本记录查询历史兼容 catalog，查到后只预热该兼容 catalog。
- `aw init --force` 可以强制重新拉取和重建本地 catalog / artifact cache，但仍不能从 CLI package 内部恢复 embedded 插件快照，也不能删除仍被已安装位置或恢复证据引用的 historical runtime。
- `aw init` 不安装插件，不升级已安装插件，不写平台 runtime，不修改 install record，也不清理已安装位置的 historical runtime；它只准备后续命令会使用的 current catalog/cache。
- 远程不可用时，已有与本次选择器匹配的有效缓存的默认 `aw init` 可以报告 cache fallback；没有匹配缓存时，`aw init` 必须失败并说明 catalog unavailable。
- latest catalog 不兼容且通过有效 sidecar 历史记录确认查不到历史兼容 catalog 时，`aw init` 必须失败为 `awVersionTooLow`，不能用本地 cache fallback 改写。latest sidecar manifest、历史记录缺失、schema 不受支持、非法或不可获取时，`aw init` 必须失败为 `catalogHistoryUnavailable`，不能退回 npm metadata、完整 catalog tarball 或本地 cache。

`uninstall`、`repair`、`reinstall`、主控制台和发现类入口也必须明确 current catalog unavailable 时的边界：

- 安装、升级、插件列表发现、可安装插件详情、依赖解析和任何“选择 current catalog 版本”的动作都必须拿到 current catalog；拿不到时应按统一状态映射禁用对应动作或失败。
- 只读状态、主控制台首页和诊断页可以在 current catalog unavailable 时展示已安装记录、平台 runtime 证据和 legacy metadata，但必须把 catalog 状态标为 unavailable，不能展示新的可安装版本或伪造升级判断。
- `uninstall` 不依赖 current catalog。它必须以 install record、dependency index、平台现场、project artifact identity、native marker、shared runtime owner 和可校验 historical lifecycle runtime 为边界执行卸载保护、卸载 lifecycle 和受管 artifact 清理；current catalog 只能作为诊断辅助，不能替代 historical runtime 或安装时证据。
- `uninstall` 需要 historical runtime 但该 runtime 缺失、摘要不可信或 legacy 证据不足时必须 fail closed，返回 `historicalRuntimeUnavailable` 或 `uninstallBlocked`，并提示先通过 `repair` 重建可卸载状态。需要在证据足够时只清理 AW 可证明拥有的残留，应进入 `cleanup` 的受限清理路径，而不是让 `uninstall` 跳过 lifecycle 继续。
- `repair` 如果只修复已经安装版本的本地 artifact，并且 install record 中有可校验的 historical snapshot/runtime 证据，可以不依赖 current catalog；如果需要从远程重新取得 artifact、解析依赖、选择版本或替换为 current catalog 版本，则必须依赖 current catalog。
- `reinstall` 始终是“按 current catalog 重新安装”的入口，必须拿到 current catalog。它不能在 current catalog unavailable 时改用 historical snapshot/runtime 证据重建已安装版本；需要历史证据重放的场景属于 `repair`。
- 当目标位置已经安装时，`reinstall` 的旧状态撤销阶段必须继承 `uninstall` 的安全边界：需要运行旧版本 lifecycle、撤销 dynamic artifact 或收口 native 副作用时，只能使用可校验 historical runtime。historical runtime 缺失、摘要不可信或 legacy 证据不足时，本次 `reinstall` 必须在写入新版本前 fail closed，返回 `historicalRuntimeUnavailable` 或对应卸载阻断状态，并提示先 `repair` 或按 `cleanup` 的受限路径处理可证明残留。旧安装没有 lifecycle / dynamic artifact / native 副作用，且 AW ownership 证据足以定位受管文件时，`reinstall` 可以只撤销这些可证明的 AW-owned 状态后继续 fresh install。
- `uninstall` 不能在 current catalog unavailable 时静默降级到 CLI 包内 embedded artifact，也不能把 current catalog 的同名插件版本当作 historical runtime 的替代品。
- `repair`、`reinstall` 不能在 current catalog unavailable 时静默降级到 CLI 包内 embedded artifact，也不能把 current catalog 的同名插件版本当作 historical runtime 的替代品，除非 digest、manifest version 和 bundle fingerprint 等证据证明它就是同一 artifact。

### Legacy 状态运行时合同

本期上线后会遇到旧 install record、旧本地 marketplace config 和旧缓存。需求层面只定义运行时合同，不要求在本 Spec 中写迁移脚本：

- 旧 install record 缺少 dependency edge `minVersion` 时，已安装父插件的历史依赖健康检查把该 edge 解释为“无最低版本要求”，同时在 JSON/TUI 里标记为 legacy dependency metadata。Current catalog 中父插件新版本的依赖最低版本只用于升级规划和 drift 提示。
- 旧 install record 的 `resolvedVersion` 如果是合法 SemVer，可以参与正常版本比较；如果不是合法 SemVer，状态应标记为 legacy invalid version 或等价异常，不能退回字符串比较，也不能显示 `可升级`。
- 写命令遇到 legacy invalid version 时，不能静默把旧版本当作低版本自动升级。`upgrade --all` 和自动依赖升级不能自动替换这类记录；只有用户显式针对该插件执行 reinstall 或 upgrade，且 current catalog 能解析出可安装版本时，命令才可以在输出中说明“正在替换 legacy invalid version”并写入新 record。其它写入路径必须在写入前失败。
- 旧 `~/.aw/config.json` 中只有 `sourceVersion` / `bundleFingerprint` 的本地 marketplace 元数据，不能被解释为有效远程 catalog cache。远程 catalog 模型启用后，首次需要 current catalog 的命令必须刷新远程 catalog；无法刷新时按 catalog unavailable 处理，不能回退 embedded catalog。
- 旧 artifact cache 或 historical snapshot 只有在能通过 manifest version、digest、bundle fingerprint 和路径边界校验时，才能作为 `uninstall` 或 `repair` 的 historical runtime 证据；证据不足时，`uninstall` 必须 fail closed 并提示先 `repair`，`repair` 必须要求 current catalog 或明确失败。`reinstall` 不使用这些历史证据绕过 current catalog。
- JSON 和 TUI 需要能表达 legacy metadata 的存在和影响，例如 dependency minVersion unknown、catalog cache legacy、installed version invalid，而不是只输出人类文案。

## 发布脚本调整方向

发布脚本必须从“CLI 包发布时顺带发布插件快照”改成“CLI 包和 catalog 包各自独立发布”。

### CLI 发布入口

CLI 发布入口只负责 `@yiliang/aw`：

- CLI version 仍来自 `packages/cli/package.json`，根目录 `package.json` 如继续作为工作区版本镜像，必须和 CLI version 同步。
- CLI 发布验证只保证 CLI 运行时代码、命令合同、fetch/cache catalog 能力和兼容性校验正确。
- CLI npm tarball 不能包含 `plugins-dist/` 或等价的完整插件 artifact 快照。
- `prepack`、`pack:cli`、`release:pack`、`release:publish:*` 和 Makefile release 入口必须避免把插件 staging 产物重新带回 CLI tarball。
- CLI-only 发布不要求生成、打包或发布 `@yiliang/aw-plugins-manifest` 或 `@yiliang/aw-plugins`。

### Catalog 发布入口

Catalog 发布入口负责同一个 catalog version 下的 `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins`：

- Catalog version 独立于 CLI version，由 `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins` 的相同 package version 表达。
- Catalog 发布脚本必须在构建可发布包前获取目标发布轨道最新已发布 sidecar catalog manifest 的历史版本记录；除目标轨道首次发布外，获取失败、schema 不兼容或历史记录无法校验都必须让发布失败。
- Catalog 发布脚本还必须获取官方 `latest` 和 `beta` 两条可用发布轨道的最新 sidecar catalog manifest，把它们的历史版本记录合并为只读发布门禁输入，校验同一官方 catalog 源内 `plugin@version` 的 artifact digest / manifest digest 不可变，以及同一插件没有使用 SemVer 优先级相同但 build metadata 不同的替代版本。某条轨道尚未发布时可以视为空历史；已存在轨道的历史记录无法获取或无法校验时，本次发布必须失败。
- Catalog 发布脚本必须构建全部源码插件，生成完整 catalog 快照，计算每个 artifact digest 和 manifest digest，并生成一份 canonical `catalog-manifest.json`。这份 manifest 必须同时写入 `@yiliang/aw-plugins-manifest` sidecar package 和完整 `@yiliang/aw-plugins` package。
- `@yiliang/aw-plugins-manifest` tarball 只能包含 `catalog-manifest.json` 和必要 package metadata；`@yiliang/aw-plugins` tarball 必须包含同一份 manifest 和所有构建后插件 artifact。
- Catalog 发布脚本必须把本次准备发布的 catalog version、catalog 最低 CLI 版本、插件 version、插件最低 CLI 版本、artifact digest 和 manifest digest 追加进历史版本记录，再把更新后的历史记录写入本次 catalog manifest；package metadata 不能作为历史版本记录的替代输出。
- Catalog 发布脚本必须采用完整包先就绪、sidecar 最后切换的 two-phase 流程：先构建并校验 staging manifest 和两个 tarball，再发布或确认同版本 `@yiliang/aw-plugins`，校验 registry metadata、npm integrity、完整包内 manifest 与 sidecar staging manifest 一致，并校验 artifact digest；最后发布或提升同版本 `@yiliang/aw-plugins-manifest` 到正式 `latest` / `beta`，并做两包 package identity、channel、manifest 一致性终检。
- sidecar manifest package 或它的正式 dist-tag 是用户通过默认 channel 看到新 catalog 的最终切换点。full package 已成功但 sidecar 或正式 dist-tag 失败时，发布入口不能报告成功，也不能移动 sidecar 指向半成品；维护者可以重跑同一 catalog version 的 catalog 发布入口，重跑时必须复用并校验已存在 full package，再补齐 sidecar 或正式 dist-tag。
- 如果同一 catalog version 的 full package 或 sidecar package 已存在但内容、metadata、history release、artifact digest 或 manifest digest 与本次 staging 产物不一致，恢复重跑必须失败；发布流程不能覆盖已发布 npm version，维护者必须人工处理或发布更高 catalog version。
- Catalog 发布脚本必须支持 `beta` 和 `latest` dist-tag，并使用和 CLI 一致的官方 registry 约定。
- Catalog 发布脚本必须拒绝把 stable catalog version 发布到 `beta`，也必须拒绝把 prerelease catalog version 发布到 `latest`。
- Catalog 发布脚本必须拒绝把 prerelease 插件 version 发布到 `latest` catalog；`beta` catalog 可以包含 stable 或 prerelease 插件 version。
- Catalog 发布脚本必须拒绝同一个 catalog version 复用到另一个发布轨道；轨道晋升只能通过发布新的 catalog version 完成。
- Catalog 发布脚本必须执行 manifest 发布门禁、catalog 级最低 CLI 版本校验、插件最低 CLI 版本校验、插件最低 CLI 版本不高于 catalog 门槛校验、依赖最低版本解析、artifact integrity 校验、跨轨道不可变 `plugin@version` 校验和目标发布轨道历史版本严格递增校验。
- 发布门禁失败时必须报错并停止发布，包括本次 catalog version 未高于目标发布轨道历史最高 catalog version、`latest` catalog 包含 prerelease 插件 version、同一 `plugin@version` 的 artifact digest 或 manifest digest 与官方 `latest` / `beta` 历史记录并集不一致、插件 artifact 相对目标发布轨道历史变化但插件 version 未高于目标发布轨道历史最高版本、同插件仅 build metadata 不同、最低 CLI 版本非法、缺失、不一致，或最低 CLI 版本不能覆盖当前快照真实需求。
- sidecar package 或完整 catalog package 任一侧发布、校验或 dist-tag 设置失败时，Catalog 发布入口都不能报告成功。输出必须明确指出失败发生在 sidecar manifest package、完整 catalog package 还是二者一致性校验。
- 本期不需要处理两个发布进程同时追加同一份历史记录的竞态；官方发布流程应保证 catalog 发布串行执行。
- Catalog-only 发布不要求修改或发布 `@yiliang/aw`。

### 组合发布入口

仓库可以保留一个 convenience 组合发布入口，但它必须显式编排两个独立发布流程：

- 组合发布需要分别接收或确定 CLI version 与 catalog version，不能用一个版本号隐式代表两者。
- 组合发布默认先发布 `@yiliang/aw`，再发布同一 catalog version 的 `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins`。
- 组合发布前必须分别跑 CLI 发布验证和 catalog 发布验证；任一验证失败都不能开始发布。
- 如果 CLI 发布成功但 catalog 发布失败，脚本不能声称整体成功，也不能尝试不可靠的自动回滚；输出必须明确说明 CLI 已发布、sidecar / 完整 catalog 的发布状态，并给出可重跑的 catalog 发布入口。
- 组合发布不能成为唯一入口；维护者必须能只发布 CLI 或只发布 catalog。

### 本地验证与打包

本地发布验证需要拆分：

- CLI pack / smoke 要验证 `@yiliang/aw` tarball 不含 embedded catalog 或完整插件 artifact。
- Sidecar pack / smoke 要验证 `@yiliang/aw-plugins-manifest` tarball 只含 `catalog-manifest.json` 和必要 package metadata，manifest 中有 catalog schema version、catalog 级最低 CLI 版本、catalog 历史版本记录、完整 catalog package identity、每个插件的单版本快照，以及 history releases 中每个插件的 `artifactDigest` / `manifestDigest`；manifest 不能包含自身 digest 或任一 npm tarball 的最终 integrity。
- Catalog pack / smoke 要验证 `@yiliang/aw-plugins` tarball 含与 sidecar 一致的完整 catalog manifest、全部构建后插件 artifact 和 digest 元数据。
- Fetch smoke 要覆盖 CLI 先从本地或测试 registry 的 `@yiliang/aw-plugins-manifest` 解析 current catalog，兼容后再下载 `@yiliang/aw-plugins` tarball；latest catalog 要求更高 CLI 时优先按 sidecar manifest 的历史版本记录查询历史兼容 catalog，并在 sidecar 缺失、manifest 不可用、无缓存且 catalog 不可用时给出 catalog unavailable。
- 版本同步脚本需要区分 CLI version 和 catalog version，不能继续只用根目录 package version 表达全部发布身份。

## CLI、JSON 与 TUI 公开合同

### CLI 人类输出

CLI 输出涉及版本时必须说明版本来源，避免把 CLI、catalog 和插件版本混成一个概念。

至少需要覆盖这些场景：

- 当前使用的是远程 catalog 还是本地缓存。
- 插件有可升级版本。
- latest catalog 有更新但被当前 CLI 版本阻止。
- 已回退到历史兼容 catalog 或本地 cache。
- 依赖版本过低，父插件安装或升级将自动升级依赖。
- 依赖最低版本无法满足。
- catalog 或 artifact integrity 失败。
- 非法版本字段导致构建、发布或运行时阻断。

包含命令建议时，仍需遵守前置 TUI 返工 Spec 中的结构化下一步要求：不能只输出裸命令，必须说明命令作用和适用场景。

### JSON 合同

JSON 输出必须区分这些版本概念：

- CLI version。
- sidecar catalog manifest package source、package version、channel、npm integrity 和运行时计算得到的 manifest digest。
- catalog source、catalog version、catalog revision、catalog freshness 和 catalog 最低 CLI 版本。
- catalog channel、显式指定的 catalog version、latest catalog version 及其最低 CLI 版本。
- catalog 选择器类型、请求的 selector 值、cache fallback 是否匹配该 selector，以及命中的 cached catalog identity。
- catalog 历史版本记录 schema version，以及历史兼容 catalog 的选择来源。
- latest catalog 是否被当前 CLI 版本阻止，以及本次是否回退到历史兼容 catalog 或本地 cache。
- 插件 installed version。
- 插件 current catalog version。
- 插件 min CLI version。
- 依赖 min version。
- 依赖 installed version。
- 依赖 candidate version。
- 依赖 version comparison result。
- artifact integrity status。
- historical runtime / snapshot 的 source identity、健康状态和保留状态。
- legacy metadata status。
- config schema source、schema identity、schema plugin version 和 schema manifest digest。

新增或改变既有 JSON 机器结构时，必须提供 schema version 或等价兼容边界。受版本管理影响的 `status --json` 子结构和写命令 JSON receipt 都必须带可机器判断的 schema version；只追加字段时也要说明它属于哪个 schema version。JSON 中不能只保留人类文案，否则 TUI 和外部脚本无法稳定判断状态。

`aw init --json` 是 catalog/cache 预热入口，也必须有稳定机器合同。它的 receipt 必须带 schema version，并至少表达本次请求的 catalog channel 或显式 catalog version、选择器类型、实际使用的 sidecar manifest package source/version/channel/integrity、实际使用的完整 catalog source/version/channel/minAwVersion、latest catalog version/minAwVersion、latest 是否被当前 CLI 阻止、是否使用历史兼容 catalog 或 cache fallback、cache fallback 命中的 selector / catalog identity、历史记录 schema version、显式覆盖来源、sidecar manifest unavailable / manifest mismatch / catalog unavailable / `aw` 版本过低 / 历史记录不可用 / integrity 失败等阻断 code。

写命令的 JSON receipt 也必须带版本决策信息，至少包括本次使用的 sidecar manifest package source/version/channel/integrity、本次使用的完整 catalog source/version/channel/minAwVersion、catalog 选择器和 cache fallback 命中情况、latest catalog 是否被 CLI 版本阻止、每个写入目标选择的插件版本、自动安装或升级的依赖、historical runtime / snapshot 的持久化结果、config 写命令使用的 schema source / identity，以及因为 sidecar manifest unavailable、manifest mismatch、catalog unavailable、`aw` 版本过低、legacy invalid version、`historicalRuntimeUnavailable`、`uninstallBlocked`、config schema unavailable / conflict 或 integrity 错误导致的阻断原因。

### TUI 展示

TUI 首页和详情页继续沿用前置 Spec 的状态模型和“不可展示 raw command”约束。

版本相关展示要求：

- 首页的 `可升级` 只显示当前 CLI 可安装的插件升级。
- 详情页需要能展示当前安装版本、current catalog 插件版本、catalog 来源和 catalog 最低 CLI 版本。
- 若 latest catalog 被当前 CLI 版本阻止，详情页显示为受 CLI 版本限制的提示，不把主操作标成升级。
- 依赖版本过低时，详情页或状态页说明父插件安装或升级将同时升级哪些依赖。
- 依赖最低版本无法满足时，状态页展示阻断原因。
- Catalog refresh 的结果只作为 catalog 状态反馈，不显示成插件已经升级。
- Current catalog unavailable 时，首页和详情页可以展示已安装状态，但安装、升级、发现和选择最新版本的操作必须显示为不可用或隐藏，并说明 catalog 不可用。
- 配置向导必须展示本次使用的 schema source；已安装位置的 historical schema 可用时，current catalog unavailable 不能阻断配置读写；schema conflict 时必须阻断写入并展示冲突位置。
- Legacy metadata 影响判断时，详情页必须展示具体影响，例如依赖最低版本未知、已安装版本非法或旧本地 catalog cache 不可用。

## 插件作者体验需求

插件作者工具和文档必须让作者能明确知道以下规则：

- 插件版本和 CLI 版本是两套版本，插件升级不要求 CLI 发版。
- 插件 manifest version 必须是严格 SemVer。
- 面向 `latest` catalog 发布的插件 version 必须是 stable SemVer；prerelease 插件只能通过 `beta` catalog 分发。
- 插件发布到远程 catalog 前必须声明最低 CLI 版本。
- 插件最低 CLI 版本不能高于 catalog 级最低 CLI 版本；catalog 级门槛必须覆盖包内所有插件要求。
- 插件依赖可以声明 `minVersion`，但不能声明完整 range。
- 修改插件 runtime 内容时必须 bump 插件 version。
- 修改依赖最低版本、最低 CLI 版本或平台能力时必须重新发布插件 artifact 和 catalog entry。
- 同一插件版本发布后不可变，不能靠覆盖 artifact 来修复内容。
- Catalog 发布流程会读取历史版本记录中的 artifact digest 和 manifest digest 校验版本递增；插件内容变化但没有 bump 插件 version 时会在发布前失败。
- 构建后的插件 staging 目录、`@yiliang/aw-plugins-manifest` manifest 包和 `@yiliang/aw-plugins` artifact 包内容都是生成产物，不手改；远程 artifact 必须由发布流程生成。

脚手架和校验工具应在作者创建、验证或发布插件时尽早发现非法版本，而不是等用户安装时失败。至少要在创建或校验阶段阻断缺失 `compatibility.aw.minVersion`、非法插件 `version`、非法插件最低 CLI 版本、非法 `dependencies.plugins[].minVersion`、仍使用旧式 `dependencies.plugins[].version` / `range` 字段，以及插件最低 CLI 版本高于目标 catalog 级最低 CLI 版本的情况。

## 验收标准

1. CLI、catalog version、catalog 最低 CLI 版本、插件 manifest、插件最低 CLI 版本、依赖最低版本和已安装版本都使用同一套严格 SemVer 解析和比较规则。
2. 非法版本值在构建、打包、发布或运行时比较前被阻断，错误信息包含字段路径和值。
3. `@yiliang/aw-plugins-manifest` 和 `@yiliang/aw-plugins` 使用相同 catalog version 和发布轨道；sidecar manifest、完整 catalog tarball 内 manifest 和 package metadata 都声明相同的 catalog 级最低 CLI 版本；缺失、不一致或非法时发布门禁失败。
4. 包内任一插件 manifest 的最低 CLI 版本高于 catalog 级最低 CLI 版本时，发布门禁失败；运行时遇到这类 catalog 时按 catalog 不一致处理。验收接受 catalog 级最低 CLI 版本是整包门槛，不要求旧 CLI 在不兼容的新 catalog 中筛选仍兼容的单个插件。
5. 插件可以通过 `@yiliang/aw-plugins` 发布新版本，用户不升级 CLI 也能在当前 CLI 满足目标 catalog 最低 CLI 版本时看到并安装该插件版本。
6. 最新官方 catalog 只包含当前官方最新插件快照；同一 catalog package 内每个插件名最多出现一个版本，不包含同一插件的历史多版本 artifact 或可安装索引，但包含 catalog 历史版本记录。
7. CLI 先获取并校验 `@yiliang/aw-plugins-manifest`，只有 sidecar manifest 表明目标 catalog 兼容当前 CLI 后，才下载或使用完整 `@yiliang/aw-plugins` tarball；CLI 不能为了读取 manifest 或历史记录而先下载完整 artifact tarball。完整 package 的 npm tarball integrity 从 registry/package metadata 校验，不是 `catalog-manifest.json` 字段。
8. latest catalog 的最低 CLI 版本高于当前 CLI 时，CLI 不写入该 catalog，输出提示升级 `aw`，并按 sidecar manifest 中的 catalog 历史版本记录查询仍支持当前 CLI 的最新历史 catalog package。历史记录 schema 超出当前 CLI 支持范围时，查询失败为 `catalogHistoryUnavailable`，不能改用 npm metadata 或本地 cache 绕过。
9. latest catalog 不兼容且查到历史兼容 catalog 时，CLI 获取并校验该历史版本的 sidecar manifest 和完整 catalog tarball，使用该历史 catalog 作为 current catalog，并在默认输出、JSON 和 verbose 诊断中说明 latest catalog 被当前 CLI 版本阻止。
10. latest catalog 不兼容时，sidecar manifest 或历史版本记录缺失、schema 不受支持、非法或不可获取会让需要 current catalog 的命令失败为 `catalogHistoryUnavailable`；CLI 不能改用完整 catalog tarball、npm metadata 或 registry 版本列表推测兼容历史版本。有效历史记录确认查不到兼容 catalog 时固定失败为 `awVersionTooLow`，不能用本地 cache fallback 改写；只有已经解析出允许使用的兼容 catalog identity 后，远程获取或校验失败才可以按选择器命中 cache fallback。
11. 同一插件用 SemVer 优先级相同但 build metadata 不同的版本替换彼此时，官方 catalog 发布门禁失败；运行时遇到这类 catalog 输入时按 catalog 不一致处理。
12. CLI 发布不再携带 embedded catalog、`plugins-dist/` 或等价的完整插件快照。
13. 本地 catalog 元数据能区分 sidecar manifest 来源、catalog 来源、catalog 发布身份、catalog 选择器、catalog 最低 CLI 版本、写入该 catalog 的 CLI 版本和 artifact integrity 信息。
14. `aw status` 和 TUI 在 current catalog 中插件版本高于已安装版本时显示 `可升级`。
15. latest catalog 被当前 CLI 版本阻止时，不显示成插件 `可升级`，而是展示 catalog 更新受 CLI 版本限制。
16. 插件 manifest 缺失最低 CLI 版本时，远程发布门禁失败。
17. `dependencies.plugins[].minVersion` 合法时，父插件安装和升级会校验依赖版本。
18. 已安装依赖版本低于 `minVersion` 且 current catalog 中依赖插件版本满足条件时，父插件安装或升级会自动升级依赖。
19. 自动依赖升级和父插件写入处于同一预检和写入事务；任一目标失败时整体失败。
20. 依赖最低版本无法满足、依赖候选缺失、catalog 更新被 CLI 版本阻止且没有兼容 current catalog，或依赖版本非法时，父插件写入前失败。
21. 状态 JSON 能稳定表达 sidecar manifest 来源、catalog 选择器、catalog 最低 CLI 版本、latest catalog 阻止状态、cache fallback 命中、依赖最低版本、已安装版本、候选版本、比较结果、historical runtime 健康状态、config schema source / identity，并带 schema version 或等价兼容边界。
22. 写命令 JSON receipt 能稳定表达本次使用的 sidecar manifest source/version/channel/integrity、本次使用的 catalog source/version/channel/minAwVersion、catalog 选择器、cache fallback 命中、选择的插件版本、自动依赖升级、historical runtime / snapshot 持久化结果、config schema source / identity、latest catalog 阻止状态和阻断原因，并带 schema version 或等价兼容边界。
23. 同一 `plugin@version` 指向不同 artifact digest 时，CLI 视为 catalog integrity 错误，不能显示为升级。
24. 已安装版本和 current catalog 插件版本只存在 build metadata 差异时，不能显示为 `可升级`。
25. `aw status`、TUI 首页和 catalog refresh 不会隐式升级已安装插件。
26. 稳定版 CLI 默认获取 `@yiliang/aw-plugins-manifest@latest`，prerelease / beta CLI 默认获取 `@yiliang/aw-plugins-manifest@beta`，兼容性通过后再获取同版本 `@yiliang/aw-plugins`；`latest` 只接受 stable catalog version 和 stable 插件 version，`beta` 只接受 prerelease catalog version 且可包含 stable 或 prerelease 插件 version，同一个 catalog version 不能跨轨道复用；`aw init`、安装、升级、重装、状态查看、发现类入口，以及需要 current catalog schema 的未安装配置入口，都能通过 `--catalog-channel <dist-tag>` 或 `--catalog-version <semver>` 显式覆盖 catalog 选择器；显式覆盖只影响当前命令或本次 `aw init` 预热，并且 JSON、verbose 输出和 TUI 状态能看见请求 selector 与实际 catalog identity。
27. 远程 catalog 不可用且没有与本次选择器匹配的有效缓存时，需要 current catalog 的安装、升级和发现类命令不能回退到 embedded catalog，必须给出 catalog unavailable。
28. 远程 catalog 可达但完整包 npm integrity、sidecar/full manifest byte-for-byte 一致性或 artifact digest 校验失败时，如果已有与本次选择器匹配的有效本地缓存且不属于必须失败的历史记录错误，可以使用 cache fallback；输出、JSON 和 TUI 必须同时暴露 `cacheFallback` 以及 `manifestMismatch` / `integrityFailure` 等原始远程校验错误，不能写入失败的远程 catalog 或 artifact。没有匹配缓存时必须失败，且不能回退到 embedded catalog。
29. `aw init` 拉取、校验并预热最新兼容 catalog/cache，不安装或升级插件，也不写 install record、active local marketplace 或平台 runtime；latest catalog 不兼容且历史记录有效、查不到历史兼容 catalog 时返回 `awVersionTooLow`；历史记录缺失、schema 不受支持、非法或不可获取时返回 `catalogHistoryUnavailable`；远程不可用或远程校验失败且没有匹配 cache 时返回 `catalogUnavailable`。
30. `config`、`diagnose`、`cleanup`、`uninstall`、`repair`、`reinstall`、主控制台和发现类入口在 current catalog unavailable 时有明确边界：可展示或处理已有本地证据的只读/清理动作可以继续；已有安装位置的 schema-aware config 在 historical schema 健康且无 schema conflict 时可以继续；`config reset` 对已消费 store 必须删除 store 后按 installed historical runtime 刷新命中的 dynamic artifact，schema conflict 时只能作为整 store 清理动作继续，孤立残留 store 才允许 raw 删除且不刷新 artifact；`uninstall` 不依赖 current catalog，但 historical runtime 缺失、摘要不可信或 legacy 证据不足时必须 fail closed 并暴露 `historicalRuntimeUnavailable` / `uninstallBlocked`；依赖 current catalog 的未安装插件配置预置、安装、升级、发现、依赖解析、`reinstall` 和选择 current catalog 版本动作必须禁用或失败；`reinstall` 不能改用 historical runtime 证据重建已安装版本，且已有安装位置需要撤销旧 lifecycle、dynamic artifact 或 native 副作用时，historical runtime 不可信必须在新安装前 fail closed。
31. Legacy install record 缺少依赖 `minVersion`、旧本地 catalog cache、非 SemVer `resolvedVersion` 等场景都有稳定用户可见状态，且不会退回字符串比较或 embedded fallback。
32. CLI 发布脚本和 catalog 发布脚本可以独立运行；catalog 发布采用 `@yiliang/aw-plugins` 完整包先就绪、`@yiliang/aw-plugins-manifest` 或正式 dist-tag 最后切换的流程；full package 已成功但 sidecar / dist-tag 失败时，同一 catalog version 的恢复重跑只能在已存在 package 与本次产物完全一致时补齐缺失侧，不能覆盖已发布 package；组合发布入口默认先发布 `@yiliang/aw`，再发布同一 catalog version 的 catalog 包。
33. CLI tarball smoke 能证明不含 embedded catalog 或完整插件 artifact；sidecar tarball smoke 能证明 `@yiliang/aw-plugins-manifest` 只含 `catalog-manifest.json` 和必要 package metadata，并带 catalog 历史版本记录及 history releases 中每个插件的 `artifactDigest` / `manifestDigest`，且 manifest 不包含自身 digest 或任一 npm tarball 的最终 integrity；catalog tarball smoke 能证明 `@yiliang/aw-plugins` 包含与 sidecar byte-for-byte 一致的完整 catalog manifest、全部构建后插件 artifact、artifact digest 和 manifest digest 元数据。
34. Catalog 发布前会读取目标发布轨道最新已发布 sidecar catalog manifest 的历史版本记录，追加本次 catalog version、catalog 最低 CLI 版本、插件 version、插件最低 CLI 版本、artifact digest 和 manifest digest；无法读取或校验目标轨道历史记录时，除目标轨道首次发布外必须失败。发布门禁还会读取官方 `latest` 和 `beta` 两条可用历史记录的并集；已存在轨道的历史记录无法读取或校验时，不能跳过跨轨道不可变校验继续发布。
35. Catalog 发布门禁会校验 catalog version 在目标发布轨道内严格递增、`latest` catalog 不含 prerelease 插件 version、sidecar/full catalog package identity 一致、两份 catalog manifest byte-for-byte 一致、同一 `plugin@version` 的 artifact digest 和 manifest digest 与官方 `latest` / `beta` 历史记录并集完全一致、插件 artifact 相对目标轨道历史变化时插件 version 严格递增、同插件不使用仅 build metadata 不同的替代版本、最低 CLI 版本合法且覆盖当前快照真实需求；任何不满足都会报错并停止发布。最低 CLI 版本低于历史 release 的门槛不是失败条件。
36. 插件作者文档、作者技能、manifest 参考文档、安装文档、安装技术细节文档、测试指南和架构文档都同步描述新的版本、兼容性、依赖最低版本、`latest` / `beta` 对插件 prerelease version 的发布约束、sidecar manifest 包、catalog 单版本快照、catalog 历史版本记录、`artifactDigest` / `manifestDigest` 不可变摘要、历史兼容 catalog 回退、catalog cache 与 active local marketplace/runtime view 分层、`aw config` schema source 优先级、`aw config reset` 的 installed-consumer / orphan-store 分支、`aw init` 预热合同，以及 CLI tarball 不再携带 embedded catalog / `plugins-dist/` 作为正式分发真值。
37. `aw init --json` 带 schema version，并稳定表达请求的 catalog channel 或显式 catalog version、catalog 选择器、实际使用的 sidecar manifest source/version/channel/integrity、实际使用的 catalog source/version/channel/minAwVersion、latest 阻止状态、历史兼容 catalog 或 cache fallback 来源、cache fallback 命中的 selector / catalog identity、历史记录 schema version，以及 `catalogUnavailable`、`awVersionTooLow`、`latestCatalogBlocked`、`catalogHistoryUnavailable`、`explicitCatalogIncompatible`、sidecar manifest unavailable、manifest mismatch、integrity 失败等阻断 code。
38. Current catalog 消费矩阵进入验收：`config`、`diagnose`、`cleanup`、`uninstall`、`repair`、`reinstall`、状态查看、主控制台、发现页和 TUI 对 sidecar manifest unavailable、manifest mismatch、integrity failure、catalog unavailable、latest 阻止、历史记录不可用、远程不可用、cache fallback、显式 selector 覆盖、`historicalRuntimeUnavailable`、`uninstallBlocked`、config schema unavailable、config schema conflict 和 `config reset` artifact refresh 的行为一致，且 JSON/TUI 暴露稳定机器状态；历史记录不可用固定映射为 `catalogHistoryUnavailable`，已确认没有兼容 catalog 固定映射为 `awVersionTooLow` 且不能被 cache fallback 覆盖，远程不可用或校验失败且没有匹配 cache 固定映射为 `catalogUnavailable`。
39. 脚手架和 `validate_plugin` 类作者工具在创建或校验阶段拒绝缺失 `compatibility.aw.minVersion`、非法插件版本、非法插件最低 CLI 版本、非法 `dependencies.plugins[].minVersion`、旧式依赖版本字段，以及插件最低 CLI 版本高于目标 catalog 级最低 CLI 版本。
40. Cache fallback 按 catalog 选择器验收：稳定版默认 `latest` 离线时不能使用 beta 缓存，prerelease / beta CLI 默认 `beta` 离线时不能使用 latest 缓存，显式 dist-tag 只命中同一 dist-tag / channel 缓存，显式 exact catalog version 只命中同一 catalog version 缓存；任一命中都必须校验 schema、integrity、channel、catalog version 和 `minAwVersion <= current CLI`。
41. `aw init --channel beta`、显式 dist-tag 或显式 exact catalog version 的预热不会污染默认 channel 的离线 fallback；安装、升级、重装、状态和发现入口使用同一 selector 时也不会污染默认 channel；JSON、verbose 诊断和 TUI 能说明本次请求 selector、命中的 cached catalog identity、fallback reason，以及缓存不是最新远程状态。
42. 需要 user-scope native runtime 的安装、升级、重装和 native repair，会在调用 Claude / Codex 原生能力前 materialize 并校验 active local marketplace/runtime view；active view 元数据能说明 selector、channel、catalog version、minAwVersion、sidecar manifest identity、digest 和写入 CLI version。切换 channel 或 exact catalog version 后，native 平台不会消费另一个 selector 的旧 active view；`aw init` 只预热 cache，不写活 native runtime。
43. 成功 `install`、`upgrade`，以及通过 current catalog 成功重建本地 artifact 的 `repair`，都会在表示成功的 record 提交前持久化可校验 historical runtime / snapshot；即使后续 current catalog 刷新到新版本、旧 catalog cache 被淘汰或机器离线，`uninstall`、只重放已安装版本的 `repair`、config schema 读取和 dynamic artifact refresh 仍能使用该 historical runtime 工作。被任何 install record、project artifact identity、dynamic diagnostic cache 或 native recovery marker 引用的 historical runtime 不会被 `aw init --force`、cache cleanup 或 catalog 轮转删除。
