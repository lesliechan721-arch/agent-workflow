# NPM 插件市场分发方案

## 背景

当前 CLI 的插件安装流程会直接改写 Claude / Codex 的配置文件，运行时又默认依赖当前仓库里的 `plugins/` 目录，导致分发、安装、升级和状态判断都和源码仓库强耦合。

这次要把插件分发切到私有 npm 包，并引入本地市场目录 `~/.aw`。安装命令只消费 npm 包内的运行时插件 bundle 和 `~/.aw` 本地镜像，不再把源码仓库当运行时输入。

## 目标

- 发布 `@yiliang/aw` 到私有 npm 仓库。
- npm 包内携带可直接安装的运行时插件 bundle。
- 首次安装或版本升级后，把内嵌插件素材初始化到 `~/.aw`。
- 任意消费仓库里，即使 `cwd` 没有本地 `plugins/` 目录，`install / uninstall / upgrade / status` 也能解析统一插件清单。
- Claude 侧尽量复用原生 marketplace / plugin 安装能力。
- Codex 侧把原生状态和 repo-managed artifacts 明确拆开。
- `status / uninstall / upgrade` 按真实状态源工作，不再靠推测。

## 非目标

- 不把 `~/.aw` 当成安装真相源。
- 不把 project `.codex/config.toml` 伪装成 Codex 原生插件安装状态。
- 不设计额外的全局 `installed.json` 去替代平台原生状态。
- 不自动改写仓库根 `AGENTS.md`。
- 不让 `status` 为了补齐 `~/.aw` 而偷偷执行初始化。

## 核心模型

### 一句话

`~/.aw` 只是本地市场镜像和运行时 bundle 缓存，不记录插件是否已安装。

CLI 后续统一按四层看状态：

1. **本地市场层**
   - `~/.aw`
   - 只负责存放 marketplace manifest、运行时插件 bundle 和初始化元数据
2. **Claude 原生层**
   - scope 声明层：当前 scope 的 `settings.json`
   - marketplace 物化层：Claude 全局 plugins 目录（默认 `~/.claude/plugins`）下的 `known_marketplaces.json` 与 `marketplaces/`
   - 安装记录层：Claude 全局 plugins 目录下的 `installed_plugins.json`
3. **Codex 原生层**
   - `~/.codex/config.toml` 里的 marketplace / plugin enabled 状态
4. **受管产物层**
   - 当前 scope 的 `.agent-workflows-manifest.json`
   - 以及它记录的 rules、hooks、agents、skills 等生成文件

### 真值矩阵

| 关注点 | 真值来源 | 说明 |
| --- | --- | --- |
| `~/.aw` 是否最新 | `~/.aw/config.json` | 只描述本地市场初始化状态 |
| Claude marketplace 是否在当前 scope 声明 | 当前 scope `settings.json` 的 `extraKnownMarketplaces` | `project` / `user` 由 settings source 决定 |
| Claude marketplace 是否已物化 | Claude 全局 plugins 目录下的 `known_marketplaces.json` 与 `marketplaces/` | 不分 project scope |
| Claude 插件是否在当前 scope 启用 | 当前 scope `settings.json` 的 `enabledPlugins` | scope 真值以 settings 为准 |
| Claude 插件是否有当前项目相关的安装记录 | Claude 全局 plugins 目录下的 `installed_plugins.json` | `project` 安装要结合 `projectPath` 判定当前项目相关性 |
| Codex marketplace 是否已注册 | `~/.codex/config.toml` | user-only |
| Codex plugin 是否已 enabled | `~/.codex/config.toml` | user-only |
| 受管扩展产物是否存在 | 当前 scope tracking manifest + 文件系统 | 逐个产物校验 drift |
| Claude `effectiveInitialized` | 当前 scope `settings.json` + 当前项目相关的 `installed_plugins.json` 记录 | `known_marketplaces.json` 用于物化 / drift 判定；tracking manifest 单独描述受管产物状态 |
| Codex `effectiveInitialized` | `~/.codex/config.toml` 与当前 scope tracking manifest 的组合 | project 只看 repo 产物是否初始化 |

## Scope 语义

### Claude

Claude 的 `user` / `project` 需要拆成“声明层”和“物化层”理解：

- `--scope user`
  - 当前用户 `settings.json` 记录 `extraKnownMarketplaces` 和 `enabledPlugins`
  - 受管扩展产物写用户目录
- `--scope project`
  - 当前项目 `settings.json` 记录 `extraKnownMarketplaces` 和 `enabledPlugins`
  - 受管扩展产物写项目目录

无论 scope 是什么，下面两类状态都仍然在 Claude 全局 plugins 目录里：

- `known_marketplaces.json` 和 marketplace cache
- `installed_plugins.json`

因此：

- `project` 不是“所有 Claude 状态都写项目目录”
- `status / uninstall / upgrade` 不能把 `known_marketplaces.json` 当成 scope 对应文件
- `project` scope 判定必须忽略 `installed_plugins.json` 里属于其他项目的记录

### Codex

Codex 继续采用 [codex-repo-managed-artifacts.md](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/docs/dev/plans/codex-repo-managed-artifacts.md) 的模型：

- `--scope user`
  - 原生 marketplace / plugin enabled 状态写 `~/.codex/config.toml`
  - user-scope instructions 写 `~/.agents/skills/aw-<plugin>/SKILL.md`
  - user-scope 其他扩展产物写 `~/.codex/`
- `--scope project`
  - repo-managed artifacts 写当前仓库的 `.agents/`、`.codex/`
  - 如插件需要 Codex 原生 plugin 能力，CLI 仍确保 `~/.codex/config.toml` 中存在对应 marketplace / plugin enabled 状态
  - 命令输出明确提示：这里触碰的是共享 user native state，不是 repo-local native state

### Codex 原生能力触发条件

本期运行时 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 直接由源码 manifest 推导，不引入额外的 build-time manifest override。

因此 `requiresNativePlugin(plugin)` 统一按源码 manifest 判定即可：

- 只要源码 manifest 声明了任一 `skills`、`mcpServers`、`apps`，结果就是 `true`
- 只声明 `extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents` 的 instruction-only 插件，结果就是 `false`

统一约束：

- `installPlugin()` 只有在 `requiresNativePlugin(plugin)` 为 `true` 时才允许写 `~/.codex/config.toml`
- `uninstallPlugin()`、`upgradePlugin()`、`status()`、`effectiveInitialized` 必须复用同一判定
- `scope=project` 且结果为 `false` 时，只生成 repo-managed artifacts，不触碰共享 user native state

### Codex 卸载规则

- `aw uninstall <plugin> --platform codex --scope project`
  - 默认只删除 repo-managed artifacts
  - 默认不删除 `~/.codex/config.toml` 里的原生 marketplace / plugin enabled
- `aw uninstall <plugin> --platform codex --scope user`
  - 删除 user scope 的原生状态和 user scope 扩展产物

### Codex `initialized` 规则

Codex 后续不再用单一原生状态推断所有 scope。内部状态至少拆成两位：

- `nativeInstalled`
  - 只看 `~/.codex/config.toml` 里的 marketplace / plugin enabled
- `artifactsInitialized`
  - 只看当前 scope tracking manifest 是否记录该插件；文件系统只用于 drift 校验

命令链路统一使用 `effectiveInitialized`：

- `scope=user`
  - `requiresNativePlugin=true` 时，以 `nativeInstalled` 为准
  - `requiresNativePlugin=false` 时，以 `artifactsInitialized` 为准
- `scope=project`
  - 以 `artifactsInitialized` 为准
  - 共享 user native state 只用于 drift 提示和必要修复，不参与 project initialized 判定

## Phase 1：npm 包与内嵌插件素材

### 1.1 发布配置

`packages/cli/package.json` 调整为可发布包：

- 移除 `"private": true`
- 增加 `files`
- 增加 `publishConfig`
- build 阶段把运行时插件 bundle 一起打进包

示意：

```json
{
  "name": "@yiliang/aw",
  "files": ["dist/", "plugins-dist/"],
  "publishConfig": {
    "registry": "https://packages.aliyun.com/5fa510142f8cc15c287b3dcd/npm/npm-registry/"
  }
}
```

### 1.2 打包脚本

新增 `packages/cli/scripts/bundle-plugins.js`，职责是把 repo `plugins/*` 下的源码插件构建成 npm 包内可直接安装的运行时插件 bundle。

固定执行链路：

1. 读取仓库根 `plugins/*` 下的源码插件
   - 输入至少包含 `.agents-plugin/plugin.json`
2. 用 `packages/cli/src/utils/manifest.ts` 按当前 schema 解析源码 manifest
3. 直接根据源码 manifest 生成 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`
4. 复制 `.agents-plugin/plugin.json` 与运行时素材
   - `skills/`
   - `mcpServers` / `apps` 指向的目录
   - `claude/`
   - `codex/`
   - `shared/`
5. 输出到 `packages/cli/plugins-dist/plugins/<plugin>`
6. 重建并重写 `packages/cli/plugins-dist/.claude-plugin/marketplace.json`
7. 重建并重写 `packages/cli/plugins-dist/.agents/plugins/marketplace.json`
8. 将市场名统一改成 `aw`
9. 把 marketplace 中的插件 `source` 固定写成相对 marketplace root 的 `./plugins/<plugin>`

### 1.3 marketplace 镜像规则

`packages/cli/plugins-dist/.claude-plugin/marketplace.json` 和 `packages/cli/plugins-dist/.agents/plugins/marketplace.json` 视为同一份 marketplace 的双入口，不引入两套不同的 `source` 语义。

明确规则：

- 两份 manifest 的每个 plugin entry 都使用同一个 `source` 字符串：`./plugins/<plugin>`
- 这个相对路径的基准目录是 marketplace root，也就是 `packages/cli/plugins-dist` 或 `~/.aw`
- `bundle-plugins.js` 生成两份 manifest 时必须保证 JSON 内容一致，只允许物理路径不同
- 现有 `packages/cli/src/utils/marketplace.ts` 的镜像一致性校验继续保留，drift 直接拒绝安装

### 1.4 输出边界

运行时只认 `plugins-dist` 与 `~/.aw`，源码树不再承担平台 manifest 的运行时职责。

明确规则：

- `bundle-plugins.js` 只生成 `packages/cli/plugins-dist/.claude-plugin/marketplace.json` 和 `packages/cli/plugins-dist/.agents/plugins/marketplace.json`
- repo 根 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json` 以及 `plugins/*/.claude-plugin/plugin.json`、`plugins/*/.codex-plugin/plugin.json` 从仓库中删除
- build 输入只认 repo `plugins/*` 下的源码 manifest 与素材
- 运行时输入只认 `plugins-dist` 和 `~/.aw`

### 1.5 唯一数据流

三层目录角色明确区分：

- repo `plugins/*`
  - 开发态源码真相源
- `packages/cli/plugins-dist/plugins/*`
  - build 后的运行时插件 bundle，也是 npm 包内的发布真相源
- `~/.aw/plugins/*`
  - 运行时 bundle 的本地镜像，只服务安装和发现

显式约束：

- `plugins-dist/plugins/*` 的目录形态必须和 `~/.aw/plugins/*` 对齐
- `aw init` 只复制和校验 `plugins-dist`，不再从源码插件二次生成
- 命令执行阶段只读取运行时 bundle；repo `plugins/*` 不参与运行时命令解析

### 1.6 路径工具

`packages/cli/src/utils/paths.ts` 新增：

- `resolveEmbeddedPluginsRoot()`
- `resolveAwHome()`
- `resolveCodexUserSkillsRoot()`

## Phase 2：本地市场 `~/.aw`

### 2.1 目录结构

`~/.aw` 只保留本地市场所需内容：

```text
~/.aw/
├── .claude-plugin/
│   └── marketplace.json
├── .agents/
│   └── plugins/
│       └── marketplace.json
├── config.json
└── plugins/
    └── git-commit/
        ├── .agents-plugin/
        │   └── plugin.json
        ├── .claude-plugin/
        │   └── plugin.json
        ├── .codex-plugin/
        │   └── plugin.json
        ├── skills/
        ├── claude/
        ├── codex/
        └── shared/
```

这里展示的是运行时插件目录，不是开发态源码目录。

### 2.2 `config.json`

`config.json` 只描述初始化元数据，不记录安装状态：

```json
{
  "version": 1,
  "sourcePackage": "@yiliang/aw",
  "sourceVersion": "0.2.0",
  "initializedAt": "2026-04-23T10:00:00.000Z"
}
```

### 2.3 `aw init`

新增 `aw init [--force]`，职责只有一件事：把包内的插件素材展开成 `~/.aw` 市场目录。

执行语义：

1. 读取 `~/.aw/config.json`
2. 如果未传 `--force`，先执行 `validateLocalMarketplaceLayout()`
3. 只有 `sourceVersion` 与当前 CLI 一致，且以下必需项全部存在并可解析时才允许跳过
   - `~/.aw/config.json`
   - `~/.aw/.claude-plugin/marketplace.json`
   - `~/.aw/.agents/plugins/marketplace.json`
   - 当前 embedded catalog 中每个插件目录，以及各自的 `.agents-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`
4. 以 staging 目录复制 `packages/cli/plugins-dist/plugins/*` 和两份 marketplace manifest
5. 按同一套完整性规则校验 staging 内容
6. 校验通过后，再原子替换 `~/.aw` 中对应内容
7. 写回 `~/.aw/config.json`

显式约束：

- `aw init --force` 不读取也不重置平台原生安装状态
- `aw init --force` 不读取也不重置任何 tracking manifest
- `ensureLocalMarketplace()` 不能只按版本号短路；同版本但缺文件、manifest 损坏或插件 bundle 不完整时，也必须重建
- `aw init` 不调用源码插件生成逻辑，只复制已经打包好的 `plugins-dist`
- `aw init` 失败时，不能把旧的 `~/.aw` 破坏到不可恢复

### 2.4 自动触发策略

- `install`、`upgrade` 在需要本地市场时调用 `ensureLocalMarketplace()`；它在返回前必须跑完同一套完整性检查，并在必要时修复同版本的损坏目录
- `status` 保持只读，不自动执行 `init`；如果 `~/.aw` 缺失或损坏，只允许回退到包内 `plugins-dist` 读取，并显式提示本地市场不可用
- `uninstall` 默认不依赖 `init`

### 2.5 共享插件目录解析

后续所有命令共用一层插件目录解析，不再假设当前 `cwd` 就是市场源仓库。

解析优先级固定为：

1. `~/.aw/plugins/*`
   - 运行时默认来源
2. 包内 `plugins-dist/plugins/*`
   - `~/.aw` 尚未初始化、损坏，或命令本身保持只读时的只读回退

显式约束：

- `install`、`uninstall`、`status`、`upgrade` 的显式插件名都走同一个解析入口
- `upgrade --all` 先从这层枚举“可识别插件集合”，再按各平台 / scope 的 initialized 规则过滤
- 消费仓库不存在本地 `plugins/` 目录时，命令行为仍必须完整可用
- 命令阶段不再对 catalog 命中的目录调用 `syncGeneratedPluginManifests()` 或等价写回逻辑
- `status` 不能写 `~/.aw`、`plugins-dist` 或 repo `plugins/`

## Phase 3：构建时生成运行时插件内容

### 3.1 源插件输入

本期只支持当前源码 manifest schema，不新增额外的 build DSL。

源插件输入由下列内容组成：

- `.agents-plugin/plugin.json`
- `skills/`
- `mcpServers` / `apps` 指向的目录
- `claude/`
- `codex/`
- `shared/`
- 其他被当前 manifest 直接引用的静态素材

`packages/cli/src/types.ts` 与 `packages/cli/src/utils/manifest.ts` 继续只表达和校验这套 schema。

### 3.2 生成职责与边界

`packages/cli/src/generators/local-plugin.ts` 只负责一件事：把源码插件构建成运行时插件目录。

输入 / 输出固定如下：

- 输入
  - repo `plugins/<name>` 下的源码 manifest 和运行时素材
- 输出
  - 目标目录下可直接安装的运行时插件 bundle
- 调用方
  - 仅 `bundle-plugins.js` 和相关测试

显式约束：

- 命令执行阶段不直接调用 `local-plugin.ts`
- `manifest.ts` 只负责源码 manifest 解析和 build-time 校验
- 运行时 bundle 一旦生成，后续安装命令只消费，不在命令链路重新渲染

### 3.3 运行时 bundle 结构

每个插件的运行时 bundle 至少包含三类内容：

1. **源清单快照**
   - `.agents-plugin/plugin.json`
2. **原生插件清单**
   - `.claude-plugin/plugin.json`
   - `.codex-plugin/plugin.json`
3. **运行时素材**
   - `skills/`
   - `claude/`
   - `codex/`
   - `shared/`
   - `mcpServers` / `apps` 指向的目录

其中 repo-managed artifacts 需要的原始素材，也作为运行时 bundle 的一部分随插件发布；`installExtensions()` 只负责把这些素材写到目标 scope，不负责在安装前临时拼装新目录。

### 3.4 Codex 的 instructions 全部改为 skill

本次执行计划统一采用：

- Codex `project` scope 下，插件的 `extensions.instructions` 转成 repo skill，落点为 `.agents/skills/aw-<plugin>/SKILL.md`
- Codex `user` scope 下，插件的 `extensions.instructions` 转成 user skill，落点为 `~/.agents/skills/aw-<plugin>/SKILL.md`
- 不把 `.codex/AGENTS.md` 或 `~/.codex/AGENTS.md` 作为插件 instructions 的目标路径
- 不自动改写仓库根 `AGENTS.md`

### 3.5 Codex repo-managed artifacts 映射

首版按下面的映射实现：

| 中立能力 | Codex 落点 |
| --- | --- |
| instructions / workflow guidance | `project` → `.agents/skills/aw-<plugin>/SKILL.md`；`user` → `~/.agents/skills/aw-<plugin>/SKILL.md` |
| permissions | `.codex/rules/*.rules` |
| command hooks | `.codex/hooks.json` |
| agents | `.codex/agents/*.toml` |

首版不再输出 Codex agent role 的 `.json` 文件。

## Phase 4：平台原生安装能力

### 4.1 Claude

Claude 侧继续以原生 CLI 为主，受管脚本只补它不原生管理的扩展产物。

`installPlugin()`：

1. 确保 `~/.aw` 已初始化
2. 调原生 marketplace add，把 marketplace 声明写到目标 scope 的 `settings.json`
3. 调原生 plugin install，把插件启用写到目标 scope 的 `settings.json`
4. 安装完成后回读三层状态
   - 当前 scope `settings.json`
   - Claude 全局 plugins 目录下的 `known_marketplaces.json`
   - Claude 全局 plugins 目录下的 `installed_plugins.json`

`installExtensions()`：

- 保留脚本补充的 `permissions`
- 其他能交给 Claude 原生插件系统加载的内容，不再维护第二份平行状态

`status()` 真值来源：

- 当前 scope `settings.json`
- Claude 全局 plugins 目录下的 `known_marketplaces.json`
- Claude 全局 plugins 目录下的 `installed_plugins.json`
- 当前 scope tracking manifest

显式约束：

- 不能把 `known_marketplaces.json` 写成“scope 对应文件”
- 不能通过 `~/.aw` 推断 Claude 是否已安装
- `project` scope 判定必须忽略 `installed_plugins.json` 里属于其他项目的记录
- `upgrade`、`uninstall` 和 `status` 都要复用同一套“当前 scope settings + 全局 materialized state + 全局 installed state”的模型

### 4.2 Codex

Codex 原生状态和 repo-managed artifacts 必须分层处理。

`installPlugin()` 只在 `requiresNativePlugin(plugin)` 为 `true` 时执行：

1. 确保 `~/.aw` 已初始化
2. 确保 `~/.codex/config.toml` 中存在 marketplace `aw`
3. 在 `~/.codex/config.toml` 中把目标插件标记为 enabled
4. 这一层始终写 user scope

如果 `requiresNativePlugin(plugin)` 为 `false`：

- 跳过对 `~/.codex/config.toml` 的任何写入
- 直接进入 `installExtensions()`

`installExtensions()`：

- `scope=user`：写 `~/.agents/skills/` 和 `~/.codex/` 下的受管产物
- `scope=project`：写当前仓库 `.agents/`、`.codex/` 下的受管产物
- 所有 repo-managed artifacts 都写 tracking manifest

`status()` 真值来源：

- 原生层：只看 `~/.codex/config.toml`
- 产物层：看当前 scope tracking manifest 和文件系统
- 对 `requiresNativePlugin(plugin)=false` 的插件，native state 必须展示为“not required”或等价语义
- 本期对受 trust 影响的 `.codex/*` 产物，只报告“文件存在 / 缺失”和相关提示文案，不实现 trusted / untrusted 生效态探测

显式约束：

- project `.codex/config.toml` 中的 plugin entry 不能作为原生安装真值
- 不能通过 `~/.aw` 推断 Codex 是否已安装
- Codex `project` scope 的 initialized 判定只看当前 repo tracking manifest，不看共享 user native state
- instruction-only Codex 插件在 `user` 和 `project` scope 下都不能平白创建或删除共享 user native state

## Phase 5：Codex 配置编辑能力

### 5.1 新增 `codex-config` 抽象

新增独立工具层，例如：

- `packages/cli/src/utils/codex-config.ts`

职责：

- 读取 `~/.codex/config.toml`
- 增删 marketplace 配置
- 增删或启停 plugin enabled 配置
- 尽量保留无关 section、字段、顺序和注释

### 5.2 首版必须支持的语义

首版只覆盖本次实现真正需要的范围：

- quoted section names
  - 例如 `[plugins."git-commit@aw"]`
- 字符串值
- 布尔值
  - `enabled = true / false`
- 删除 section 后保留其他内容不变

### 5.3 首版明确不做的能力

这次先不要求：

- 通用多行 `instructions = """..."""`
- 任意 TOML 复杂类型 round-trip 编辑
- project `.codex/config.toml` 里的 plugin 原生状态管理

## Phase 6：命令流程重写

本 phase 的硬约束是：命令执行阶段只读解析运行时插件目录，不再调用 `syncGeneratedPluginManifests()` 或任何对 catalog 根目录的就地写回逻辑。

### 6.1 install

`aw install <plugin>`

通用流程：

1. `ensureLocalMarketplace()`
2. 通过共享插件目录解析层读取显式插件名对应的插件清单
3. 解析目标平台
4. 对每个平台执行 `installPlugin()`
   - Codex instruction-only 插件在这一步显式 no-op
5. 对每个平台执行 `installExtensions()`
6. 输出平台警告

Codex `project` scope 且插件需要 native state 时，用户提示保持显式：

- 原生 plugin / marketplace 状态写 `~/.codex/config.toml`
- repo 产物写当前仓库

### 6.2 uninstall

`aw uninstall <plugin>`

显式插件名同样先走共享插件目录解析层；catalog miss 直接报错，不要求当前 `cwd` 存在本地 `plugins/` 目录。

Claude：

1. 读取当前 scope `settings.json`
2. 调原生 uninstall
3. 回读 `known_marketplaces.json` 和 `installed_plugins.json`
4. 清理 tracking manifest 记录的生成产物

Codex：

- `scope=project`
  1. 只清 repo-managed artifacts
  2. 如果插件判定为无需 native state，不触碰 `~/.codex/config.toml`
  3. 重建剩余插件的共享产物
  4. 默认保留 `~/.codex/config.toml` 的 native state
- `scope=user`
  1. 清 user scope 受管产物
  2. 仅当插件需要 native state 时清 user 原生 plugin enabled
  3. 如没有剩余引用，再清 marketplace

### 6.3 upgrade

`upgrade` 重写为两层刷新，不再只做扩展重建。

流程：

1. `ensureLocalMarketplace()`
2. 通过共享插件目录解析层枚举显式插件或 `--all` 的候选插件
3. 仅对当前 catalog 中的候选插件按平台 / scope 计算 `effectiveInitialized`
   - Claude：当前 scope `settings.json` + 当前项目相关的 `installed_plugins.json`
   - Codex `user`：`requiresNativePlugin=true` 时看 `~/.codex/config.toml`，否则看 user scope tracking manifest
   - Codex `project`：只看当前 repo tracking manifest；共享 user native state 仅作为 drift / repair 输入
4. 对已初始化插件先刷新 native state
   - Claude 刷新后必须重新读取当前 scope settings、全局 `known_marketplaces.json` 和全局 `installed_plugins.json`
5. 再重建受管产物
6. 重新做一次 status 校验并输出 drift warning

行为约束：

- 显式插件名不在当前 catalog 中时直接报错
- 未初始化插件不能被隐式 upgrade
- `--all` 只升级当前 scope 已初始化的插件，不自动初始化新插件
- `--all` 的候选集合来自共享插件目录解析层，不要求当前 `cwd` 有 `plugins/`
- 对 Codex `project` scope，只存在 shared user native state、但当前 repo 没有 tracking manifest 记录的插件，不能进入 upgrade 集合

### 6.4 status

`status` 继续保持只读：

- 不触发 `aw init`
- 不物化 marketplace
- 不修复 drift

输出按三段展示：

1. native state
2. generated artifacts
3. effective initialized

其中 Claude 的 native state 必须拆出至少三类信息：

- 当前 scope 是否声明 marketplace / enabled plugin
- 全局 `known_marketplaces.json` 是否已物化 marketplace
- 全局 `installed_plugins.json` 是否存在当前项目相关的安装记录

显式约束：

- 不要把“tracking manifest 存在”误报成“原生插件已安装”
- Claude `project` 下，其他项目留下的 `installed_plugins.json` 记录不能让当前项目误报 `initialized=yes`
- Codex `project` 下，“native 已装但 repo 未初始化”必须显式展示成分离状态，不能折叠成 `initialized=yes`
- Codex `user` 下，instruction-only 插件只要当前 scope tracking manifest 命中，就必须展示 `initialized=yes`
- 对 instruction-only Codex 插件，native state 要展示成“not required”或等价语义

### 6.5 `--platform auto|both`

平台推断继续保留当前基线的关键规则：

- `status --platform auto` 在双平台环境下继续展示两边状态，不做单平台推断
- 其他会修改状态的命令里，`--platform auto` 复用 `effectiveInitialized` 规则
- 双平台同时可用且恰好只有一个平台在当前 scope 上有 initialized 插件时，`auto` 才能稳定命中该平台
- 双平台同时可用但无法唯一推断时，`auto` 必须报错，不做静默回退
- `--platform both` 只在同时检测到两个平台时可用；单平台环境继续报错

## Phase 7：命令执行抽象与可测性

### 7.1 新增 command runner

新增例如 `packages/cli/src/utils/native-cli.ts`：

- 统一封装 `execFile` 或等价 API
- 避免直接拼接 shell 字符串
- 统一 timeout / cwd / stderr 处理
- 便于测试注入 fake runner

### 7.2 集成测试方案

两种实现二选一，优先第一种：

1. `CommandRunner` 注入 fake 实现
2. 用临时 fake binary + `PATH` 注入模拟 `claude` / `codex`

要求：

- 测试不能依赖开发机真实安装的 Claude / Codex CLI
- 测试要能断言传给原生 CLI 的命令、参数和 scope

## 涉及文件

### 新建

| 文件 | 用途 |
| --- | --- |
| `packages/cli/src/commands/init.ts` | 本地市场初始化 |
| `packages/cli/src/generators/local-plugin.ts` | 把源码插件构建成运行时插件目录，仅供 build 流程调用 |
| `packages/cli/src/utils/local-marketplace.ts` | `~/.aw` 读写与初始化 |
| `packages/cli/src/utils/plugin-catalog.ts` | 共享插件目录解析与来源优先级 |
| `packages/cli/src/utils/native-cli.ts` | 原生 CLI 调用封装 |
| `packages/cli/src/utils/codex-config.ts` | Codex `config.toml` 编辑能力 |
| `packages/cli/scripts/bundle-plugins.js` | 构建时打包插件素材 |
| `packages/cli/tests/unit/marketplace.test.ts` | 覆盖 marketplace 镜像与 `source` 规则 |

### 修改

| 文件 | 变更 |
| --- | --- |
| `packages/cli/package.json` | 发布配置与 build 脚本 |
| `packages/cli/src/index.ts` | 注册 `aw init` |
| `packages/cli/src/commands/install.ts` | 接入 `ensureLocalMarketplace()` 和新流程 |
| `packages/cli/src/commands/uninstall.ts` | 按新 scope 语义清理 |
| `packages/cli/src/commands/upgrade.ts` | 改为“原生层 + 产物层”双刷新 |
| `packages/cli/src/commands/status.ts` | 分层展示状态 |
| `packages/cli/src/commands/common.ts` | 接入共享插件解析、平台推断，并移除命令阶段 manifest 同步副作用 |
| `packages/cli/src/adapters/claude.ts` | 走原生 CLI，并按 settings / known marketplaces / installed plugins 三层读状态 |
| `packages/cli/src/adapters/codex.ts` | 接入 user-only native state + repo-managed artifacts |
| `packages/cli/src/adapters/helpers.ts` | 补齐 Claude settings、`known_marketplaces.json`、`installed_plugins.json` 的读写与解析能力 |
| `packages/cli/src/generators/instructions.ts` | Codex instructions 改生成为 project / user 两类 skill 产物 |
| `packages/cli/src/generators/agents.ts` | Codex agent role 改为 `.codex/agents/*.toml` |
| `packages/cli/src/utils/paths.ts` | `~/.aw`、bundled plugins 路径，以及 Codex project / user skill 新落点 |
| `packages/cli/src/utils/manifest.ts` | 源码 manifest 解析与运行时平台 manifest 生成输入 |
| `packages/cli/src/utils/tracking.ts` | tracking manifest 继续只追踪生成产物和初始化状态 |
| `packages/cli/src/utils/detect.ts` | 把 Codex project / user skill 落点纳入检测与平台推断 |
| `packages/cli/src/types.ts` | 类型补充，拆开 Claude / Codex 的 native 与 initialized 语义，加入 `requiresNativePlugin` 表达 |
| `packages/cli/tests/unit/manifest.test.ts` | 断言运行时真值只来自 `plugins-dist` 与运行时 bundle |
| `packages/cli/tests/unit/generators.test.ts` | 更新 Codex instructions / agents 新落点和 build-only 生成语义 |
| `packages/cli/tests/integration/cli.test.ts` | 迁移关键回归到 `plugins-dist` / `~/.aw` / skill 新模型 |
| `packages/cli/tests/unit/detect.test.ts` | 覆盖 instruction-only 插件和新 Codex project / user skill 落点检测 |
| `.agents/skills/create-agent-workflows-plugin/SKILL.md` | 同步源码 / 运行时边界和 skill 落点 |
| `.gitignore` | 忽略 `packages/cli/plugins-dist` |

### 删除

| 文件 | 变更 |
| --- | --- |
| `.claude-plugin/marketplace.json` | 从仓库移除，运行时 marketplace 只保留在 `packages/cli/plugins-dist` 与 `~/.aw` |
| `.agents/plugins/marketplace.json` | 从仓库移除，运行时 marketplace 只保留在 `packages/cli/plugins-dist` 与 `~/.aw` |
| `plugins/*/.claude-plugin/plugin.json` | 从源码树移除，平台 manifest 只在 build 输出的运行时 bundle 中生成 |
| `plugins/*/.codex-plugin/plugin.json` | 从源码树移除，平台 manifest 只在 build 输出的运行时 bundle 中生成 |

## 测试矩阵

### 单元测试

必须覆盖：

- `bundle-plugins`
  - 源码插件到运行时 bundle 的目录结构
  - `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 直接由源码 manifest 推导
  - 双 marketplace manifest 都写相同的 `./plugins/<plugin>` source
  - marketplace 只生成到 `packages/cli/plugins-dist`，不回写 repo 根
- `marketplace`
  - 双 manifest 必须字节级一致
  - plugin `source` 必须相对 marketplace root，而不是 manifest 所在目录
- `plugin-catalog`
  - `~/.aw` / `plugins-dist` 的解析优先级
  - 消费仓库没有本地 `plugins/` 时仍能解析插件
  - catalog 解析保持只读，不回写命中的插件根目录
- `tracking`
  - `artifacts` 的读写
  - `effectiveInitialized` 依赖的状态读写
- `codex-config` round-trip
  - quoted section name
  - 布尔值
  - 保留无关 section / 注释 / 顺序
- Codex instructions / agents 生成器
  - `.agents/skills/aw-<plugin>/SKILL.md`
  - `~/.agents/skills/aw-<plugin>/SKILL.md`
  - `.codex/agents/*.toml`
- `detect`
  - 只有 `.agents/skills/aw-<plugin>/SKILL.md`、没有 `.codex/*` 时，Codex `project` scope 仍可识别
  - 只有 `~/.agents/skills/aw-<plugin>/SKILL.md`、没有 native state 时，Codex `user` scope 仍可识别 instruction-only 初始化状态
- `local-marketplace`
  - `init`
  - `ensureLocalMarketplace`
  - 同版本但 marketplace manifest 或插件 bundle 缺失时自动重建
  - `--force` 重建
- Claude 状态解析
  - 当前 scope `settings.json` 的 marketplace / enabled plugin 声明
  - 全局 `known_marketplaces.json` 的物化状态
  - 全局 `installed_plugins.json` 对当前项目的相关性判断
  - 其他项目的 `project` 安装记录不会污染当前项目状态
- `native-cli`
  - 参数构造
  - 超时 / 错误传播

### 集成测试

必须保留并迁移的关键回归场景：

- Claude marketplace 物化刷新
- Claude 手写 permissions 保留
- Codex 多插件共享产物汇聚
- Codex 保留无关原生配置
- 外部同名插件保护
- marketplace mirror drift 拒绝安装
- `--platform auto|both` 平台解析规则
- `upgrade --all` 不隐式初始化未安装插件
- `status` 只读

新增必须覆盖：

- `bundle-plugins.js` 产出的 `plugins-dist` 与 `~/.aw` 目录形态一致，`aw init` 只复制不二次生成
- `bundle-plugins.js` 只生成 `packages/cli/plugins-dist/.claude-plugin/marketplace.json` 和 `packages/cli/plugins-dist/.agents/plugins/marketplace.json`，不回写 repo 根 marketplace
- 两份 marketplace manifest 保持字节级一致，且 plugin `source` 都是相对 marketplace root 的 `./plugins/<plugin>`
- `aw init --force` 不清空任何原生安装状态或 tracking manifest
- `sourceVersion` 一致但 `~/.aw` 缺 marketplace manifest 时，`install` / `upgrade` 会先自动修复再继续
- `sourceVersion` 一致但某个插件 bundle 缺文件时，`install` / `upgrade` 会先自动修复再继续
- 消费仓库没有本地 `plugins/` 目录时，`install / status / uninstall / upgrade` 仍能解析插件清单
- Claude `project` 安装时，scope 声明写 project settings，但 `known_marketplaces.json`、marketplace cache 和 `installed_plugins.json` 仍写全局 plugins 目录
- Claude `status`、`upgrade --all`、`uninstall` 会同时参考当前 scope settings、全局 `known_marketplaces.json` 和全局 `installed_plugins.json`
- Claude `project` 下，其他项目留下的安装记录不会让当前项目误报已初始化
- Codex `project` 安装在 `requiresNativePlugin=true` 时会写 user native state + repo-managed artifacts
- Codex `project` 安装生成 `.agents/skills/aw-<plugin>/SKILL.md`，Codex `user` 安装生成 `~/.agents/skills/aw-<plugin>/SKILL.md`
- instruction-only 插件只生成 `.agents/skills/aw-<plugin>/SKILL.md` 时，`detect`、`status`、`--platform auto|both` 仍能正确识别 project scope
- instruction-only Codex 插件在 `user` 安装 / 卸载 / 状态下不改 `~/.codex/config.toml`，并通过 `~/.agents/skills/aw-<plugin>/SKILL.md` 判定 initialized
- instruction-only Codex 插件在 `project` 安装 / 卸载时不改 `~/.codex/config.toml`
- Codex agent role 落到 `.codex/agents/*.toml`，卸载后由 tracking manifest 正确清理
- Codex `project` 卸载默认不删除 user native state
- 跨 repo project scope 隔离
  - repo A 已安装 project 插件
  - repo B 未安装时，`status`、`upgrade --all`、`--platform auto` 都不能误报
- project `.codex/config.toml` 中伪造的 plugin entry 不会被当成原生安装真值
- `status` 不会写 repo `plugins/` 或包内 `plugins-dist`
- `install` / `upgrade` 除 `~/.aw` 外，不会回写 catalog 根目录
- fake CLI 调用链可验证，不依赖本机真实二进制

## 实施顺序

1. 发布与打包链路
   - `package.json`
   - `local-plugin.ts`
   - `bundle-plugins.js`
   - `plugins-dist`
   - 删除 repo 根 marketplace 和源码树平台 generated manifest
2. `~/.aw` 本地市场
   - `aw init`
   - `ensureLocalMarketplace()`
   - 完整性校验
   - staging + 原子替换
3. 共享插件目录解析与只读边界
   - `plugin-catalog`
   - marketplace mirror 一致性校验
   - 命令阶段移除 `syncGeneratedPluginManifests()` 副作用
4. 原生 CLI 调用抽象
   - `native-cli.ts`
   - fake runner / fake binary 测试基础设施
5. Claude 新流程
   - 三层状态模型
   - install / uninstall / upgrade / status
6. Codex 新流程
   - `codex-config`
   - `requiresNativePlugin`
   - user-only native state
   - repo-managed artifacts
   - `detect.ts` 新落点识别
7. 命令串联与状态输出
   - `install`
   - `uninstall`
   - `upgrade`
   - `status`
   - `--platform auto|both`
8. 回归测试补齐

## 验收标准

- `plugins-dist/plugins/*` 是运行时插件 bundle，`aw init` 只镜像复制，不从源码插件二次生成
- `bundle-plugins.js` 只在 `packages/cli/plugins-dist` 下生成 marketplace 与运行时 bundle，不再把 repo 根或源码树 generated manifest 当成运行时真值
- 两份 marketplace manifest 保持字节级一致，且 plugin `source` 统一为相对 marketplace root 的 `./plugins/<plugin>`
- `aw init --force` 只重建 `~/.aw`，不影响既有安装状态
- `ensureLocalMarketplace()` 在 `sourceVersion` 相同但本地目录损坏时仍会自动修复；`status` 只读回退到 `plugins-dist`
- 消费仓库没有本地 `plugins/` 目录时，四个核心命令仍能解析插件
- Claude 的状态判断按三层工作
  - 当前 scope `settings.json`
  - 全局 `known_marketplaces.json`
  - 全局 `installed_plugins.json`
- Claude `project` scope 不再声称“原生状态都在项目目录”
- Codex `project` scope 不再声称“原生安装到 repo”
- Codex `project` scope 的 initialized 只由当前 repo tracking manifest 决定，不受共享 user native state 误导
- instruction-only Codex 插件不会改写 `~/.codex/config.toml`
- Codex instructions / agents 的落点固定为 project `.agents/skills/aw-<plugin>/SKILL.md`、user `~/.agents/skills/aw-<plugin>/SKILL.md` 和 `.codex/agents/*.toml`
- instruction-only 插件仅生成 skill 产物时，Codex `project` / `user` scope 都能被正确检测和展示
- 命令执行阶段不会回写 repo `plugins/` 或包内 `plugins-dist`
- `status` 能分清 native state、generated artifacts 和 effective initialized
- `upgrade` 能同时刷新 native state 与受管产物
- `--platform auto|both` 继续遵守当前平台推断规则
- 测试不依赖本机真实 Claude / Codex CLI
