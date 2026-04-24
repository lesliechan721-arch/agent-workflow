# NPM 插件市场分发方案

## 背景

当前 CLI 的插件安装流程同时存在几类问题：

- 运行时默认依赖当前仓库里的 `plugins/` 目录，分发、安装、升级和状态判断都和源码仓库耦合
- Claude / Codex 的原生状态、CLI 自己生成的扩展产物、以及本地市场缓存混在一起，`status`、`upgrade`、`uninstall` 很难说清“到底什么才算已安装”
- 需要支持按 agent 差异化生成插件内容，但生成发生在 `aw init` 或命令阶段会让运行时链路过重
- 需要一层 CLI 管理账本来承载 scope 归属、Codex shared native 引用，以及幂等优化和调试信息，但它不能和平台原生真值混用

本文给出一套可实现、可测试的执行方案，明确运行时边界、状态模型和构建职责。

## 当前约束

服务还处在开发阶段，这次调整直接以新结构为准。

- `current catalog` 输入只认 `embedded plugins root` 与 `~/.aw`
- `current catalog` 真值只认 build 产出的 marketplace manifest 和 plugin bundle，不把源码树里的 generated manifest 当输入
- Claude / Codex 的“是否已安装、当前 scope 是否启用”仍各自读取原生状态；`installed.json` 只做 CLI 管理账本
- 对本方案固定的 Claude 本地目录 marketplace，`known_marketplaces.json.installLocation` 会指向 `~/.aw`，默认 startup 的 cache-only loader 也会按该目录和相对 `source` 解析本地插件
- 本文定义这版目录布局，以及新方案上线后正常包版本中的 catalog 生命周期语义；schema 演进策略另行设计，不做跨 schema 迁移兼容
- `~/.aw` 只保留当前 schema；目录损坏或结构非法时直接按新模型重建
- 当前 CLI 只对当前包内 catalog 负责
- 当前“不考虑迁移兼容”只针对以下切换前基线状态：
  - 仓库根 `.claude-plugin/marketplace.json`
  - 仓库根 `.agents/plugins/marketplace.json`
  - 源码树 `plugins/*/.claude-plugin/plugin.json`
  - 源码树 `plugins/*/.codex-plugin/plugin.json`
  - 任何把源码仓库 `plugins/*` 当成运行时 catalog / marketplace 真值的状态
  - 任何不符合本文 schema 的 `~/.aw` 目录布局、`config.json`、`installed.json`
- 下文提到的“切换前基线状态”都只指上面这 6 类，不扩展到新方案上线后的正常包版本升级
- `~/.aw/config.json` 里的 `sourceVersion` 只记录来源 npm 包版本；`bundleFingerprint` 才是判断本地 marketplace bundle 是否与当前 embedded bundle 同步的内容级标识；二者都不是 schema 迁移边界

## 核心变更概览

| 维度 | 当前 | 目标 |
|------|------|------|
| 分发渠道 | 源码仓库 `plugins/*` | 私有 npm 包 `@yiliang/aw` |
| 运行时输入 | 当前仓库 `plugins/*` + 命令阶段补写 manifest | `embedded plugins root` 与 `~/.aw` |
| 本地市场角色 | 运行时和安装状态混用 | 承担 current catalog 镜像与本地 bundle 目录，安装状态仍单独看平台原生状态和管理账本 |
| 插件内容生成 | 源码树里已有平台清单，运行时仍可能重写 | build 阶段一次性生成运行时 bundle，命令阶段只读消费 |
| Claude 状态判断 | 容易混淆 scope settings 与全局 plugins 目录 | 拆成 `settings.json`、`~/.claude/plugins/known_marketplaces.json`、`~/.claude/plugins/installed_plugins.json` 三层 |
| Codex scope 语义 | 容易把 `project` 误解成 repo-local native install | `project` 只代表 repo-managed artifacts；native marketplace / plugin enabled 仍是 user-only |
| Codex repo-managed 可见性 | 假设 `config.toml.instructions` 会进入真实会话，且产物存在就等于生效 | instructions 改写到 `developer_instructions`；`developer_instructions`、`rules`、`hooks`、`agents` 都按 project trust 和 enabled layer 计算会话可见性 |
| 差异化能力 | 运行时链路仍有二次生成和重写风险 | 通过 `buildConfig` 在 build 阶段生成 per-agent bundle |
| 安装元数据 | 安装元数据与平台真值边界不清 | `installed.json` 作为 CLI 管理账本，不作为平台真值来源 |

---

## Agent 原生 CLI 命令参考

### Claude Code 安装流程

Claude 走原生 marketplace / plugin 安装链路：

```bash
# 第1步：注册本地市场
claude plugin marketplace add ~/.aw --scope <scope>

# 第2步：从市场安装插件
claude plugin install git-commit@aw --scope <scope>
```

内部语义要分三层理解：

- `marketplace add <dir>` 会把 marketplace 声明写进目标 scope 的 `settings.json`
- Claude 的全局 plugins 目录固定为 `~/.claude/plugins`，负责维护 `known_marketplaces.json`、marketplace cache 和 `installed_plugins.json`
- `plugin install <name>@<market>` 会把插件启用状态写进目标 scope 的 `settings.json`，并在 `~/.claude/plugins` 写入 `installed_plugins.json`
- marketplace 声明的 scope 跟随本次目标安装 scope；`project` 安装不能预设 marketplace 固定只写 `user`
- 对本方案这类本地目录 marketplace，`known_marketplaces.json.installLocation` 固定指向 `~/.aw`
- marketplace entry 的 `source` 固定为 `./plugins/<plugin>` 时，Claude 默认 startup 的 cache-only loader 会按 `installLocation + source` 直接解析本地插件目录
- `installed_plugins.json` 仍保留安装元数据和 project 相关性记录，但不单独决定当前本地 bundle 内容

因此：

- `project` scope 并不意味着“所有原生状态都写项目目录”
- `status / uninstall / upgrade` 不能只看某一个文件
- `project` scope 的状态判断必须忽略 `installed_plugins.json` 里属于其他项目的记录

**卸载**：

```bash
claude plugin uninstall git-commit@aw --scope project
```

CLI 需要在卸载前后重新回读：

- 当前 scope `settings.json`
- `~/.claude/plugins/known_marketplaces.json`
- `~/.claude/plugins/installed_plugins.json`

### Codex 安装流程

Codex 的原生 marketplace / plugin enabled 仍是 user-only：

```bash
# 第1步：注册本地市场
codex plugin marketplace add ~/.aw

# 第2步：启用插件
# ~/.codex/config.toml
# [plugins."git-commit@aw"]
# enabled = true
```

Codex 本地 marketplace 的 `~/.codex/config.toml` 目标结构必须对齐上游 `record_user_marketplace()` 的 local-source 语义：

```toml
[marketplaces.aw]
last_updated = "2026-04-24T00:00:00Z"
source_type = "local"
source = "/abs/path/to/.aw"
```

其中 `source` 必须是 `~/.aw` 的 canonical directory path，不能写成 `.agents/plugins/marketplace.json` 文件路径；`source_type = "local"` 缺失时，上游会按默认安装目录解析，不再把 `source` 当本地目录 root。

但 Codex 需要先区分插件类型：

- **需要原生 plugin 能力的插件**：经过校验后的源码 manifest 显式声明了任一 `skills`、`mcpServers`、`apps`
- **instruction-only 插件**：只声明 `extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents`

这里的 `instruction-only` 只用于 Codex native 能力判定，表示“不需要 Codex 原生 plugin 状态”；它不否认同一份源码插件在 Claude 侧仍可把 `extensions.hooks` / `extensions.agents` 映射进原生 runtime manifest。

统一规则：

- `requiresNativePlugin(plugin) = true` 时，CLI 才允许写 `~/.codex/config.toml`
- `requiresNativePlugin(plugin) = false` 时，不创建也不删除共享 user native state
- Codex native 能力只认 manifest 的显式声明，不做运行时文件系统隐式推导
- 源码插件目录里如果存在默认 `skills/`、`.mcp.json`、`.app.json`，但 manifest 没声明对应字段，直接视为非法输入
- build 阶段生成的 `.codex-plugin/plugin.json` 必须把 native 路径写成显式字段，运行时不依赖 Codex 的默认根目录约定
- `--scope project` 只对存在 repo-managed artifacts 的 Codex 插件开放
- 只声明 `skills`、`mcpServers`、`apps`，但没有任何 `extensions.*` 的 native-only 插件，必须使用 `--scope user`
- `--scope project` 安装时，如插件既需要原生 plugin 能力、又存在 repo-managed artifacts，CLI 可以同时做两件事
  - 写共享 user native state：`~/.codex/config.toml`
  - 写 repo-managed artifacts：当前仓库 `.agents/`、`.codex/`
- `extensions.instructions` 不写 `config.toml.instructions`，统一走 `developer_instructions`
- `developer_instructions` 在上游配置层按高优先级整体覆盖；当前 repo `.codex/config.toml` 一旦定义该字段，就会遮蔽 `~/.codex/config.toml` 的同字段

**卸载 / 禁用**：

- `aw uninstall <plugin> --platform codex --scope project`
  - 默认只删除当前仓库的 repo-managed artifacts
  - 默认不删除 `~/.codex/config.toml` 里的共享 native state
- `aw uninstall <plugin> --platform codex --scope user`
  - 删除 user scope 受管产物
  - 仅在安装时快照或当前兼容 manifest 表明该插件需要 native state 时，才考虑删除 native plugin enabled

---

## Phase 1: npm 发布改造

这个 phase 不是单纯补发布脚手架。凡是会决定 runtime bundle 目录结构、`buildConfig` schema、manifest contract 和 `local-plugin.ts` 输出语义的内容，都要和这里同批落地；后文 Phase 4 只是按主题展开这些 contract 细节。

### 1.1 配置私有 npm 仓库

Registry 保持：

`https://packages.aliyun.com/5fa510142f8cc15c287b3dcd/npm/npm-registry/`

通过 `publishConfig` 控制发布目标，无需额外维护 repo 级 `.npmrc`。

### 1.2 调整 `packages/cli/package.json` 与仓库根验证入口

目标：

- 移除 `"private": true`
- 添加 `files`
- 添加 `publishConfig`
- 添加 `prepack`
- 让 build 脚本只执行编译后的产物，不直接从 JS 脚本 import `src/**/*.ts`
- build 阶段同时产出 CLI 与运行时插件 bundle

示意：

```json
{
  "name": "@yiliang/aw",
  "version": "0.2.0",
  "type": "module",
  "bin": { "aw": "./dist/index.js" },
  "files": ["dist/", "plugins-dist/"],
  "publishConfig": {
    "registry": "https://packages.aliyun.com/5fa510142f8cc15c287b3dcd/npm/npm-registry/"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && node dist/scripts/bundle-plugins.js",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:smoke": "vitest run tests/smoke",
    "test:smoke:build": "vitest run tests/smoke/build-smoke.test.ts",
    "test:smoke:pack": "vitest run tests/smoke/pack-smoke.test.ts",
    "prepack": "pnpm build"
  }
}
```

同时调整 `packages/cli/tsconfig.json`：

- 把 `scripts/**/*.ts` 纳入编译输入
- `bundle-plugins` 的源码文件参与 `tsc`，运行时只执行 `dist/scripts/bundle-plugins.js`

同时调整仓库根 `package.json`，把仓库级验证入口统一代理到 `@yiliang/aw`，避免命令误落到 workspace root 包本身：

```json
{
  "scripts": {
    "build": "pnpm --filter @yiliang/aw build",
    "test": "pnpm --filter @yiliang/aw test",
    "test:unit": "pnpm --filter @yiliang/aw test:unit",
    "test:integration": "pnpm --filter @yiliang/aw test:integration",
    "test:coverage": "pnpm --filter @yiliang/aw test:coverage",
    "test:smoke": "pnpm --filter @yiliang/aw test:smoke",
    "test:smoke:build": "pnpm --filter @yiliang/aw test:smoke:build",
    "test:smoke:pack": "pnpm --filter @yiliang/aw test:smoke:pack",
    "pack:cli": "pnpm --filter @yiliang/aw pack"
  }
}
```

执行约定：

- 仓库根 `package.json` 继续保持 private workspace package，不参与发布
- 文中所有仓库级验证命令默认都在 repo root 执行；`packages/cli/package.json` 里的脚本是实现入口，root script 是统一代理入口
- tarball 验证统一使用 `pnpm pack:cli`，不再使用会命中 workspace root 的裸 `pnpm pack`

同时调整 `packages/cli/vitest.config.ts`：

- 默认 `include` 只覆盖 `tests/unit/**/*.ts` 与 `tests/integration/**/*.ts`
- `tests/smoke/**/*.ts` 只通过专用 npm script 执行，不进入 `pnpm test`、`pnpm test:integration`

测试 / 开发约定：

- `pnpm test`、`pnpm test:unit`、`pnpm test:integration` 这些 repo root 入口保持 build-free，不隐式执行 `pnpm build`
- `build-smoke`、`pack-smoke` 固定放在 `packages/cli/tests/smoke/**`，只由 repo root `pnpm test:smoke*` 执行，不进入常规测试集合
- `codex-config-smoke.test.ts` 虽然名字叫 smoke，但属于 build-free round-trip gate，仍放在常规测试集合
- 依赖 runtime bundle 的 Vitest 用例通过共享测试 helper 生成临时 synthetic `embedded plugins root`，再经 `resolveEmbeddedPluginsRoot()` 的内部 override 注入；测试不得回退到 repo 根 marketplace 或源码树 generated manifest
- 文档、CI 和人工验收统一走 repo root 代理入口，不再混用 `cd packages/cli` 与裸 workspace 命令
- 只有 repo root `pnpm build` / `pnpm pack:cli` smoke，以及源码仓库里“已 build 的 CLI”才消费真实 `packages/cli/plugins-dist`
- `dist/scripts/bundle-plugins.js` 的真实执行边界只放在 `pnpm build` / `tests/smoke/**` 校验；build-free 测试只覆盖 source-level bundle contract

### 1.3 构建时打包插件数据

新增 `packages/cli/scripts/bundle-plugins.ts`，职责是把 repo `plugins/*` 下的源码插件构建成 npm 包内可直接安装的运行时 bundle。

固定执行链路：

1. `tsc -p tsconfig.json` 先把 `src/**/*.ts` 与 `scripts/**/*.ts` 编译到 `dist/`
2. 执行 `node dist/scripts/bundle-plugins.js`
3. `bundle-plugins` 只 import 已编译的 `dist/src/**` 模块
4. `bundle-plugins.ts` 先用 Node / `fs-extra` 清空并重建 `packages/cli/plugins-dist`
5. 读取仓库根 `plugins/marketplace-source.json`
6. 读取仓库根 `plugins/*/.agents-plugin/plugin.json`
7. 用 `packages/cli/src/utils/manifest.ts` 解析 marketplace root metadata、源码 manifest 与每个插件的 `marketplace` entry metadata
8. 调用 `packages/cli/src/generators/local-plugin.ts`
9. 按源码 manifest、`marketplace` entry metadata 和 `buildConfig` 生成运行时插件目录
10. 输出到 `packages/cli/plugins-dist/plugins/<plugin>`
11. 用 `plugins/marketplace-source.json` 的 root metadata 和各插件派生出的 entry metadata 重建并写入两份 marketplace manifest
12. 将市场名统一改为 `aw`
13. 将 marketplace 中的 `source` 固定写为相对 marketplace root 的 `./plugins/<plugin>`

术语统一：

- `packages/cli/plugins-dist` 只表示源码仓库里的 build 输出目录
- npm 包安装后，CLI 运行时读取的入口统一称为 `embedded plugins root`
- 在 tarball 或已安装包里，`embedded plugins root` 对应包根目录下的 `plugins-dist`

关键约束：

- `buildConfig` 只在 build 阶段消费
- `aw init` 不再调用插件生成逻辑
- 命令执行阶段只读消费运行时 bundle
- `bundle-plugins.ts` 自己负责以跨平台方式清空并重建输出目录；build contract 不依赖 shell 层清理命令
- `plugins/marketplace-source.json` 只承载 marketplace root 级源码元数据，不是运行时 manifest
- `.agents-plugin/plugin.json.marketplace` 是 plugin entry 级源码输入；`bundle-plugins.ts` 不得回读旧 repo 根 runtime marketplace 去补字段

### 1.4 运行时 marketplace 镜像规则

`packages/cli/plugins-dist/.claude-plugin/marketplace.json` 与 `packages/cli/plugins-dist/.agents/plugins/marketplace.json` 视为同一份 marketplace 的双入口。

明确规则：

- marketplace `name` 固定为 `aw`；`owner`、`interface` 等 root metadata 来自 `plugins/marketplace-source.json`
- 两份 manifest 的 plugin entry 都使用相同的 `source`：`./plugins/<plugin>`
- 每个 plugin entry 除 `source` 外，还要按同一套源码 contract 写出 entry metadata：顶层 `description` / `interface`，以及 `marketplace.category` / `tags` / `strict` / `policy`
- 这个相对路径的基准目录是 marketplace root，而不是 manifest 所在目录
- 生成两份 manifest 时必须保持 JSON 语义一致
- marketplace mirror 一致性校验生效，drift 直接拒绝安装

### 1.5 输出边界

运行时只认两层目录：

- `embedded plugins root`
- `~/.aw`

显式约束：

- repo 根 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json` 不再作为运行时真值
- `plugins/*/.claude-plugin/plugin.json`、`plugins/*/.codex-plugin/plugin.json` 不再在源码树里维护 generated 版本
- build 输入只认源码 manifest 和源码素材
- CLI 不能硬编码 repo-relative 的 `packages/cli/plugins-dist/...`
- 命令阶段只能通过 `resolveEmbeddedPluginsRoot()` 定位 npm 包内的 runtime bundle
- 运行时输入只认 `embedded plugins root` 与 `~/.aw`

### 1.6 新增路径工具

`packages/cli/src/utils/paths.ts` 新增：

- `resolveEmbeddedPluginsRoot()`
  - 先支持一个仅供测试 / smoke harness 使用的内部 override；命中时也要走同一套布局校验
  - 源码仓库里已 build 的 CLI 运行场景返回 `packages/cli/plugins-dist`
  - npm 包 / tarball 场景返回包根目录下的 `plugins-dist`
  - 未命中 override 且源码仓库 `packages/cli/plugins-dist` 缺失或损坏时，命令直接报显式错误并要求先 `pnpm build`
  - 其余命令不允许绕过它直接拼接运行时 bundle 路径，也不允许回退到 repo 根 marketplace / 源码树 generated manifest
- `resolveAwHome()`
- `resolveClaudePluginsDir()`，固定返回 `~/.claude/plugins`
- 补充 Codex project / user `config.toml` 路径解析

---

## Phase 2: 本地插件市场（~/.aw）

这个 phase 默认建立在 Phase 1 已经冻结 build-time contract 的前提上。`aw init`、`ensureLocalMarketplace()` 和 `validateLocalMarketplaceLayout()` 不接受“先生成一版临时 bundle，后面再整体返工”的中间态。

### 2.1 目录结构设计

`~/.aw` 同时满足 Claude Code 和 Codex 的 marketplace 发现约定，但它不承担“真实安装状态”的职责。

```text
~/.aw/
├── .claude-plugin/
│   └── marketplace.json
├── .agents/
│   └── plugins/
│       └── marketplace.json
├── config.json
├── installed.json
└── plugins/
    └── git-commit/
        ├── .agents-plugin/
        │   └── plugin.json
        ├── .claude-plugin/
        │   └── plugin.json
        ├── .codex-plugin/
        │   └── plugin.json
        ├── claude/
        │   ├── skills/
        │   ├── commands/
        │   ├── agents/
        │   └── hooks/
        ├── codex/
        │   └── skills/
        └── shared/ (optional)
            └── config/
```

关键约定：

- `.claude-plugin/plugin.json` 路径指向 `./claude/...`
- `.codex-plugin/plugin.json` 路径指向 `./codex/...`
- Claude / Codex 的差异化内容已经在 build 阶段生成完毕
- `shared/` 只作为 build 内部复用的可选静态资源目录；首版 public runtime contract 不允许 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` 直接指向 `./shared/**`

### 2.2 `config.json` 格式

`config.json` 描述本地市场初始化与 freshness 元数据：

```json
{
  "version": 1,
  "initializedAt": "2026-04-23T10:00:00.000Z",
  "sourcePackage": "@yiliang/aw",
  "sourceVersion": "0.2.0",
  "bundleFingerprint": "sha256:4fd0..."
}
```

补充约定：

- `config.json.version` 表示本地市场元数据 schema 版本
- `sourceVersion` 记录来源 npm 包版本，用于诊断、提示和跨版本刷新判断
- `bundleFingerprint` 表示当前 embedded bundle 的内容级指纹；至少覆盖两份 marketplace manifest 与 `plugins/**` 运行时文件，并按稳定相对路径顺序计算
- `aw init`、`ensureLocalMarketplace()`、`status` 只有在 `sourceVersion` 与 `bundleFingerprint` 都和当前 embedded bundle 对齐，且 `validateLocalMarketplaceLayout()` 通过时，才把 `~/.aw` 当成新鲜副本
- 当前“不考虑迁移兼容”针对的是上面枚举的切换前基线状态；不代表新方案未来每次 `sourceVersion` 或 `bundleFingerprint` 变化都要丢弃账本

### 2.3 `installed.json` —— CLI 管理账本

`installed.json` 仍然不是 Claude / Codex 的平台真值，但它不再只是“最近一次请求的辅助元数据”。首版把它定义成 CLI 自己维护的安装账本，承担两类职责：

- 记录 Claude / Codex 当前仍受 CLI 管理的 scope 安装集合
- 记录 Codex 各插件 shared user plugin enabled 的引用关系；`[marketplaces.aw]` 的删除再按全账本扫描判定

示意：

```json
{
  "version": 1,
  "ledgerState": {
    "status": "available",
    "degradedAt": null,
    "reason": null
  },
  "plugins": {
    "git-commit": {
      "lastResolvedVersion": "0.1.0",
      "platforms": {
        "claude": {
          "userScope": {
            "managed": true,
            "updatedAt": "2026-04-23T10:00:00.000Z",
            "resolvedVersion": "0.1.0",
            "capabilitySnapshot": {
              "managedExtensions": ["permissions"]
            }
          },
          "projectScopes": {
            "/abs/claude-project-key": {
              "managed": true,
              "updatedAt": "2026-04-23T10:00:00.000Z",
              "resolvedVersion": "0.1.0",
              "capabilitySnapshot": {
                "managedExtensions": ["permissions"]
              }
            }
          },
          "lastRequestedScope": "project",
          "lastRequestedAt": "2026-04-23T10:00:00.000Z"
        },
        "codex": {
          "userScope": {
            "managed": true,
            "updatedAt": "2026-04-23T10:00:00.000Z",
            "resolvedVersion": "0.1.0",
            "capabilitySnapshot": {
              "requiresNativePlugin": true,
              "hasRepoManagedArtifacts": true
            }
          },
          "projectScopes": {
            "/abs/codex-project-key": {
              "managed": true,
              "updatedAt": "2026-04-23T10:00:00.000Z",
              "resolvedVersion": "0.1.0",
              "capabilitySnapshot": {
                "requiresNativePlugin": true,
                "hasRepoManagedArtifacts": true
              }
            }
          },
          "sharedNativeRefs": {
            "user": true,
            "projects": ["/abs/codex-project-key"]
          },
          "lastRequestedScope": "project",
          "lastRequestedAt": "2026-04-23T10:00:00.000Z"
        }
      }
    }
  }
}
```

关键约定：

- Claude ledger 的 `claudeProjectKey` 取与上游当前 project 边界同语义的绝对路径字符串：`settings.json` root 侧对齐 `resolve(getOriginalCwd())`，`installed_plugins.json.projectPath` 侧对齐 `getOriginalCwd()` 原值；两者在上游当前启动语义下都指向同一 canonical real path。CLI 不能再叠加第二层 canonical 化，也不能退回 raw cwd
- Claude 侧如需展示用户启动时输入的 raw cwd / symlink alias，只能作为诊断字段，不能参与 `projectScopes[claudeProjectKey]`、`scopeInitialized` 或 `installed_plugins.json.projectPath` 相关性判断
- Codex ledger 的 `codexProjectKey` 取当前 repo root 的 realpath；如 realpath 失败，退回规范化后的绝对路径。它只给 Codex scope ledger、tracking manifest 与 `sharedNativeRefs.projects` 使用，不参与 Claude 原生 project 相关性判断
- `ledgerState.status` 只取 `available`、`degraded`
- `ledgerState.reason` 首版至少覆盖 `rebuilt_from_missing_or_invalid`、`operation_interrupted_after_native_write` 与 `operation_interrupted_after_artifact_write`
- `scopeInitialized` 对外暴露为三态：`yes`、`no`、`unknown`
- Claude / Codex 都维护自己的 scope ledger；Claude 用 `projectScopes[claudeProjectKey]`，Codex 用 `projectScopes[codexProjectKey]` 作为 `scopeInitialized` 的直接来源
- `ledgerState.status = available` 时，显式 scope 记录按 `managed` 字段解释为 `yes` / `no`；缺失记录才允许解释为 `no`
- `ledgerState.status = degraded` 时，只有账本里显式存在的 scope 记录才能给出 `yes` / `no`；缺失记录一律显示 `unknown`
- `scopeInitialized` 只表达“这个 scope 是否仍在 CLI 受管集合里”，来源是 `installed.json` 的 scope ledger，不能再从 `nativeInstalled` 或共享 native state 反推
- Claude 的 `lastRequestedScope` / `lastRequestedAt` 只保留作诊断信息，不能代替当前 scope ledger
- Claude 的 project ledger key 不能再退化成 repo root；同一仓库不同子目录的 `--scope project` 安装必须保持独立记录
- `sharedNativeRefs` 只用于 Codex 当前插件自己的 shared user plugin enabled 回收判定与 drift 提示，不能把它当成 user scope 已安装，也不能单独授权删除 `[marketplaces.aw]`
- `platforms.claude.userScope` / `projectScopes[claudeProjectKey]` 中的 `resolvedVersion` 与 `capabilitySnapshot.managedExtensions` 表示该 scope 最近一次成功安装或显式升级时的“安装时快照”
- `platforms.codex.userScope` / `projectScopes[codexProjectKey]` 中的 `resolvedVersion` 与 `capabilitySnapshot` 表示该 scope 最近一次成功安装或显式升级时的“安装时快照”
- Claude `capabilitySnapshot.managedExtensions` 只描述需要 install/uninstall reconcile 的历史副作用集合：`extensions.instructions`、`extensions.permissions`
- Codex `capabilitySnapshot.requiresNativePlugin` 与 `capabilitySnapshot.hasRepoManagedArtifacts` 只描述历史安装语义，不能被当前 catalog 的 manifest 反向改写
- 命令层必须同时区分 `current catalog capabilities` 与 `installed capability snapshot`；两者不一致时要显式进入跨版本受控路径
- `catalogCompatibility` 是运行时派生状态，对外只暴露 `current`、`missing`、`capabilityChanged` 三态
- `当前 scope 受管证据` 必须按 scope-sensitive 规则判定，不能复用裸 `sharedNativeRefs`
  - Claude：当前 scope ledger 或当前 scope tracking manifest
  - Codex `scope=user`：`userScope` ledger、user scope tracking manifest、`sharedNativeRefs.user = true`
  - Codex `scope=project`：`projectScopes[codexProjectKey]`、当前 repo tracking manifest、`sharedNativeRefs.projects` 明确包含当前 `codexProjectKey`
- `sharedNativeRefs.projects` 里属于其他 repo 的记录，只能说明“别的 repo 仍在引用 shared native state”，不能让当前 repo 的 `status`、`uninstall`、显式 `upgrade <plugin>` 进入历史受管路径
- `platformRuntimeEvidence` 只在 Claude 账本 / tracking manifest 缺口时保守启用，用来表达“默认 startup loader 仍会读取 `<plugin>@aw>`”
  - Claude：当前 scope `settings.json` 仍启用 `<plugin>@aw`，`known_marketplaces.json` 中 `aw.installLocation` 仍可解析，且 `activeLocalBundle` 仍能按 `installLocation + source` 成功定位该插件
- `platformNativeFallbackEvidence` 只在账本 / tracking manifest 缺口时保守启用，用来表达“平台仍保留足够的原生安装元数据，可进入受控 native uninstall / refusal”
  - Claude `scope=user`：当前 scope `settings.json` 仍启用 `<plugin>@aw`，且 `installed_plugins.json` 里存在 `scope=user` 的 `<plugin>@aw` 记录
  - Claude `scope=project`：当前 scope `settings.json` 仍启用 `<plugin>@aw`，且 `installed_plugins.json` 里存在 `scope=project` 且 `projectPath === getOriginalCwd()` 的 `<plugin>@aw` 记录
  - Codex `scope=user`：`~/.codex/config.toml` 中 `[plugins."<plugin>@aw"].enabled = true`
  - Codex `scope=project`：不额外引入 user native fallback；共享 user plugin enabled 不能单独证明“当前 repo 仍受管”
- 原生状态里如果同名插件的 marketplace / owner 明确不是 `aw`，统一记为 `externalOwnership`；它不属于 `当前 scope 受管证据`、`platformRuntimeEvidence` 或 `platformNativeFallbackEvidence`
- `platformRuntimeEvidence` 只用于 `status` 的历史恢复提示与 runtime drift 展示，不会把 `scopeInitialized` 改成 `yes`，也不会单独授权 `uninstall` / `upgrade`
- `platformNativeFallbackEvidence` 只用于 `status` 的附加说明和 `uninstall` 的保守 native 清理 / 拒绝路径，不会把 `scopeInitialized` 改成 `yes`，也不会单独授权 `upgrade --all`
- `catalogCompatibility = current | capabilityChanged` 只在当前 scope 命中 `当前 scope 受管证据`，且可读取安装时 `capabilitySnapshot` 时计算并输出
- `catalogCompatibility = missing` 可在 current catalog miss，且 `当前 scope 受管证据`、`platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 任一命中时派生
- `catalogCompatibility = missing | capabilityChanged` 时，如存在安装时快照，Claude 的 `instructions` / `permissions` 清理必须退回到账本快照与 tracking manifest，Codex 的 native cleanup 必须退回到账本快照、repo-managed artifacts cleanup 必须退回到 tracking manifest；不能因为 current catalog miss 就抹掉正式清理路径
- 对于任一曾建立过 Codex shared native state 的插件，`sharedNativeRefs` 必须规范化为固定结构：`{ "user": boolean, "projects": string[] }`
- `sharedNativeRefs.user` 缺失不等于 `false`；单独删除 `user` 字段或 `projects` 字段都属于“不明确状态”，命令层必须按未知处理
- `scope=user` 卸载只会把 `sharedNativeRefs.user` 写成 `false`；`scope=project` 卸载只会从 `sharedNativeRefs.projects` 移除当前 `codexProjectKey`
- 只有账本明确显示当前插件 `sharedNativeRefs.user = false`，且 `sharedNativeRefs.projects` 为空时，CLI 才允许删除当前插件自己的 shared user plugin enabled
- `[marketplaces.aw]` 是整个 `aw` marketplace 的共享配置；删除前必须扫描 `installed.json` 里全部受管插件，确认不存在任何 `requiresNativePlugin = true` 且仍保留 `sharedNativeRefs.user = true` 或非空 `projects` 的 `aw` 插件，且不存在无法规范化的 `sharedNativeRefs` 条目
- 只要旧 `~/.aw/installed.json` 结构合法，`aw init --force` 就允许原样保留账本；`sourceVersion` 或 `bundleFingerprint` 变化只触发 bundle 刷新，不触发账本丢弃
- `aw init --force` 保留合法账本不等于“只认当前 catalog”；被保留的历史条目仍必须保有受控 `status` / `uninstall` / 显式 `upgrade` 语义
- 当某个插件的 scope ledger、tracking manifest 状态和 `sharedNativeRefs` 都已清空后，才允许在同一次账本提交里裁剪整个插件条目；在此之前不能靠删除 `sharedNativeRefs.user` 表达“无 user 引用”
- 命令层对 `installed.json` 采用 copy-on-write；tracking manifest 只做 scoped staging / replace，不承诺和 `installed.json` 形成跨文件原子提交
- 提交顺序固定为：先完成 native state 与 repo-managed artifacts，再提交 tracking manifest，最后替换 `installed.json`；任一步失败都按后文 rollback / `degraded` 语义处理
- 统一失败语义按“任何受管状态已改写”触发，而不是只看 native state；受管状态包括 Claude / Codex 原生配置、repo-managed artifacts、tracking manifest 与 CLI 账本
- 如 native state 已改写，但 tracking manifest 或 `installed.json` 提交失败，命令必须 best-effort 回滚本次新增 / 删除的 repo-managed artifacts，并把账本写成 `ledgerState.status = degraded`、`reason = operation_interrupted_after_native_write`；不能继续保留 `available`
- 如没有 native state 改写，但 repo-managed artifacts 或 tracking manifest 已改写后提交失败，命令同样必须 best-effort 回滚本次文件变更，并把账本写成 `ledgerState.status = degraded`、`reason = operation_interrupted_after_artifact_write`；不能留下“文件部分落地但账本仍健康”的状态
- 降级账本写回失败时，命令必须明确报出恢复风险；后续 `status` 读取到缺失、非法或不完整账本时，仍按 `degraded` 语义展示未知 scope，不能把缺失记录解释成 `no`

明确限制：

- `installed.json` 不替代 Claude / Codex 的原生安装状态
- Claude 的平台真值仍来自 `settings.json`、`known_marketplaces.json`、`installed_plugins.json`，以及由 `known_marketplaces.installLocation + source` 定位出的 `activeLocalBundle`
- Codex 的平台真值仍来自 `~/.codex/config.toml`、目标 scope tracking manifest 和文件系统
- `ledgerState.status = degraded` 时，CLI 不得把缺失账本记录当成“肯定未初始化”
- `installed.json` 里的 `capabilitySnapshot` 不是平台真值，而是历史安装快照，只用于卸载、显式升级 reconcile 和 drift 诊断
- 对 `status` / `uninstall`，current catalog miss 或同名插件能力变化时，只要 `当前 scope 受管证据`、Claude `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 仍命中，CLI 就不能直接报 `Unknown plugin`
- 显式 `upgrade <plugin>` 只有在存在当前 scope 安装时快照时才允许进入历史 reconcile；只剩 Claude `platformRuntimeEvidence` 或任一 `platformNativeFallbackEvidence` 时，命令必须拒绝升级并提示先 `uninstall` 再 `install`
- `upgrade --all` 的最终候选集合可以用 `installed.json` 判定“这个 scope 是否受管”，但不能跳过平台真值和 tracking manifest 的回读
- 卸载时如账本与真实状态冲突，以真实平台状态和 tracking manifest 为准；所有会删除 Codex shared user plugin enabled 或 `[marketplaces.aw]` 的路径都必须走“无明确剩余引用才删除”的保守策略，其中 marketplace 删除额外要求全账本扫描通过

推荐用途：

- `scopeInitialized` 与 `upgrade --all` 的候选集判定
- `ledgerState` 的降级提示和自动推断保护
- Codex shared user plugin enabled 引用与 marketplace 删除边界的管理
- 幂等优化、提示信息与故障排查

### 2.4 新增 `aw init` 命令

`aw init [--force]` 的职责只有一件事：把 npm 包内已经构建好的插件素材展开到 `~/.aw`。

执行语义：

1. 读取 `~/.aw/config.json`
2. 通过 `resolveEmbeddedPluginsRoot()` 计算当前 embedded bundle 的 `bundleFingerprint`
3. 如果未传 `--force`，先执行 `validateLocalMarketplaceLayout()`
4. 只有 `sourceVersion` 与当前 CLI 版本匹配、`bundleFingerprint` 与当前 embedded bundle 匹配，且 `validateLocalMarketplaceLayout()` 确认当前 `~/.aw` 能被运行时完整消费时才允许跳过
   - `~/.aw/config.json`
   - `~/.aw/.claude-plugin/marketplace.json`
   - `~/.aw/.agents/plugins/marketplace.json`
   - 两份 marketplace manifest 语义一致，且 plugin entry 集合与当前 `embedded plugins root` 一致
   - 每个 plugin entry 的 `source` 都能从 marketplace root 解析到真实插件目录
   - 每个插件目录及其 `.agents-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 都能成功解析
   - 每份 platform manifest 声明的相对路径都能解析到 bundle 内真实文件 / 目录
   - Codex 显式 `skills`、`mcpServers`、`apps` 路径存在
   - Claude runtime bundle 统一采用 `./claude/**` 的 namespaced path 契约
     - build 生成的 Claude 运行时文件只允许落在 `./claude/...`；`.claude-plugin/plugin.json` 里的路径类字段也只允许引用这些 bundle-local 路径
     - `skills`、`commands`、`agents`、`hooks`、`outputStyles`、`mcpServers` 的路径项都能解析到真实文件 / 目录；`lspServers` 的路径项也做同样检查，inline 项只做 schema 校验
     - 共享 `mcpServers` 在源码 manifest 中固定为相对路径字符串，生成后的 `.claude-plugin/plugin.json.mcpServers` 只允许指向 `./claude/...`；首版不支持 inline / mixed array
     - 其中 Claude 侧 generated path 不得回落到 `./skills`、`./commands`、`./agents`、`./output-styles`、`./hooks/hooks.json`、`./.lsp.json`、`./.mcp.json` 这类上游默认 loader 入口，也不得直接指向 `./shared/**`
     - `userConfig`、`channels` 只做 schema 校验，不做路径存在性判断
   - `validateLocalMarketplaceLayout()` 只证明 `~/.aw` 的结构和路径闭环可被当前运行时消费；是否与当前 embedded bundle 内容一致，由 `bundleFingerprint` 单独判定
5. 通过 `resolveEmbeddedPluginsRoot()` 读取 bundle，以 staging 目录复制 `plugins/*` 和两份 marketplace manifest
6. 如果旧 `~/.aw/installed.json` 结构合法，复制到 staging 后一并保留；`sourceVersion` 或 `bundleFingerprint` 变化都不影响这一步
7. 如 `installed.json` 缺失或结构非法，按当前 schema 在 staging 写一个 `degraded ledger`
   - `ledgerState.status = degraded`
   - `ledgerState.degradedAt = now`
   - `ledgerState.reason = rebuilt_from_missing_or_invalid`
   - `plugins = {}`
   - 后续任何命令都不能把缺失记录当成“未初始化”或“无剩余引用”
8. 在 staging 写回 `config.json`，持久化当前 `sourceVersion` 与 `bundleFingerprint`
9. 校验 staging 内容完整性
10. 校验通过后再原子替换 `~/.aw`

显式约束：

- `aw init --force` 不读取也不重置任何平台原生安装状态
- `aw init --force` 不清空 tracking manifest
- `aw init` 不调用源码插件生成逻辑
- `aw init` 失败时不能把旧的 `~/.aw` 破坏到不可恢复
- `aw init --force` 不对上面枚举的切换前基线状态做迁移兼容；新方案未来跨 schema 升级策略不在本文范围

### 2.5 自动触发策略

- `install`、`upgrade` 在需要本地市场时调用 `ensureLocalMarketplace()`
- `ensureLocalMarketplace()` 的 freshness gate 固定为 `sourceVersion + bundleFingerprint + 布局健康`；同版本重 build 只要 embedded bundle 内容变了，也必须刷新本地 marketplace bundle，但合法账本继续保留
- 对已启用的 Claude 本地目录插件，刷新 `~/.aw` 会影响下一次标准启动读取的本地 bundle；但 `aw init` 本身不改动 scope `settings.json`、`installed_plugins.json` 或 CLI 账本之外的已安装判断
- `status` 保持只读，不自动执行 `init`
- `status` 读取 catalog 前先比较 `~/.aw/config.json` 中的 freshness metadata（`sourceVersion` + `bundleFingerprint`）与当前 embedded bundle；任一不匹配、缺失或目录损坏时，只允许回退到 `embedded plugins root` 进行只读解析，并明确提示本地市场过期或不可用；这个 fallback 只影响 `currentCatalog`，不代表当前原生 loader 会改读 embedded bundle
- `status` 遇到 `ledgerState.status = degraded` 时继续只读展示，但缺失 ledger 记录的 `scopeInitialized` 必须显示为 `unknown`
- `uninstall` 默认不依赖 `init`

### 2.6 共享插件目录解析

所有命令统一走一层共享插件目录解析，不再假设当前 `cwd` 就是市场源仓库。

catalog 选择规则：

1. `~/.aw/plugins/*`
   - 仅当 `~/.aw/config.json` 的 `sourceVersion` 与当前 CLI 版本一致、`bundleFingerprint` 与当前 embedded bundle 一致，且目录完整时作为首选 catalog
2. `embedded plugins root/plugins/*`
   - `~/.aw` 缺失、损坏或 freshness metadata 落后时的只读 catalog 来源

catalog 解析规则：

- `currentCatalog` 表示命令级当前目标 catalog：优先取 freshness metadata 命中且布局健康的 `~/.aw`，否则只读回退到 `embedded plugins root`
- `activeLocalBundle` 只用于诊断当前原生 loader 会读取的本地载荷；对 Claude 固定按 `known_marketplaces.installLocation + entry.source` 解析，允许与 `currentCatalog` 不一致
- `status` 遇到 `currentCatalog` 与 `activeLocalBundle` 不一致时，必须同时展示“当前 catalog”与“当前物化载荷”；只有两者收敛时，才能把 `currentCatalog` 描述成“下次标准启动将读取的 bundle”
- 所有命令都先按显式插件名查 current catalog
- `当前 scope 受管证据` 指当前 plugin 在目标 scope 下仍可证明“CLI 曾经受管”的 scope-sensitive 证据
  - Claude：当前 scope ledger 或当前 scope tracking manifest
  - Codex `scope=user`：`userScope` ledger、user scope tracking manifest、`sharedNativeRefs.user = true`
  - Codex `scope=project`：`projectScopes[codexProjectKey]`、当前 repo tracking manifest、`sharedNativeRefs.projects` 明确包含当前 `codexProjectKey`
- `platformRuntimeEvidence` 指账本 / tracking manifest 缺口时，仍可从平台运行时链路证明 `<plugin>@aw` 会被原生 loader 读取
  - Claude：当前 scope `settings.json` 仍启用 `<plugin>@aw`，`known_marketplaces.json` 中 `aw.installLocation` 仍可解析，且 `activeLocalBundle` 成功按 `installLocation + source` 定位该插件
- `platformNativeFallbackEvidence` 指账本 / tracking manifest 缺口时，仍可从平台真值回读到足以执行受控 native uninstall / refusal 的 `<plugin>@aw`
  - Claude `scope=user`：当前 scope `settings.json` + `installed_plugins.json` 中 `scope=user` 的 `<plugin>@aw` 记录
  - Claude `scope=project`：当前 scope `settings.json` + `installed_plugins.json` 中 `scope=project` 且 `projectPath === getOriginalCwd()` 的 `<plugin>@aw` 记录
  - Codex `scope=user`：`~/.codex/config.toml` 中 `[plugins."<plugin>@aw"].enabled = true`
  - Codex `scope=project`：不额外引入 user native fallback
- `externalOwnership` 指目标 scope 下已存在同名插件，但其 marketplace / owner 明确不是 `aw`
- 对 `status`、`uninstall`、显式 `upgrade <plugin>`，都先判定 `当前 scope 受管证据`
- `status` 在前者缺失时，还要继续尝试 `platformRuntimeEvidence` 与 `platformNativeFallbackEvidence`
- `uninstall` 在前者缺失时，还要继续尝试 `platformNativeFallbackEvidence`；如果 Claude 只命中 `platformRuntimeEvidence`，也必须返回受控 drift / refusal，而不是 `Unknown plugin`
- `catalogCompatibility = current | capabilityChanged` 只在命中 `当前 scope 受管证据`，且可读取安装时快照时派生
- `catalogCompatibility = missing` 在 current catalog miss，且命中 `当前 scope 受管证据`、`platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 时派生
- current catalog 命中但当前 scope 没有 `当前 scope 受管证据`，且 `status` 也拿不到 `platformRuntimeEvidence` / `platformNativeFallbackEvidence` 时，保留 current catalog 的只读结果，但不输出 `catalogCompatibility`

catalog 命令规则：

- `install`：current catalog miss 直接报 `Unknown plugin`
- `status`：只要 current catalog 命中，或 `当前 scope 受管证据` / `platformRuntimeEvidence` / `platformNativeFallbackEvidence` 仍存在，就必须给出受控结果；四者都 miss 才报 `Unknown plugin`
- `uninstall`：只要 current catalog 命中，或 `当前 scope 受管证据` / `platformNativeFallbackEvidence` 仍存在，就必须给出受控结果；如果只剩 Claude `platformRuntimeEvidence`，也要返回明确 refusal / drift，而不是 `Unknown plugin`
- current catalog 命中但当前 scope 无 `当前 scope 受管证据` 时，`status` 在命中 `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 时继续展示保守历史信息；否则展示“未受管 / 未初始化”的当前结果
- current catalog 命中但当前 scope 无 `当前 scope 受管证据` 时，`uninstall` 只有命中 `platformNativeFallbackEvidence` 才进入保守 native 清理；只剩 Claude `platformRuntimeEvidence` 时返回“原生 loader 仍会读取，但缺少安全卸载元数据”的 refusal；两者都无时返回“当前 scope 未受管，无需清理”
- 显式 `upgrade <plugin>`
  - `catalogCompatibility = current` 时，按当前 manifest 升级
  - `catalogCompatibility = capabilityChanged` 时，进入受控 reconcile：先按安装时快照和 tracking manifest 清掉旧能力，再安装当前 manifest，最后重写快照
  - `catalogCompatibility = missing` 时，拒绝升级，并要求先显式 `uninstall`
- 只剩 Claude `platformRuntimeEvidence` 或任一 `platformNativeFallbackEvidence`、但拿不到安装时快照时，显式 `upgrade <plugin>` 必须拒绝进入历史 reconcile，并提示先 `uninstall` 再 `install`
- `upgrade --all`：仅在 `ledgerState.status = available`，且当前 scope 所有受管插件都满足 `catalogCompatibility = current` 时执行；如存在 `missing` 或 `capabilityChanged` 条目，直接拒绝并列出待显式处理插件
- `aw init --force` 保留合法账本，但不会把 `missing` / `capabilityChanged` 条目自动 prune 掉

当前阶段范围：

- 支持“同一 plugin id 被移出 current catalog”与“同一 plugin id 能力变化”的受控处理
- 不设计跨 plugin id rename / alias 自动迁移；rename 视为“旧 id 进入 `missing`，新 id 作为新安装”
- 上面枚举的切换前基线状态不在本期命令兼容范围内

显式约束：

- `install`、`uninstall`、`status`、`upgrade` 的显式插件名都先走同一个 catalog 入口
- `upgrade --all` 先从这层枚举“可识别插件集合”，再按平台真实状态过滤
- 消费仓库里即使没有本地 `plugins/` 目录，命令也必须完整可用
- catalog fallback 不能再假设当前命令运行在 monorepo 源码树里
- 命令阶段不再调用 `syncGeneratedPluginManifests()` 或任何对 catalog 根目录的写回逻辑

---

## Phase 3: 基于 Agent 原生 CLI 安装/卸载

### 3.0 `codex-config.ts` feasibility gate

`codex-config.ts` 不是普通工具函数，而是 Phase 3 与 Phase 5 的阻塞前置能力，必须先独立跑通，再允许接入 CodexAdapter 和命令链路。

技术路线：

- 不复用 `packages/cli/src/adapters/helpers.ts` 里那套轻量 section parser；新增 `packages/cli/src/utils/codex-config.ts`
- 解析层选用 `toml-eslint-parser`，基于 AST、tokens、comments 在原始文本上做 range patch，不做 `parse -> object -> stringify`
- `packages/cli/package.json` 需要新增运行时依赖 `toml-eslint-parser`
- `codex-config.ts` 首批只负责三类写回：`[marketplaces.*]`、`[plugins.*]`、`developer_instructions`
- `[marketplaces.aw]` 的写回结果必须与 Codex 上游 `record_user_marketplace()` 的 local-source 语义兼容：
  - `last_updated = "<UTC timestamp>"`
  - `source_type = "local"`
  - `source = "<~/.aw canonical directory path>"`
  - 不写 `ref`、`sparse_paths` 或 manifest 文件路径
- `codex-config.ts` 读取到 `source` 指向 `.agents/plugins/marketplace.json` 这类 manifest 文件时，必须视为错误配置并触发修复；不能为了兼容旧实现继续把它当可用 marketplace

落地顺序：

1. 先完成 `codex-config` golden fixture 与独立 build-free smoke，不接 `install` / `uninstall`
2. 先验证 user `~/.codex/config.toml` 与 project `.codex/config.toml` 两侧的 upsert / remove / idempotent round-trip
3. 再验证多行 `developer_instructions = """..."""`、注释、字段顺序、无关 section 共存时的保真
4. gate 通过后，才让 CodexAdapter、`detect.ts` 与命令层接入
5. 如果 gate 未通过，暂停 Phase 3 / 5 的 Codex config 写回相关实现，不降级成正则替换或整文件重写

### 3.1 重构 ClaudeAdapter

**文件**：`packages/cli/src/adapters/claude.ts`

#### installPlugin()

Claude 侧安装链路保持“原生 CLI 为主，脚本补齐少量扩展”：

1. `ensureLocalMarketplace()`
2. 读取当前 scope `settings.json`，并解析 `aw` 的 declared source
3. 回读 `~/.claude/plugins/known_marketplaces.json`，并尝试解析 `aw` 的 materialized marketplace
4. 只要命中任一条件，就执行 `claude plugin marketplace add ~/.aw --scope <scope>`
   - 当前 scope `settings.json` 未声明 `aw`
   - 当前 scope 已声明 `aw`，但 declared source 经过与上游 `diffMarketplaces()` 一致的本地路径归一化后，不再指向当前 `~/.aw`
   - `known_marketplaces.json` 缺少 `aw` 记录
   - `known_marketplaces.json` 中 `aw.installLocation` 不再指向当前 `~/.aw`
   - `aw.installLocation` 下的 marketplace manifest 不可读或校验失败
5. 执行 `claude plugin install <plugin>@aw --scope <scope>`
6. 回读三层状态
   - 当前 scope `settings.json`
   - `~/.claude/plugins/known_marketplaces.json`
   - `~/.claude/plugins/installed_plugins.json`
7. 按目标 scope 更新 `installed.json.platforms.claude.userScope` 或 `projectScopes[claudeProjectKey]`
   - 写入 `resolvedVersion`
   - 写入 `capabilitySnapshot.managedExtensions`

补充规则：

- 对本方案固定的本地目录源 `~/.aw`，Claude 的“声明层已对齐”不只看 marketplace 名称，还要看当前 scope `settings.json.extraKnownMarketplaces.aw.source` 经过与上游 `diffMarketplaces()` 一致的本地路径归一化后，是否仍等于当前 `~/.aw`
- 对当前方案固定的本地目录源 `~/.aw`，Claude 的“物化层已对齐”不看时间戳，而看 `known_marketplaces.json` 中的 `installLocation` 是否仍指向当前 `~/.aw`，且该目录下 manifest 可正常读取
- `status` 必须把“声明存在但 declared source 漂移”单独报成 drift，不能误报成 marketplace 声明健康
- 不能因为当前 scope 已声明 marketplace，就跳过物化层检查

#### installExtensions()

Claude 侧只保留一套源码扩展模型，并明确拆成两类落点：

- `extensions.instructions`
  - 安装时生成当前 scope `.claude/rules/*.md`
  - 卸载时按 tracking manifest 精确清理
- `extensions.permissions`
  - 安装时写入当前 scope `settings.json` 的受管区段
  - 卸载时只清理 aw 受管权限，不动手写权限
- `extensions.hooks`
  - build 阶段生成 `claude/hooks/hooks.json`
  - `.claude-plugin/plugin.json.hooks` 只允许引用 `./claude/hooks/hooks.json` 这类 bundle-local 路径，不允许回写 Claude 默认的 `./hooks/hooks.json`
- `extensions.agents`
  - build 阶段生成 `claude/agents/*.md`
  - `.claude-plugin/plugin.json.agents` 写成生成后的路径数组；每个 agent 文件按 Claude frontmatter 契约写入 `name`、`description`、`tools`，正文原样写入 `prompt`
- `manifestOverrides.claude`
  - 只允许补充 Claude 原生独有字段：`commands`、`outputStyles`、`lspServers`、`userConfig`、`channels`

因此：

- 脚本层只补 `extensions.instructions` 与 `extensions.permissions`
- 这些补充产物才写 tracking manifest
- `extensions.hooks`、`extensions.agents` 与 `manifestOverrides.claude.*` 都随运行时 plugin manifest 直接交给 Claude 原生 loader 消费
- 不再允许再写第二套 `manifestOverrides.claude.hooks` / `manifestOverrides.claude.agents`

#### `resolveClaudeCatalogCompatibility(plugin, scope)`

命令层对 Claude 也要区分两套输入：

- `current catalog capabilities`：当前 manifest 里会触发 scope 级副作用的扩展集合，只包含 `extensions.instructions` 与 `extensions.permissions`
- `installed capability snapshot`：`installed.json.platforms.claude.<scope-ledger>.capabilitySnapshot.managedExtensions`

再结合 `当前 scope 受管证据`、`platformRuntimeEvidence` 与 `platformNativeFallbackEvidence` 派生 `catalogCompatibility`：

- `current`：当前 manifest 存在，当前 scope 受管证据存在，且当前 `managedExtensions` 与安装时快照一致
- `missing`：current catalog miss，且当前 scope 受管证据、`platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 仍存在
- `capabilityChanged`：当前 manifest 存在，当前 scope 受管证据存在，且当前 `managedExtensions` 与安装时快照不一致
- 只有 `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence`、但没有 scope ledger / tracking manifest 时，不派生 `current` / `capabilityChanged`
- 无当前 scope 受管证据且无 `platformRuntimeEvidence` / `platformNativeFallbackEvidence`：不派生 `catalogCompatibility`

补充规则：

- Claude 的 `capabilitySnapshot` 只覆盖需要 install/uninstall reconcile 的历史副作用；`skills`、`commands`、`hooks`、`agents`、`mcpServers`、`outputStyles`、`lspServers`、`userConfig`、`channels` 以及 `./claude/**` bundle 内容变化，都由 `ensureLocalMarketplace()` 刷新 `~/.aw` 吸收，不单独记成 `capabilityChanged`
- 显式 `upgrade <plugin>` 只有在命中当前 scope 受管证据且可读取 `capabilitySnapshot` 时，才允许进入历史 reconcile
- `capabilityChanged` 的显式 upgrade 先按安装时快照与 tracking manifest 清理旧 `instructions` / `permissions` 副作用，再按当前 manifest 重建，并重写 `resolvedVersion` 与 `capabilitySnapshot`
- `missing` 的显式 upgrade 不做隐式迁移，直接提示先 `uninstall`

#### uninstallPlugin()

1. 读取当前 scope `settings.json`
2. 调用 `claude plugin uninstall <plugin>@aw --scope <scope>`
3. 回读当前 scope `settings.json`
4. 回读 `~/.claude/plugins/known_marketplaces.json` 与 `~/.claude/plugins/installed_plugins.json`
5. 以这三层回读结果为准，清理 tracking manifest 记录的 `extensions.instructions` / `extensions.permissions` 产物
6. 按目标 scope 更新 `installed.json.platforms.claude.userScope` 或 `projectScopes[claudeProjectKey]`

#### status() 与状态派生

Claude 的状态判断以实际平台状态为准：

- 当前 scope 的 `settings.json`
- `~/.claude/plugins/known_marketplaces.json`
- `~/.claude/plugins/installed_plugins.json`
- 当前 scope tracking manifest

统一规则：

- marketplace 声明层状态看目标 scope `settings.json`；除了是否存在 `aw`，还要看 declared source 经过与上游 reconciler 一致的归一化后是否仍指向当前 `~/.aw`
- marketplace 是否“已物化”看 `~/.claude/plugins/known_marketplaces.json`
- `installed_plugins.json` 的 scope 相关性判断要与上游一致
  - `scope=user`：只接受 `scope=user` 的 `<plugin>@aw` 记录；不要求 `projectPath`
  - `scope=project`：只接受 `scope=project` 且 `projectPath === getOriginalCwd()` 的 `<plugin>@aw` 记录
- 插件是否“对当前 scope 已安装”看目标 scope `settings.json` + 匹配当前 scope 语义的 `~/.claude/plugins/installed_plugins.json` 记录
- 不能把 `~/.aw` 或 `installed.json` 误报成“原生已安装”
- 当前 scope tracking manifest 只用于诊断 `extensions.instructions` / `extensions.permissions` 的受管产物
- `status` / `uninstall` 在当前 scope ledger 与 tracking manifest 都缺失时，还要按平台真值分别派生 `platformRuntimeEvidence` 与 `platformNativeFallbackEvidence`
- Claude 只有在当前 scope `settings.json` 仍启用 `<plugin>@aw`，`known_marketplaces.json` 中 `aw.installLocation` 仍可解析，且 `activeLocalBundle` 仍能按 `installLocation + source` 成功定位该插件时，才把它当成 `platformRuntimeEvidence`
- Claude 只有在当前 scope `settings.json` 仍启用 `<plugin>@aw`，且 `installed_plugins.json` 里仍存在匹配当前 scope 语义的记录时，才把它当成 `platformNativeFallbackEvidence`
- 如目标 scope 已存在同名插件，但其 marketplace 明确不是 `aw`，要单独标记为 `externalOwnership`；`status` 只报 drift，`install` / `upgrade` / `uninstall` 都不接管
- `known_marketplaces.json` 与 `activeLocalBundle` 既承担 marketplace / bundle drift 诊断，也可在命中时证明原生 loader 仍会读取该插件；但它们不单独授权 native uninstall
- 只剩 `platformRuntimeEvidence` 时，`status` 必须明确显示“原生 loader 仍会读取，但 CLI 账本 / 安装元数据缺失”；`uninstall` 返回受控 drift / refusal；显式 `upgrade` 不进入历史 reconcile
- 命中 `platformNativeFallbackEvidence` 时，`status` 继续补充“平台安装记录仍在”；`uninstall` 允许进入保守 native 清理；显式 `upgrade` 不进入历史 reconcile
- 对本方案固定的本地目录 marketplace（`installLocation = ~/.aw` + `source = ./plugins/<plugin>`），Claude 默认 startup 的 cache-only loader 会直接从 `~/.aw` 解析 `.claude-plugin/plugin.json` 与 `./claude/**` 产物
- `currentCatalog` 表示 CLI 当前目标态，用于 `catalogCompatibility`、升级目标和 bundle 语义诊断；它可来自健康的 `~/.aw`，也可在只读场景下回退到 `embedded plugins root`
- `activeLocalBundle` 才表示 Claude 下一次标准启动会按原生 loader 读取的本地载荷，固定从 `known_marketplaces.installLocation + source` 解析；`installed_plugins.json` 只用于安装相关性、scope 过滤和诊断
- 当 `currentCatalog` 与 `activeLocalBundle` 不一致时，`status` 必须分别报告两层：前者是 CLI 当前目标 catalog，后者才是“下次标准启动将读取的原生载荷”
- `status` 必须把 declared source drift 与 `known_marketplaces` / `activeLocalBundle` 的物化 drift 分开显示，不能把“已声明 marketplace”误当成声明层健康
- 首版不逐项展开由原生 manifest 承载的 `skills`、`commands`、`hooks`、`agents`、`mcpServers`、`outputStyles`、`lspServers`、`userConfig`、`channels` 的状态；只验证它们是否已经进入 `currentCatalog`，并另外报告 `activeLocalBundle` 是否仍满足默认 startup loader 的读取契约
- Claude 侧只支持默认全局目录 `~/.claude/plugins`

### 3.2 重构 CodexAdapter

**文件**：`packages/cli/src/adapters/codex.ts`

#### `requiresNativePlugin(plugin)`

统一判定规则：

- `requiresNativePlugin(plugin)` 只基于已通过校验的 manifest 结果，不再额外扫描默认目录 / 文件
- manifest 显式声明了任一 `skills`、`mcpServers`、`apps`，返回 `true`
- 这里的 `mcpServers` 固定指顶层共享 path-only 字段；首版不开放 Claude-only inline / mixed MCP 输入，因此不会出现 Claude-only MCP 配置误触发 Codex native state
- 只声明 `extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents`，返回 `false`
- 源码插件目录里如果存在默认 `skills/`、`.mcp.json`、`.app.json`，但 manifest 没显式声明对应字段，校验阶段直接失败；首版不做兼容推导

这套判定直接用于：

- `installPlugin()`
- current catalog 命中且 `catalogCompatibility = current` 的 `upgradePlugin()`
- current catalog 命中且尚未进入历史受管路径的 `status()` 诊断
- 新安装时的 scope 入口校验

#### `hasRepoManagedArtifacts(plugin)`

统一判定规则：

- manifest 声明了任一 `extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents`，返回 `true`
- 以上都未声明，返回 `false`

这套判定直接用于：

- `installPlugin()`
- current catalog 命中且 `catalogCompatibility = current` 的 `upgradePlugin()`
- current catalog 命中且尚未进入历史受管路径的 `status()` 诊断
- project scope 入口校验

#### `resolveCodexCatalogCompatibility(plugin, scope)`

命令层必须同时读取两套能力来源：

- `current catalog capabilities`：由当前 manifest 通过 `requiresNativePlugin()` / `hasRepoManagedArtifacts()` 派生
- `installed capability snapshot`：由 `installed.json.platforms.codex.<scope-ledger>.capabilitySnapshot` 派生

再结合 `当前 scope 受管证据` 与 `platformNativeFallbackEvidence` 派生 `catalogCompatibility`：

- `current`：当前 manifest 存在，当前 scope 受管证据存在，且与该 scope 的 `capabilitySnapshot` 一致
- `missing`：当前 catalog miss，且当前 scope 受管证据或 `platformNativeFallbackEvidence` 仍存在
- `capabilityChanged`：当前 manifest 存在，当前 scope 受管证据存在，且与 `capabilitySnapshot` 不一致
- 只有 `platformNativeFallbackEvidence`、但没有 scope ledger / tracking manifest / scope-sensitive `sharedNativeRefs` 时，不派生 `current` / `capabilityChanged`
- 无当前 scope 受管证据且无 `platformNativeFallbackEvidence`：不派生 `catalogCompatibility`

统一规则：

- `install` 只看 `current catalog capabilities`
- 任何会改写状态的命令都先检查 `externalOwnership`；只要目标 scope 已存在 marketplace / owner 明确不是 `aw` 的同名插件，`install` / `upgrade` / `uninstall` 都必须拒绝接管
- `uninstall` / `status` 先判定 `当前 scope 受管证据`；`scope=user` 在前者缺失时，还要继续尝试 `platformNativeFallbackEvidence`
- `scope=project` 不允许把共享 user native state 单独当成当前 repo 的 fallback evidence
- 显式 `upgrade <plugin>` 只有在命中当前 scope 受管证据且可读取 `capabilitySnapshot` 时，才允许进入 upgrade reconcile
- `status` / `uninstall` 在 current catalog 命中但既无当前 scope 受管证据、也无 `platformNativeFallbackEvidence` 时，不进入历史 reconcile；`status` 不展示 `catalogCompatibility`，`uninstall` 明确返回 no-op
- `status` 遇到 `externalOwnership` 时，必须把它单独显示为 drift / refusal，而不是并入 `当前 scope 受管证据` 或 `platformNativeFallbackEvidence`
- `missing` 或 `capabilityChanged` 时，如存在 `capabilitySnapshot`，native cleanup 以 `capabilitySnapshot` 为准，repo-managed artifacts cleanup 以 tracking manifest 为准；当前 manifest 只用于诊断和显式升级的目标态
- 只剩 `platformNativeFallbackEvidence` 时，`status` 显示“平台真值仍在，但 CLI 账本 / tracking manifest 缺失”；`uninstall` 只允许保守 native 清理 / 拒绝路径，不进入显式 upgrade reconcile
- `capabilityChanged` 的显式 upgrade 先移除安装时快照独有的旧能力，再安装当前 manifest，成功后重写 `resolvedVersion` 与 `capabilitySnapshot`
- `missing` 的显式 upgrade 不做隐式迁移，直接提示用户先 `uninstall`

#### installPlugin()

进入安装主流程前先做 scope 校验：

- `scope=project` 且 `hasRepoManagedArtifacts(plugin) = false` 时，直接报错，要求用户改用 `--scope user`
- 这个规则同时覆盖 native-only Codex 插件，以及任何没有 repo-managed artifacts 的其它插件

`requiresNativePlugin(plugin) = true` 时：

1. `ensureLocalMarketplace()`
2. 通过 `codex-config.ts` 确保 `~/.codex/config.toml` 存在 marketplace `aw`，且结构固定为 `[marketplaces.aw] source_type = "local"`、`source = "<~/.aw canonical directory path>"`，不能写 manifest 文件路径
3. 在 `~/.codex/config.toml` 中把 `<plugin>@aw` 标记为 enabled
4. 如当前是 `scope=project`，命令输出必须明确提示：这里写的是共享 user native state
5. 原生写入成功后，等待整个安装流程完成，再由命令层统一提交 `installed.json`
- `scope=user`：写入 `userScope.managed = true`
- `scope=project`：写入 `projectScopes[codexProjectKey].managed = true`
- 同时把 `sharedNativeRefs` 规范化成 `{ user: boolean, projects: string[] }` 后再写入当前 scope 引用；它只表示当前插件自己的 shared user plugin enabled 引用

`requiresNativePlugin(plugin) = false` 时：

- `installPlugin()` 明确 no-op
- 不创建也不修改 `~/.codex/config.toml` 中的 marketplace / plugin enabled
- 后续如插件声明了 `extensions.instructions`，仍由 `installExtensions()` 写入对应 scope 的 `developer_instructions`

#### installExtensions()

Codex 的 repo-managed artifacts 按 scope 区分：

- `scope=user`
  - `extensions.instructions` → `~/.codex/config.toml` 的 `developer_instructions` 字段
  - `extensions.permissions` → `~/.codex/rules/*.rules`
  - `extensions.hooks` → `~/.codex/hooks.json`
  - `extensions.agents` → `~/.codex/agents/*.toml`
- `scope=project`
  - `extensions.instructions` → `.codex/config.toml` 的 `developer_instructions` 字段
  - `extensions.permissions` → `.codex/rules/*.rules`
  - `extensions.hooks` → `.codex/hooks.json`
  - `extensions.agents` → `.codex/agents/*.toml`

所有生成产物都写 tracking manifest。

其中 `extensions.agents` 的 Codex 落地产物必须满足上游 role file 契约：

- 文件路径固定为 `<scope-root>/agents/<generated-name>.toml`
- 生成结果必须能按 `codex-rs/core/src/config/agent_roles.rs` 的 `RawAgentRoleFileToml` 约束成功解析
- `extensions.agents[].name` → role file `name`
- `extensions.agents[].description` → role file `description`
- `extensions.agents[].prompt` → role file `developer_instructions`
- `name`、`description`、`prompt` 在 trim 后都不能为空
- 当前阶段不把 `tools` 写入 Codex role file；Codex 上游没有等价字段，生成结果里不得出现未知字段
- 测试不能只断言“文件存在”，还要验证生成 TOML 确实是 Codex 可加载的合法 role file

整个安装流程成功后，再统一更新 `installed.json`：

- `scope=user`：写入 `platforms.codex.userScope`
- `scope=project`：写入 `platforms.codex.projectScopes[codexProjectKey]`
- `requiresNativePlugin(plugin) = true` 时，同步更新 `platforms.codex.sharedNativeRefs`，并保持 `user` 始终为显式布尔值、`projects` 始终为去重后的数组
- `[marketplaces.aw]` 的删除资格不存进单个插件条目；命令层每次考虑删 marketplace 时，都要重新扫描全部 Codex 受管插件的安装时快照与 `sharedNativeRefs`

关于 `extensions.instructions` 的跨 scope 语义，按上游真实配置层定义：

- 高优先级 layer 的 `developer_instructions` 会整体覆盖低优先级 layer 的同名字段，不做字符串拼接
- 这意味着当前 repo `.codex/config.toml` 一旦定义 `developer_instructions`，当前 repo 会遮蔽 `~/.codex/config.toml` 的该字段
- CLI 只管理 user `~/.codex/config.toml` 与当前 repo `.codex/config.toml` 两层，不设计跨层合成策略

其中 `extensions.instructions` 的实现要求：

- 通过 `codex-config.ts` 聚合写入 `developer_instructions = """..."""` 多行字段
- 每个插件只占一个受管区块，边界使用成对 sentinel：`[[aw-managed:start plugin="<plugin>" kind="developer_instructions"]]` / `[[aw-managed:end plugin="<plugin>"]]`
- 同一插件的多个 instruction 片段按稳定顺序拼进同一受管区块；正文里可继续使用普通 Markdown 标题，但机器删除只认 sentinel
- 插件 instruction 正文如果包含以 `[[aw-managed:` 开头的行，build / 安装校验直接失败，不做静默转义
- 保留已有的非 aw 管理文本，只增删带 sentinel 的受管区块
- 卸载 / upgrade 时按 sentinel 精确替换对应插件区块
- 移除后如字段为空，删除整个 `developer_instructions` 字段
- 不写 `config.toml.instructions`
- 不写 `.codex/AGENTS.md`

#### uninstallPlugin()

- `scope=project`
  - 默认只删除 repo-managed artifacts
  - `installed capability snapshot.hasRepoManagedArtifacts = false` 的项目级安装本身不成立，因此不存在“只清 project native-only state”的分支
  - `installed capability snapshot.requiresNativePlugin = false` 时，不触碰 `~/.codex/config.toml`
  - `installed capability snapshot.requiresNativePlugin = true` 时，先删除当前 `codexProjectKey` 的 scope 记录，并仅从 `sharedNativeRefs.projects` 移除当前项目
  - 只有账本明确显示当前插件 `sharedNativeRefs = { user: false, projects: [] }` 时，才允许继续删除当前插件自己的 shared user plugin enabled
- `scope=user`
  - 清 user scope 受管产物
  - 先删除 `userScope` 记录，并把 `sharedNativeRefs.user` 写成 `false`
  - `installed capability snapshot.requiresNativePlugin = true` 时，仅在账本明确显示 `sharedNativeRefs.projects` 为空后，才清当前插件的原生 plugin enabled
  - `[marketplaces.aw]` 只在全量扫描确认没有任何其它 native plugin 仍保留 shared refs，且不存在不明确 `sharedNativeRefs` 条目时才删除
  - 如账本缺失、损坏或结论不明确，保留共享 user native state 与 marketplace 声明，只报告 drift 与后续处理提示

#### status()、`scopeInitialized` 与 repo-managed session state

Codex 内部至少拆成八位状态：

- `scopeInitialized`
  - 对外只暴露 `yes`、`no`、`unknown`
  - 只看 `~/.aw/installed.json` 中当前 scope 的受管安装记录
  - `ledgerState.status = available` 时
    - `scope=user` 看 `platforms.codex.userScope.managed`
    - `scope=project` 看 `platforms.codex.projectScopes[codexProjectKey].managed`
    - 缺失记录可解释为 `no`
  - `ledgerState.status = degraded` 时
    - 显式存在的 `userScope` / `projectScopes[codexProjectKey]` 记录按 `managed` 字段解释为 `yes` / `no`
    - 缺失记录一律记为 `unknown`
  - hybrid 插件 `scope=project` 安装带来的共享 native ref，不能把 `scope=user` 记成 initialized
- `catalogCompatibility`
  - 对外只暴露 `current`、`missing`、`capabilityChanged`
  - `current`：当前 manifest 存在，且当前 scope 受管证据存在、并与该 scope 的 `capabilitySnapshot` 一致
  - `missing`：当前 catalog miss，但该 plugin 仍有当前 scope 受管证据或 `platformNativeFallbackEvidence`
  - `capabilityChanged`：当前 manifest 存在，且当前 scope 受管证据存在、并与 `capabilitySnapshot` 不一致
  - 只有 `platformNativeFallbackEvidence` 时，不派生 `current` / `capabilityChanged`
  - 无当前 scope 受管证据且无 `platformNativeFallbackEvidence` 时字段缺失，不引入 `not_applicable`
- `sharedNativeRefs`
  - 只看 `~/.aw/installed.json` 中 `platforms.codex.sharedNativeRefs`
  - `user` 表示显式 user 安装仍持有共享 native state，字段存在时必须是显式布尔值
  - `projects` 表示哪些 project 安装仍依赖共享 native state，字段存在时必须是去重后的 project key 数组
  - 任一子字段缺失、类型错误或无法规范化时，按账本不明确处理，只用于 drift 提示，不能授权删除 native state
  - `projects` 中不包含当前 `codexProjectKey` 的记录，只能作为“别的 repo 仍在引用”的提示，不能授权当前 repo 进入历史受管路径
- `nativeInstalled`
  - 只看 `~/.codex/config.toml`
- `artifactsInitialized`
  - 只看目标 scope tracking manifest、文件系统，以及目标 scope `developer_instructions` 中是否存在受管段落；`rules`、`hooks`、`agents` 由 tracking manifest 与文件系统校验
  - 只表达“受管产物是否写在磁盘上”，不表达“当前会话是否真实加载”
- `projectTrust`
  - 只在需要判断当前 repo `.codex/` 这一层是否真的参与会话时计算
  - 取值：`trusted`、`untrusted`、`unknown`、`not_applicable`
  - 判定规则对齐 `codex-rs/core/src/config_loader/mod.rs` 的 `ProjectTrustContext`
  - 读取 `~/.codex/config.toml` 中 `[projects."<path>"].trust_level`
  - lookup key 按 Codex 源码的 canonical path / raw path 归一化策略生成
  - 先查当前 cwd，再查 project root，再查 repo root
  - 即使 `.codex/config.toml` 不存在，只要 `.codex/` 下存在 `rules/`、`hooks.json` 或 `agents/`，上游仍会按 project layer 处理并受 trust gating 影响
- `instructionsSessionState`
  - 不再使用布尔型 `sessionVisible`
  - 只回答“当前插件的 instructions 在当前 cwd 下是否真实进入会话；如果不能确定，原因是什么”
  - 取值：`visible`、`shadowedByProjectDeveloperInstructions`、`blockedByProjectTrust`、`projectTrustUnknown`、`unknownByExternalLayer`、`absent`、`not_applicable`
  - `detect.ts` 必须按 Codex 上游层级顺序检查 `cwd/config.toml`、tree `.codex/config.toml`、repo `.codex/config.toml`，并同时判断每一层在当前 trust context 下是 enabled 还是 disabled
  - 只有“更高优先级、CLI 不受管、且在当前 trust context 下 enabled 的 layer”定义了 `developer_instructions`，结果才记为 `unknownByExternalLayer`
  - `scope=project`
    - 当前 repo `.codex/config.toml` 没有受管段落 → `absent`
    - 有受管段落且 `projectTrust = trusted` → `visible`
    - 有受管段落且 `projectTrust = untrusted` → `blockedByProjectTrust`
    - 有受管段落且 `projectTrust = unknown` → `projectTrustUnknown`
  - `scope=user`
    - user scope 没有受管段落 → `absent`
    - 命中 enabled 的外部更高优先级 layer → `unknownByExternalLayer`
    - 当前 repo `.codex/config.toml` 定义了 `developer_instructions`，且 `projectTrust = trusted` → `shadowedByProjectDeveloperInstructions`
    - 当前 repo `.codex/config.toml` 定义了 `developer_instructions`，但 `projectTrust = untrusted | unknown` → `visible`
    - 其余情况 → `visible`
  - 未声明 `extensions.instructions` 的插件返回 `not_applicable`
- `repoManagedSessionState`
  - 按 extension kind 分别表达 `instructions`、`rules`、`hooks`、`agents` 的会话可见性
  - `instructions` 直接复用 `instructionsSessionState`
  - `rules` 对应 `.codex/rules/*.rules`，上游会从所有 enabled config layers 收集并按低到高优先级合并到 exec policy；更高优先级 layer 可能叠加或覆盖部分效果，但低优先级 user rules 仍然是有效输入
  - `hooks` 对应 `.codex/hooks.json`，上游 hooks discovery 只遍历 enabled config layers；多 layer hooks 会共同进入 hooks registry
  - `agents` 对应 `.codex/agents/*.toml`，上游 agent role discovery 只遍历 enabled config layers；同名 role 在更高优先级 layer 可覆盖或补全低优先级 layer 的定义
  - `rules` / `hooks` 的取值首版为 `visible`、`blockedByProjectTrust`、`projectTrustUnknown`、`absent`、`not_applicable`
  - `agents` 的取值首版为 `visible`、`blockedByProjectTrust`、`projectTrustUnknown`、`unknownByExternalLayer`、`absent`、`not_applicable`
  - `scope=project`
    - tracking manifest 或文件系统没有对应受管产物 → `absent`
    - 有受管产物且 `projectTrust = trusted` → `visible`
    - 有受管产物且 `projectTrust = untrusted` → `blockedByProjectTrust`
    - 有受管产物且 `projectTrust = unknown` → `projectTrustUnknown`
  - `scope=user`
    - user scope 没有对应受管产物 → `absent`
    - `rules` / `hooks`：只要 user layer 的受管产物已进入 enabled layer 视图，就记为 `visible`
    - `rules`：如还有 enabled 的更高优先级外部 layer 提供 `.rules`，继续记为 `visible`，但要额外报告“effective exec policy 还叠加了外部 layer”
    - `hooks`：如还有 enabled 的更高优先级外部 layer 提供 `hooks.json`，继续记为 `visible`，但要额外报告“effective hooks registry 还叠加了外部 layer”
    - `agents`：如 enabled 的更高优先级外部 layer 命中同名受管 role，记为 `unknownByExternalLayer`
    - 其余情况 → `visible`
  - 未声明对应 extension kind 的插件返回 `not_applicable`

额外说明：

- `scopeInitialized` 表示该 scope 是否仍在 CLI 受管集合里，用于 `upgrade --all` 和会修改状态的 `--platform auto`
- `scopeInitialized` 不能再从 `nativeInstalled`、`artifactsInitialized` 或共享 native ref 反推
- `ledgerState.status = degraded` 时，缺失记录只代表“CLI 失去了判断依据”，不能代表 `no`
- `catalogCompatibility = missing | capabilityChanged` 时，`uninstall` 与显式 `upgrade` 走受控历史路径；`upgrade --all` 不能继续自动化
- `status` / `uninstall` 在 `scope=user` 且账本 / tracking manifest 缺口时，可额外回读 `~/.codex/config.toml` 的 `[plugins."<plugin>@aw"].enabled = true` 作为 `platformNativeFallbackEvidence`
- `scope=project` 不会把共享 user native state 当成当前 repo 的 native fallback；否则会串 repo / 串 scope
- current catalog 命中但既无当前 scope 受管证据、也无 `platformNativeFallbackEvidence` 时，`status` 只显示 `scopeInitialized = no | unknown` 与当前原生状态 / 文件状态，不展示 `catalogCompatibility`
- `uninstall` 遇到同一场景时直接返回“当前 scope 未受管，无需清理”，不走历史受控清理
- `sharedNativeRefs` 只决定当前插件自己的 Codex shared user plugin enabled 能否被删除；`[marketplaces.aw]` 另按全账本扫描决定能否删除，不参与任何 scope 的 initialized 判定
- `nativeInstalled` 与 `artifactsInitialized` 的 drift 单独展示，不反向改写 `scopeInitialized`
- `repoManagedSessionState` 单独展示，避免把“文件写进去了”和“当前项目实际可见”混为一谈
- `repoManagedSessionState.rules` / `hooks` 回答的是“当前 scope 的受管产物是否进入 enabled layer 视图”，不是“最终 exec policy / hooks registry 只有这一层”
- enabled 的外部更高优先级 layer 对 `rules` / `hooks` 只产生附加诊断，不把已加载的 user 受管产物降成 `unknown`
- `repoManagedSessionState.agents` 只有在 enabled 的外部更高优先级 layer 命中同名受管 role 时，才进入 `unknownByExternalLayer`
- `projectTrust`、`instructionsSessionState` 与 `repoManagedSessionState` 都不参与安装真值本身，但会影响 `status` 文案与 drift 提示
- `status` 需要把 trust 判定纳入当前 repo `.codex/` 的可见性计算，不能再把 `developer_instructions`、`rules`、`hooks`、`agents` 的文件存在直接当成“真实可见”

### 3.3 平台状态检测规则

统一真值矩阵：

| 关注点 | 真值来源 |
|------|------|
| `~/.aw` 是否最新 | `~/.aw/config.json` |
| Claude marketplace 是否在当前 scope 声明 | 当前 scope `settings.json` |
| Claude marketplace 是否已物化 | `~/.claude/plugins/known_marketplaces.json` |
| Claude 插件是否存在匹配当前 scope 的原生安装记录 | 目标 scope `settings.json` + 匹配当前 scope 语义的 `~/.claude/plugins/installed_plugins.json` 记录 |
| Claude 插件是否仍会被默认 startup loader 读取 | 当前 scope `settings.json` + `known_marketplaces.json.installLocation` + marketplace entry `source`；本方案固定解析到 `~/.aw/plugins/<plugin>` |
| Claude scope 是否受 CLI 管理 | `~/.aw/installed.json` 的 Claude scope ledger |
| Codex scope 是否受 CLI 管理 | `~/.aw/installed.json` 的 Codex scope ledger |
| Codex shared native 引用集合 | `~/.aw/installed.json` 的 Codex `sharedNativeRefs` |
| Claude `status` 的 platform runtime evidence | 当前 scope `settings.json` + `known_marketplaces.json.installLocation` + `activeLocalBundle` |
| `status/uninstall` 的 platform native fallback evidence | Claude：当前 scope `settings.json` + 匹配当前 scope 语义的 `installed_plugins.json` 记录；Codex `scope=user`：`~/.codex/config.toml` 的 `[plugins."<plugin>@aw"] enabled` |
| 受管插件的 `catalogCompatibility` | `current` / `capabilityChanged` 取决于 current catalog + `installed.json` 快照 + tracking manifest；`missing` 额外允许保守回读 Claude `platformRuntimeEvidence` / `platformNativeFallbackEvidence` |
| Codex marketplace 是否已注册 | `~/.codex/config.toml` |
| Codex plugin 是否已 enabled | `~/.codex/config.toml` |
| Codex project trust | `~/.codex/config.toml` 的 `[projects]` + 当前 cwd / project root / repo root 归一化路径 |
| repo-managed artifacts 是否存在 | 当前 scope tracking manifest + 文件系统 |
| CLI 账本与调试信息 | `~/.aw/installed.json` |

明确规则：

- `installed.json` 不是原生状态真值
- `installed.json` 负责表达 CLI 自己的 Claude / Codex scope ledger，以及 Codex shared native refs
- `status` / `uninstall` 在账本或 tracking manifest 缺口时，可以保守回读 platform native fallback evidence
- platform native fallback evidence 只用于历史恢复提示和保守 native 清理 / 拒绝路径，不会反写 `scopeInitialized`
- 原生状态如果显示同名插件已由非 `aw` marketplace / owner 管理，统一记为 `externalOwnership`；它只作为 drift / refusal 诊断，不会进入受管恢复路径
- tracking manifest 不等于“原生插件已安装”
- Claude 本地目录 marketplace 的 bundle 内容不看 `installed_plugins.json.installPath`；默认 startup loader 走 `installLocation + source`
- Claude 的全局状态目录固定为 `~/.claude/plugins`
- project `.codex/config.toml` 里的 `developer_instructions` 与其他受管片段不能当成原生安装真值
- Codex 的共享 native ref 不能等同于 user scope 已安装
- Codex 的 `sharedNativeRefs` 只有命中当前 scope 时才算 `当前 scope 受管证据`；其他 repo 的 ref 只影响 shared native state 的删除判定
- Codex repo-managed artifacts 的“是否真实进入会话”必须额外结合 project trust 与更高优先级 layer 判断；覆盖 `developer_instructions`、`rules`、`hooks` 与 `agents`

### 3.4 新增原生命令执行抽象

新增 `packages/cli/src/utils/native-cli.ts`，统一封装：

- `execFile` 或等价 API
- timeout
- cwd
- stdout / stderr
- fake runner 注入

要求：

- 不再直接拼接 shell 字符串
- 测试不能依赖开发机真实安装的 Claude / Codex CLI

---

## Phase 4: 插件内容定制化生成（实现上并入 Phase 1 批次）

本节按主题展开 build-time contract，但执行顺序上并不晚于 Phase 1。只要 `bundle-plugins.ts`、`plugins-dist` 和 `aw init` 依赖这些 contract，它们就必须在首个实现批次一起稳定下来。

### 4.0 Marketplace 元数据来源

repo 根 runtime marketplace 被移除后，build 必须从正式源码输入重建完整 marketplace metadata，不能再靠旧 manifest、隐式常量或实现时临场补字段。

源码输入拆成两层：

- `plugins/marketplace-source.json`：marketplace root 级元数据，供 build 只读消费；首版 schema 只允许 `owner` 与 `interface.displayName`
- `plugins/*/.agents-plugin/plugin.json.marketplace`：plugin entry 级元数据，和插件源码 manifest 一起维护；首版 schema 只允许 `category`、`tags`、`strict`、`policy`

`plugins/marketplace-source.json` 首版最少示意：

```json
{
  "owner": {
    "name": "Leslie Chan",
    "url": "https://github.com/LeslieChan/agent-workflows"
  },
  "interface": {
    "displayName": "Agent Workflows"
  }
}
```

固定 contract：

- 运行时 marketplace `name` 继续固定为 `aw`；这不是作者自由输入
- `plugins/marketplace-source.json` 的首版正式字段集合固定为：
  - `owner.name`
  - `owner.url`
  - `interface.displayName`
  - 除这几个字段外，其余 root metadata 一律视为非法输入；后续如要支持 `forceRemoveDeletedPlugins`、`metadata`、`allowCrossMarketplaceDependenciesOn` 等字段，必须先显式扩展源码 schema、类型和测试
- entry 的 `source` 继续固定为 `./plugins/<plugin>`
- entry 的 `description` / `interface` 继续来自源码 manifest 顶层；`marketplace` block 不能重复承载这两类字段
- `marketplace` block 的首版正式字段集合固定为：
  - `category`：必填
  - `tags`：可选；缺失时运行时 manifest 里保持省略，声明时按原样保留
  - `strict`：必填
  - `policy.installation`：必填
  - `policy.authentication`：必填
  - `policy.products`：可选；缺失时运行时 manifest 里保持省略
- 除上面字段外，其余 entry 级 marketplace metadata 一律视为非法输入；不能靠 `bundle-plugins.ts` 硬编码、静默回填或从旧 runtime marketplace 偷补
- `strict` 与 `policy` 在 build 输出中必须显式写出，不依赖 Claude / Codex 消费端默认值
- `policy` 是 Codex 侧正式消费字段；`owner` 是 Claude 侧正式字段；build 必须同时保留这两类元数据
- 删除 repo 根 runtime marketplace 后，`bundle-plugins.ts` 仍必须仅凭 `plugins/marketplace-source.json` 与源码插件 manifest 完整恢复两份运行时 marketplace manifest

### 4.1 `buildConfig` —— 插件构建配置

插件支持按 agent 差异化生成内容，但生成严格收敛到 build 阶段。

`buildConfig` 定义在源码 manifest `.agents-plugin/plugin.json` 顶层：

```json
{
  "name": "git-commit",
  "version": "0.1.0",
  "description": "...",
  "skills": "./skills",
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL",
      "products": ["CODEX"]
    }
  },
  "buildConfig": {
    "templates": {
      "vars": {
        "agent_name": { "claude": "Claude Code", "codex": "Codex" },
        "thinking_support": { "claude": true, "codex": false }
      },
      "include": ["skills/**/*.md", "commands/**/*.md"]
    },
    "fileRules": {
      "claude": {
        "include": ["skills/**", "commands/**", "output-styles/**", "config/**"],
        "exclude": []
      },
      "codex": {
        "include": ["skills/**", "config/**"],
        "exclude": ["commands/**"]
      }
    },
    "manifestOverrides": {
      "claude": {
        "commands": "./claude/commands",
        "outputStyles": "./claude/output-styles",
        "lspServers": "./claude/.lsp.json"
      },
      "codex": {}
    }
  }
}
```

关键约束：

- `buildConfig` 只在 `bundle-plugins.ts` 中消费
- 命令执行阶段不读取 `buildConfig`
- 运行时 bundle 一旦生成，`aw init` 只复制

#### 4.1.1 `templates` —— 文本模板化

- `vars`：定义模板变量及其按 agent 的值
- `include`：哪些文本文件需要做变量替换

支持：

- `{{var}}`
- `{{#if flag}}...{{/if}}`
- `{{#unless flag}}...{{/unless}}`

#### 4.1.2 `fileRules` —— 文件包含 / 排除

- `include`：复制到该 agent 内容目录的文件或目录
- `exclude`：从 include 结果里排除

处理结果：

- Claude 端得到 `claude/skills`、`claude/commands`、`claude/agents` 等目录
- Codex 端得到 `codex/skills` 和必要静态资源

#### 4.1.3 `manifestOverrides` —— 受限的平台字段补充

`manifestOverrides` 可用于受限的平台字段补充，但不允许演变成任意深合并黑盒。

规则改为：

- 共享字段仍从源码 manifest 提取
- `manifestOverrides.<agent>` 只允许覆盖白名单字段
- 白名单优先服务平台独有能力，而不是任意改写通用字段
- 共享原生字段 `skills`、`mcpServers`、`apps` 不属于 `manifestOverrides.*`；其中 `skills` / `mcpServers` 继续走顶层共享字段，`apps` 只进入 Codex runtime manifest
- Claude 的 `hooks`、`agents` 由 `extensions.hooks`、`extensions.agents` 唯一生成，不允许再通过 `manifestOverrides.claude` 写第二套来源
- 路径类字段 `commands`、`outputStyles` 必须在 build 后归一化到 bundle 内的 `./claude/...`
- 混合字段 `lspServers` 必须保留 path / inline 结构，并在 build 阶段完成 path 项归一化到 `./claude/...` 与 schema 校验
- `userConfig`、`channels` 保持 inline 结构，只做 schema 校验，不转换成路径

首版建议白名单：

- Claude：`commands`、`outputStyles`、`lspServers`、`userConfig`、`channels`
- Codex：首版不开放额外白名单，后续按真实需求扩展

#### 4.1.4 共享原生字段作者模型

首版把共享原生字段的 source schema 收窄到能同时稳定派生 Claude / Codex runtime manifest 的最小闭环，不在这一版混入 Claude-only 作者入口。

| 源字段 | 源码 manifest 写法 | Claude runtime manifest | Codex runtime manifest | 备注 |
|------|------|------|------|------|
| `skills` | 顶层相对路径字符串，例如 `./skills` | `.claude-plugin/plugin.json.skills` 必须显式写成 `./claude/skills` 或等价 namespaced 路径 | `.codex-plugin/plugin.json.skills` 必须显式写成 `./codex/skills` 或等价 bundle-local 路径 | 不能依赖根目录 `skills/` 自动发现 |
| `mcpServers` | 顶层相对路径字符串，例如 `./config/mcp-servers.json` | `.claude-plugin/plugin.json.mcpServers` 必须显式写成 `./claude/...` 的 bundle-local 路径 | `.codex-plugin/plugin.json.mcpServers` 必须显式写成 `./codex/...` 的 bundle-local 路径 | 首版只支持 path-only，不支持 Claude inline / mixed array，也不通过 `manifestOverrides.claude` 暴露 Claude-only MCP 输入 |
| `apps` | 顶层相对路径字符串，例如 `./config/apps.json` | 不派生 Claude 字段 | `.codex-plugin/plugin.json.apps` 必须显式写成 `./codex/...` 的 bundle-local 路径 | Codex-only native capability |

补充规则：

- `requiresNativePlugin()` 只看这三个共享原生字段是否显式声明，不读取 Claude 专有 override
- 如果未来要支持 Claude-only inline / mixed MCP，必须新增单独的 Claude 作者入口和派生规则；首版直接拒绝，不做静默扩容

### 4.2 Claude Code 侧的扩展归属

Claude 侧的源码作者模型统一收口为三层：

- 共享原生字段：顶层 `skills`、`mcpServers`（`apps` 仍是 Codex-only，不进入 Claude manifest）
- 中立扩展：`extensions.*`
- Claude 原生独有字段：`buildConfig.manifestOverrides.claude`

当前仓库已有的顶层 `claude` block 在本方案落地时一并下线：

- `claude.agents` → 迁到 `extensions.agents`
- `claude.hooks` → 迁到 `extensions.hooks`
- 后续不再保留“顶层 `claude` block”和“`manifestOverrides.claude`”两套 Claude 专有入口并存

`extensions.*` 在 Claude 侧的最终落点如下：

| 源字段 | Claude 运行时落点 | 处理时机 |
|------|------|------|
| `extensions.instructions` | 当前 scope `.claude/rules/*.md` | `installExtensions()` / `uninstallExtensions()` |
| `extensions.permissions` | 当前 scope `settings.json` 的 aw 受管区段 | `installExtensions()` / `uninstallExtensions()` |
| `extensions.hooks` | `claude/hooks/hooks.json` + `.claude-plugin/plugin.json.hooks`（显式指向 `./claude/...`） | build |
| `extensions.agents` | `claude/agents/*.md` + `.claude-plugin/plugin.json.agents` | build |

共享 `skills` / `mcpServers` 不走 `extensions.*` 或 `manifestOverrides.claude`：

- `skills` 由顶层共享字段直接派生为 `.claude-plugin/plugin.json.skills = "./claude/skills"` 或等价 namespaced 路径
- `mcpServers` 继续使用顶层共享 path-only 字段；build 只负责把路径改写到 `./claude/...`，不扩成 Claude inline / mixed schema

`manifestOverrides.claude` 只负责 Claude 原生独有字段：

- `commands`
- `outputStyles`
- `lspServers`
- `userConfig`
- `channels`

这些字段都属于 Claude 原生 plugin manifest 直接消费范围：

- CLI 只负责在 build 阶段把它们写进运行时 bundle
- `install` / `uninstall` 不为它们额外生成 repo-managed artifacts
- `status` 首版不逐项细分这些字段，只确认 bundle manifest 是否存在、native install 是否成立

### 4.2.1 Claude runtime bundle 契约

Claude 的 generated manifest 不是源码 manifest 的机械镜像，而是对齐上游 loader 的 namespaced runtime bundle 契约。首版明确选择：build 生成的 Claude 运行时文件统一落在 plugin root 下的 `./claude/**`，避免和上游默认 loader 入口混用；`shared/` 如果存在，也只作为 bundle 内部实现目录，不进入 Claude public runtime manifest contract。

build 产物里的 `.claude-plugin/plugin.json` 统一规则：

- 共享 `skills` 一旦声明，build 必须生成 `./claude/skills/**`，再把 `skills` 字段显式写成该 namespaced 路径；生成产物不得落到 Claude 默认的 `./skills`
- `extensions.hooks` 一旦声明，build 必须先生成 `./claude/hooks/hooks.json`，再把 `hooks` 字段显式写成该 bundle-local 路径；生成产物不得落到 Claude 默认的 `./hooks/hooks.json`
- `extensions.agents` 一旦声明，build 必须生成 `./claude/agents/*.md`，再把 `agents` 字段写成生成后的路径数组
- `manifestOverrides.claude` 不允许再声明 `hooks` 或 `agents`
- 共享 `mcpServers` 一旦声明，build 只接受顶层相对路径字符串输入，并把 `.claude-plugin/plugin.json.mcpServers` 归一化到 `./claude/...`
- `commands`、`outputStyles` 的路径项必须归一化到 `./claude/...`
- `lspServers` 允许 path / inline / mixed array；path 项必须归一化到 `./claude/...`，inline 项保持原结构
- build / 校验阶段不再把 `./skills`、`./commands`、`./agents`、`./output-styles`、`./hooks/hooks.json`、`./.lsp.json`、`./.mcp.json`、`./shared/**` 当成 generated bundle 的合法 manifest 路径；出现这些 root 默认 loader 路径或 `./shared/**` 直链时直接视为布局非法
- `agents`、`outputStyles` 在生成后只保留显式路径项
- `userConfig`、`channels` 保持 inline 结构，不转换成路径
- `validateLocalMarketplaceLayout()`、`status` 与测试都按“manifest 指向的 `./claude/**` 产物可被上游 loader 正确消费”来校验，而不是再扫描默认目录猜测语义

### 4.2.2 Claude agent 文件映射

`extensions.agents` 在 Claude 侧的文件格式必须写死，避免实现时各自脑补：

- 输出文件统一为 `claude/agents/<generated-name>.md`；文件名只负责 bundle 内稳定命名，Claude loader 仍以 frontmatter `name` 为主
- `extensions.agents[].name` → frontmatter `name`
- `extensions.agents[].description` → frontmatter `description`
- `extensions.agents[].tools` → frontmatter `tools`；缺失时省略该字段
- `extensions.agents[].prompt` → markdown 正文原样写入，不再包 `# name`、描述段落或 `## Prompt` 模板壳
- `.claude-plugin/plugin.json.agents` 必须指向生成后的 `./claude/agents/*.md`
- 首版不从中立 schema 暴露 Claude agent 其他 frontmatter 字段：`memory`、`model`、`background`、`skills`、`disallowedTools`、`maxTurns`、`isolation`、`effort`、`permissionMode`、`hooks`、`mcpServers`

### 4.3 Codex instructions 处理策略

Codex instructions 不再写 `config.toml.instructions`。首版统一写到对应 scope `config.toml` 的 `developer_instructions` 字段。

统一策略：

- `scope=project`：写当前仓库 `.codex/config.toml`
- `scope=user`：写 `~/.codex/config.toml`
- 当前 repo `.codex/config.toml` 一旦定义 `developer_instructions`，会整体覆盖 user `~/.codex/config.toml` 的同字段
- CLI 不尝试跨 layer 拼接两份 `developer_instructions`
- 不写 `.codex/AGENTS.md`
- 不自动改写仓库根 `AGENTS.md`

原因：

- 上游当前真实会话装配只消费 `user_instructions`、`developer_instructions` 和 `base_instructions`
- `config.toml.instructions` 在当前上游基线里没有接到实际会话装配链路
- 自动改写仓库根 `AGENTS.md` 或写 `AGENTS.override.md` 会直接介入用户自己的项目文档，不适合作为首版默认行为
- `developer_instructions` 已被上游真实消费，但它在配置层里是标量覆盖，不是 user / project 可叠加载体

实现方式：

1. 安装时，将同一插件的 instructions 聚合成一个受管区块，写入目标 scope `config.toml` 的 `developer_instructions`
2. 受管区块使用成对 sentinel：`[[aw-managed:start plugin="<plugin>" kind="developer_instructions"]]` / `[[aw-managed:end plugin="<plugin>"]]`
3. 插件内多个 instruction 片段按稳定顺序拼进同一受管区块；正文里可继续使用普通 Markdown 标题，但机器删除只认 sentinel
4. 卸载 / upgrade 时按 sentinel 精确替换对应插件区块
5. 如果移除后 `developer_instructions` 为空，删除整个字段
6. 插件 instruction 正文如果包含以 `[[aw-managed:` 开头的行，build / 安装校验直接失败
7. 不使用 `config.toml.instructions`
8. `status` / `detect` 需要能标记 user scope instructions 是否被当前 repo project scope 遮蔽

示意：

```toml
developer_instructions = """
用户手写说明，保持不动。

[[aw-managed:start plugin="git-commit" kind="developer_instructions"]]
## Git Commit Rules
- 使用 Conventional Commits 格式
- scope 必须与模块名一致

## Code Style
- 2 空格缩进
- 不要添加无意义注释
[[aw-managed:end plugin="git-commit"]]
"""
```

为支持这条能力，`codex-config.ts` 首版必须支持：

- `codex-config.ts` 不复用 `packages/cli/src/adapters/helpers.ts` 那套轻量分块编辑逻辑；`marketplaces`、`plugins`、`developer_instructions` 全部迁到同一套 TOML round-trip 编辑器
- 首版必须引入支持多行字符串、注释和字段顺序保真的 TOML CST / token 级编辑能力；不允许退回正则或按行替换整段文本
- 多行 `developer_instructions = """..."""` 的读写
- 保留已有的非 aw 管理文本，只增删带 sentinel 的受管区块
- 保留无关 section、字段、顺序和注释
- 用户手写的 `# aw:` 标题或普通 Markdown 文本不参与受管解析
- 插件正文命中 sentinel 前缀时明确拒绝，不做模糊解析
- 按插件受管区块做增量写入与删除
- 对 project `.codex/config.toml` 和 user `~/.codex/config.toml` 使用同一套编辑逻辑
- 能判断当前文件是否定义了 `developer_instructions`，供 `instructionsSessionState` / shadowed 判定使用

检测侧同步要求：

- `detect.ts` 必须按 Codex 上游层级顺序检查 user、`cwd/config.toml`、tree `.codex/config.toml`、repo `.codex/config.toml` 的 `developer_instructions`
- `detect.ts` 对每一层都要同时记录“是否定义了 `developer_instructions`”和“在当前 trust context 下是否 enabled”
- `unknownByExternalLayer` 只在 enabled 的外部更高优先级 layer 命中时成立；对 `instructions` 看 `developer_instructions`，对 `agents` 看同名 role 冲突。被 trust 禁用的 layer 只能作为诊断信息，不能遮蔽 user scope
- `detect.ts` 还必须按同一套 enabled layer 视图检查 `.codex/rules/*.rules`、`.codex/hooks.json`、`.codex/agents/*.toml`，并产出 `repoManagedSessionState.rules`、`repoManagedSessionState.hooks`、`repoManagedSessionState.agents`
- 对 `rules` / `hooks`，enabled 的外部更高优先级 layer 只形成附加 overlay 诊断，不能把 user scope 已加载产物降成 `unknownByExternalLayer`
- project `.codex/config.toml` 缺失但 `.codex/hooks.json`、`.codex/rules/` 或 `.codex/agents/` 存在时，也必须按 project layer trust 计算；不能因为没有 config 文件就把这些产物报成可见
- 如果实现阶段拿不到满足 round-trip 要求的编辑能力，这部分应暂停并回到方案评审，不降级成脆弱文本替换

如果后续需要“用户态 AGENTS 注入”语义，再单独设计一套受管 `AGENTS` 方案；本期不把这件事混进当前实现。

### 4.4 `extensions` 中的 `agentOverrides`

对于 `permissions`、`hooks`、`agents` 这类仍由源码 manifest 统一描述、再按平台分别生成或映射的扩展，使用 `agentOverrides` 机制：

- `agentOverrides.<agent>` 为 object：深合并覆盖
- `agentOverrides.<agent>` 为 `null`：该 agent 下移除这一条
- 不存在：使用默认定义

这允许源码层统一描述一份扩展，再对 Claude / Codex 做有限差异化。

### 4.5 新增本地插件生成器

**文件**：`packages/cli/src/generators/local-plugin.ts`

职责：

- 读取源码 manifest
- 应用 `buildConfig`
- 生成运行时 bundle 目录
- 输出 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`

边界：

- 只供 `bundle-plugins.ts` 和测试使用
- `aw init`、`install`、`upgrade`、`status` 不直接调用

### 4.6 Manifest 验证扩展

`packages/cli/src/utils/manifest.ts` 扩展校验能力：

- `plugins/marketplace-source.json`
- `.agents-plugin/plugin.json.marketplace`
- `buildConfig.templates.vars`
- `buildConfig.templates.include`
- `buildConfig.fileRules`
- `buildConfig.manifestOverrides`
- `extensions.*.agentOverrides`

同时增加约束：

- marketplace root metadata 只从 `plugins/marketplace-source.json` 读取；运行时 marketplace `name` 固定写 `aw`
- plugin entry metadata 只从源码 manifest 顶层和 `marketplace` block 派生；不回读 repo 根 runtime marketplace 补字段
- `plugins/marketplace-source.json` 首版只允许 `owner.name`、`owner.url` 与 `interface.displayName`；未知 root 字段直接报错，不做静默忽略
- `.agents-plugin/plugin.json.marketplace` 首版只允许 `category`、`tags`、`strict`、`policy`；其中 `category` / `strict` / `policy.installation` / `policy.authentication` 必填，`tags` / `policy.products` 可选
- `strict` 与 `policy` 的输出 contract 必须显式，`tags` / `policy.products` 的“保留或省略”语义也必须显式；单测和 smoke 直接锁定生成结果
- `manifestOverrides` 只能写白名单字段
- Claude 源码入口统一收口；顶层 `claude` block、`manifestOverrides.claude.hooks`、`manifestOverrides.claude.agents` 一律视为非法输入
- 共享原生字段 `skills`、`mcpServers` 的源码入口固定为顶层相对路径字符串；`mcpServers` 首版不支持 Claude-only inline / mixed array
- 运行时平台 manifest 的路径只能指向生成后的 `claude/` 或 `codex/`；`shared/` 只保留为 bundle 内部实现目录，不能被平台 manifest 直接引用
- 源码 manifest 显式声明 `skills` 时，Claude 侧必须生成 `claude/skills/**`，并显式写入 `.claude-plugin/plugin.json.skills`，不能依赖根目录 `skills/` 自动发现
- `extensions.hooks` / `extensions.agents` 在 Claude 侧必须分别生成 `claude/hooks/hooks.json` 与 `claude/agents/*.md`，并按 4.2.1 / 4.2.2 的规则写入 `.claude-plugin/plugin.json`
- Claude generated bundle 的路径项统一落到 `./claude/...`；`./skills`、`./commands`、`./agents`、`./output-styles`、`./hooks/hooks.json`、`./.lsp.json`、`./.mcp.json` 这类 root 默认 loader 路径一律视为非法输出
- Claude 的路径类字段必须区分校验：`skills`、`commands`、`hooks`、`mcpServers` 的路径项做落点检查；`lspServers` 区分 path / inline；`userConfig`、`channels` 永远不当成路径字段
- Codex native 能力字段必须在源码 manifest 中显式声明；源码目录里只靠默认 `skills/`、`.mcp.json`、`.app.json` 不再算合法输入
- `bundle-plugins.ts` 生成 `.codex-plugin/plugin.json` 时，必须把 `skills`、`mcpServers`、`apps` 写成显式 bundle 路径，不能依赖默认根目录发现

---

## Phase 5: aw install 流程重构

### 5.1 新的 install 流程

```text
aw install <plugin>
  │
  ├─ 1. ensureLocalMarketplace()
  │
  ├─ 2. 通过共享插件目录解析层读取插件清单
  │
  ├─ 3. resolveTargetPlatforms()
  │
  ├─ 4. 读取当前平台真实状态
  │     - Claude：settings + known_marketplaces + installed_plugins
  │     - Codex：~/.codex/config.toml + tracking manifest
  │     - 如目标 scope 已存在非 `aw` 的同名插件，立刻标记 `externalOwnership` 并终止后续改写
  │
  ├─ 5. installPlugin()
  │     - Codex instruction-only 插件在 native 层显式 no-op
  │
  ├─ 6. installExtensions()
  │
  ├─ 7. 按顺序提交 tracking manifest 与 installed.json
  │     - tracking manifest 走 scoped staging / replace，`installed.json` 走 copy-on-write
  │     - 只有 native state、repo-managed artifacts、tracking manifest、账本都成功后，结果才视为完整成功
  │
  ├─ 8. 如任何受管状态已改写但后续提交失败
  │     - best-effort rollback 本次新增 / 删除的 repo-managed artifacts
  │     - native 已改写时，将 installed.json 标记为 `degraded(operation_interrupted_after_native_write)`
  │     - 仅 artifacts / tracking 已改写时，将 installed.json 标记为 `degraded(operation_interrupted_after_artifact_write)`
  │
  └─ 9. 回读状态并输出 warning / drift 提示
```

### 5.2 新的 uninstall 流程

统一规则：

- 显式插件名先走 current catalog 解析，再按 `当前 scope 受管证据` 补历史受管解析；`status` 在前者缺失时还要继续尝试 Claude `platformRuntimeEvidence` 与各平台 `platformNativeFallbackEvidence`；`uninstall` 在前者缺失时继续尝试 `platformNativeFallbackEvidence`
- 只有 `install` 才在 current catalog miss 时直接报 `Unknown plugin`
- `status` / `uninstall` 遇到 current catalog miss 或账本 / tracking manifest 缺口时，只要 `当前 scope 受管证据`、Claude `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 仍存在，就进入历史受控路径
- 显式 `upgrade <plugin>` 遇到同类场景时，只有命中当前 scope 安装时快照才允许进入历史 reconcile；只剩 Claude `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 时必须拒绝升级，并提示先 `uninstall` 再 `install`
- current catalog 命中但当前 scope 没有任何 `当前 scope 受管证据` 时，`status` 在命中 Claude `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 时继续走保守路径；否则显示“当前 scope 未受管”
- current catalog 命中但当前 scope 没有任何 `当前 scope 受管证据` 时，`uninstall` 只有命中 `platformNativeFallbackEvidence` 才继续走保守路径；只剩 Claude `platformRuntimeEvidence` 时返回明确 refusal；否则返回 no-op
- 目标 scope 如果命中 `externalOwnership`，`install` / `upgrade` / `uninstall` 都必须明确拒绝接管；`status` 只显示 `externalOwnership` / drift，不把它并入历史受管集合
- 清理逻辑以真实平台状态和 tracking manifest 为准
- `installed.json` 负责表达 Claude / Codex 的 scope ledger，以及 Codex 的 shared native refs，但不能单独替代平台真值
- 只剩 Claude `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 时，`uninstall` 只能执行当前证据足以证明安全的 native 清理；如果剩余引用、scope 归属或历史能力无法证明，命令必须返回明确 drift / refusal，而不能退化成 `Unknown plugin`
- install / uninstall / upgrade 共用同一套失败语义：任何受管状态一旦已改写，后续 tracking manifest 或 `installed.json` 提交失败就必须把账本降级，不能留下 `available` + 缺口记录
- 降级原因按最早的不可证明回滚写入区分：native 已改写用 `operation_interrupted_after_native_write`；只有 repo-managed artifacts / tracking manifest 已改写用 `operation_interrupted_after_artifact_write`
- 对上面枚举的切换前基线状态不提供兼容清理路径；这类状态在当前版本只作为外部 drift 对待，不参与自动回收推断

Claude：

1. 读取当前 scope `settings.json`
2. 调原生 uninstall，并显式带 `--scope <scope>`
3. 回读当前 scope `settings.json`
4. 回读 `~/.claude/plugins/known_marketplaces.json` 和 `~/.claude/plugins/installed_plugins.json`
5. 以这三层回读结果为准，清理 tracking manifest 记录的权限扩展产物
6. 先以 scoped staging / replace 提交 tracking manifest，再用 copy-on-write 替换 `installed.json`
7. 如第 2 步之后出现提交失败，按统一失败语义将账本标记为 `degraded`

Codex：

- `scope=project`
  - 只清当前 repo 的 repo-managed artifacts
  - 如安装时快照显示插件无需 native state，不触碰 `~/.codex/config.toml`
  - 如安装时快照显示插件需要 native state，先仅从规范化后的 `sharedNativeRefs.projects` 移除当前 `codexProjectKey`
  - 只有账本明确显示当前插件 `sharedNativeRefs = { user: false, projects: [] }` 时，才继续清理当前插件自己的 shared user plugin enabled
  - `[marketplaces.aw]` 只在全量扫描确认没有任何其它 native plugin 仍保留 shared refs，且不存在不明确 `sharedNativeRefs` 条目时才清理
  - 只存在共享 user native state、但当前 repo 没有 `projectScopes[codexProjectKey]` / tracking manifest / `sharedNativeRefs.projects[codexProjectKey]` 时，不得把它当成当前 repo 的 fallback uninstall 证据
- `scope=user`
  - 清 user scope 受管产物
  - 先移除 `userScope`，并把 `sharedNativeRefs.user` 写成 `false`
  - 仅在安装时快照显示插件需要 native state，且账本明确显示 `sharedNativeRefs.projects` 为空时清当前插件的 user plugin enabled
  - `[marketplaces.aw]` 只在全量扫描确认没有任何其它 native plugin 仍保留 shared refs，且不存在不明确 `sharedNativeRefs` 条目时再清理
  - 只剩 `platformNativeFallbackEvidence`、但拿不到 `capabilitySnapshot` / `sharedNativeRefs` 时，只能执行当前证据足以证明安全的 native 清理；如无法证明没有 project 共享引用，或无法证明 marketplace 已无其它 native plugin 使用者，命令必须返回明确 refusal
- 两个 scope 都在 native / artifacts 清理完成后，先提交 tracking manifest，再用 copy-on-write 替换 `installed.json`
- 如 native 或 artifacts 已改写但提交失败，按统一失败语义将账本标记为 `degraded`

### 5.3 upgrade 流程

`upgrade` 改为“原生层 + 产物层”双刷新，不再只做扩展重建。

流程：

1. `ensureLocalMarketplace()`
2. 通过共享插件目录解析层枚举显式插件或 `--all` 候选，并同时读取当前 scope 的受管插件集合
3. 读取 `installed.json` 的 `ledgerState`
4. 为每个目标插件派生 `scopeInitialized`，并在命中 `当前 scope 受管证据`、Claude `platformRuntimeEvidence` 或可用的 `platformNativeFallbackEvidence` 时派生相应诊断
5. `--all` 遇到 `ledgerState.status = degraded` 直接拒绝执行；如任一受管插件不是 `catalogCompatibility = current`，也直接拒绝并列出待显式处理插件
6. 显式 `upgrade <plugin>`
  - `catalogCompatibility = current` 时，按当前 manifest 升级
  - `catalogCompatibility = capabilityChanged` 时，先按安装时快照与 tracking manifest 做能力收缩，再安装当前 manifest，并在成功后重写快照
  - `catalogCompatibility = missing` 时，拒绝升级并提示先 `uninstall`
  - 只剩 Claude `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence`、但没有安装时快照时，拒绝升级并提示先 `uninstall` 再 `install`
7. 对允许进入升级链路的插件先刷新 native state
8. 再重建 repo-managed artifacts
9. 按固定顺序提交 tracking manifest 与 `installed.json`：先提交 tracking manifest，再用 copy-on-write 替换 `installed.json`
10. 如 native state、repo-managed artifacts 或 tracking manifest 已改写但提交失败，按统一失败语义将账本标记为 `degraded`
11. 回读状态并输出 drift warning

行为约束：

- 未初始化插件不能被隐式 upgrade
- `--all` 只升级当前 scope 已初始化的插件
- `scopeInitialized = unknown` 时，不能进入 `--all` 候选集
- `catalogCompatibility = missing | capabilityChanged` 时，插件不能进入 `upgrade --all` 候选集
- `--all` 不要求当前 `cwd` 有本地 `plugins/`
- 命中 `externalOwnership` 的插件不能进入任何 upgrade 链路；显式 `upgrade <plugin>` 也必须拒绝接管
- 对 Claude `user` / `project` scope，`scopeInitialized` 只看 `installed.json.platforms.claude.userScope` 或 `projectScopes[claudeProjectKey]`，不能从 `settings.json` 或 `installed_plugins.json` 反推
- native-only Codex 插件不进入 `--scope project` 的 upgrade 集合
- 对 Codex `user` scope，`scopeInitialized` 只看 `installed.json.platforms.codex.userScope`，不能因为 shared native ref 或 `nativeInstalled = true` 被误纳入集合
- 对 Codex `project` scope，只存在 shared user plugin enabled / marketplace state、但当前 repo 没有 tracking manifest 记录的插件，不能进入 upgrade 集合
- 账本处于 `degraded` 时，显式 `upgrade <plugin> --platform <platform>` 仍可执行，但命令结束后只能刷新目标插件自己的 ledger 记录，不能把其他缺失记录整体解释成 `no`

### 5.4 status 流程

`status` 保持只读：

- 不触发 `aw init`
- 不物化 marketplace
- 不修复 drift

输出按四段展示：

1. native state
2. scope initialized / catalog compatibility
3. generated artifacts
4. repo-managed session state / reason

Claude 的 native state 至少拆出：

- 当前 scope 是否声明 marketplace / enabled plugin
- 当前 scope `aw` 声明的 source 是否经同口径归一化后仍指向当前 `~/.aw`
- `~/.claude/plugins/known_marketplaces.json` 是否已物化
- `~/.claude/plugins/installed_plugins.json` 是否存在匹配当前 scope 语义的记录
- 当前 scope 是否存在 `externalOwnership`（同名插件已由非 `aw` marketplace 管理）
- 当前 scope tracking manifest 是否仍记录 `extensions.instructions` / `extensions.permissions` 受管产物
- `currentCatalog` 是否命中当前 plugin，以及其 runtime bundle manifest 是否包含 `extensions.hooks` / `extensions.agents` 对应的原生字段
- `activeLocalBundle` 是否仍可按 `known_marketplaces.installLocation + source` 解析；如果不可解析，要明确显示当前原生 loader 指向的是旧 bundle、坏 bundle 或缺失路径
- `scopeInitialized`
  - 只看 `~/.aw/installed.json` 中 `platforms.claude.userScope` 或 `projectScopes[claudeProjectKey]`
  - `ledgerState.status = degraded` 且缺失对应 scope 记录时，显示为 `unknown`
- 如 ledger / tracking manifest 缺失，但 `settings.json` + `known_marketplaces.json` + `activeLocalBundle` 仍能证明默认 startup loader 会读取 `<plugin>@aw`，要单独显示 `platformRuntimeEvidence`
- 如 ledger / tracking manifest 缺失，但 `settings.json` + 匹配当前 scope 语义的 `installed_plugins.json` 仍命中 `<plugin>@aw`，要单独显示 `platformNativeFallbackEvidence`

Codex 的状态展示至少拆出：

- marketplace 是否注册
- plugin 是否 enabled
- 当前 scope 是否存在 `externalOwnership`（同名插件已由非 `aw` marketplace 管理）
- `scopeInitialized`
- 如命中 `当前 scope 受管证据`，或在 current catalog miss 时命中 `platformNativeFallbackEvidence`，则显示相应的 `catalogCompatibility`
- 如 ledger / tracking manifest 缺失，但 `scope=user` 仍命中 `[plugins."<plugin>@aw"].enabled = true`，要单独显示 `platformNativeFallbackEvidence`
- `sharedNativeRefs`
- 是否 `not required`
- 当前 scope tracking manifest 是否存在生成产物
- `projectTrust`
- `extensions.instructions` 的 `instructionsSessionState`
- `extensions.permissions` / `extensions.hooks` / `extensions.agents` 的 `repoManagedSessionState.rules`、`repoManagedSessionState.hooks`、`repoManagedSessionState.agents`

`installed.json` 会直接贡献 Claude / Codex 的 `scopeInitialized`，以及 Codex 的 `sharedNativeRefs` 展示，但不能被误当成 Claude / Codex 的原生平台真值。

补充规则：

- `scopeInitialized` 的输出值固定为 `yes`、`no`、`unknown`
- `ledgerState.status = degraded` 且当前插件缺少显式 ledger 记录时，`scopeInitialized` 必须显示为 `unknown`
- current catalog 命中但当前 scope 没有受管证据、且也没有 `platformRuntimeEvidence` / `platformNativeFallbackEvidence` 时，`status` 不显示 `catalogCompatibility`，而是明确展示“当前 scope 未受管”
- current catalog miss 但仍有 `当前 scope 受管证据` 时，`status` 显示 `catalogCompatibility = missing` 与受控清理提示，不报 `Unknown plugin`
- current catalog miss 且只剩 `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 时，`status` 仍要进入受控历史展示；前者明确提示“原生 loader 仍会读取，但 CLI 缺少安装元数据 / tracking manifest”，后者再补充“平台安装记录仍在”
- current catalog 存在但能力变化时，`status` 显示 `catalogCompatibility = capabilityChanged`，并区分“当前目标态”和“历史安装快照”
- 命中 `externalOwnership` 时，`status` 明确显示 `externalOwnership` / drift，不把它并入 `platformRuntimeEvidence`、`platformNativeFallbackEvidence` 或 `catalogCompatibility`
- `sharedNativeRefs` 任一子字段缺失、非法或无法规范化时，`status` 只能报 drift / unknown，不能暗示“已无剩余引用”
- `status` 需要补一条说明：平台真值仍会正常回读，但 CLI 账本当前不可完整推断

### 5.5 `--platform auto|both`

平台推断规则如下：

- `status --platform auto` 在双平台环境下展示两边状态
- 会修改状态的命令里，`--platform auto` 以 `scopeInitialized` 为准
- 只要任一候选平台的 `scopeInitialized = unknown`，会修改状态的 `--platform auto` 就必须拒绝自动推断，并要求显式传 `--platform`
- 双平台同时可用但无法唯一推断时，`auto` 必须报错
- `--platform both` 只在同时检测到两个平台时可用

### 5.6 作者工具、夹具和文档同步

这次切换不能只改运行时命令链路，作者工具和仓库内辅助资产也要一起收敛到单一真值。

- `create-agent-workflows-plugin` skill、`scripts/init_plugin.js`、`references/*.md` 全部改成“源码 manifest + build bundle”模型
- 插件脚手架只创建 `plugins/<name>/` 下的源码结构与带 `marketplace` block 骨架的 `.agents-plugin/plugin.json`，不再写 runtime marketplace，也不再生成源码树 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`
- 作者工具和参考文档必须明确：共享 `hooks` / `agents` 继续写 `extensions.*`，不能再教用户写顶层 `claude` block 或 `manifestOverrides.claude.hooks` / `agents`
- 作者工具和参考文档必须明确：`plugins/marketplace-source.json` 是源码输入，不是运行时真值；entry 级 marketplace 元数据写在插件自己的 `.agents-plugin/plugin.json.marketplace`
- `packages/cli/tests/fixtures/**` 和 `packages/cli/tests/integration/cli.test.ts` 全部切到 `embedded plugins root` 与 `~/.aw` 作为运行时输入；Vitest 源码仓库测试通过 shared helper 生成临时 synthetic embedded root，真实 `packages/cli/plugins-dist` 只留给 `tests/smoke/**` 里的 build/pack smoke 与已 build CLI
- 必须补一条作者工具回归：真实执行 `init_plugin.js` 后，断言只生成源码结构与带 `marketplace` block 的 `.agents-plugin/plugin.json`，不会生成 runtime marketplace，也不会偷偷改写 `plugins/marketplace-source.json`
- 必须补一条参考文档同步校验：`SKILL.md` 与 `references/*.md` 不能再指导生成源码树平台 manifest，也不能再把 repo 根 marketplace 当运行时真值；要明确区分 `plugins/marketplace-source.json` 这种源码输入和 build 产物
- 旧模型文档按“继续维护”与“历史保留”两类处理
  - `docs/dev/plans/project-init.md`、`docs/codex-claude-plugin-marketplace-research.md` 这类保留背景价值但不再作为当前实施依据的文档，统一标记为“历史文档”，并在文首明确旧模型已失效、当前方案以本文为准
  - `docs/dev/plans/npm-plugin-marketplace.md`、`docs/dev/plans/npm-plugin-marketplace-copy.md` 这两份同主题旧计划不能继续以活动方案保留；要么删除，要么在文首显式标记为“历史文档”并回链当前计划
  - 仍会继续维护的文档至少包括 `docs/dev/plans/codex-repo-managed-artifacts.md`；这类文档必须同步到 `embedded plugins root + ~/.aw` 新模型，如果同批来不及改完，先改成历史文档，不能继续以“当前推荐做法”的口吻保留旧模型
- 历史文档标记至少说明三件事：适用背景、旧模型已失效、以及当前应回看的执行计划链接
- 必须补一条同主题计划清理验收：同目录下已被替代的 npm marketplace 计划不能继续和本文并列为活动计划
- 必须补一条文档清单验收：仓库内所有未标记为历史的活动文档，不能再把 repo 根 marketplace、源码树 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`、或“命令阶段生成 runtime manifest”的旧模型写成当前默认路径
- 运行时、脚手架、文档、夹具必须同时收敛到同一套模型

---

## 涉及的关键文件清单

### 新建文件

| 文件 | 用途 |
|------|------|
| `plugins/marketplace-source.json` | marketplace root 级源码元数据，供 build 重建 runtime marketplace |
| `packages/cli/src/commands/init.ts` | `aw init` 命令 |
| `packages/cli/src/generators/local-plugin.ts` | build 阶段运行时插件生成器 |
| `packages/cli/src/utils/local-marketplace.ts` | `~/.aw` 管理、bundle freshness / 完整性校验，以及 `installed.json` 的保留 / 降级规则 |
| `packages/cli/src/utils/plugin-catalog.ts` | 共享插件目录解析、`sourceVersion + bundleFingerprint` freshness 判定与 current catalog 选择 |
| `packages/cli/src/utils/native-cli.ts` | 原生命令调用封装 |
| `packages/cli/src/utils/codex-config.ts` | `config.toml` 中 marketplace / plugin enabled / `developer_instructions` 的 round-trip 编辑能力 |
| `packages/cli/src/utils/template-engine.ts` | `buildConfig.templates` 模板处理 |
| `packages/cli/scripts/bundle-plugins.ts` | 构建时打包插件数据和 marketplace 清单 |
| `packages/cli/tests/smoke/build-smoke.test.ts` | `pnpm build` 输出边界校验 |
| `packages/cli/tests/integration/codex-config-smoke.test.ts` | `codex-config.ts` 的 build-free round-trip gate |
| `packages/cli/tests/helpers/embedded-root.ts` | 生成临时 synthetic embedded root，并注入测试用 runtime override |
| `packages/cli/tests/unit/marketplace.test.ts` | marketplace mirror 与 `source` 规则测试 |
| `packages/cli/tests/unit/codex-config.test.ts` | `marketplaces` / `plugins` / `developer_instructions` 的 round-trip golden 测试 |
| `packages/cli/tests/unit/file-rules.test.ts` | `buildConfig.fileRules` 测试 |
| `packages/cli/tests/unit/template-engine.test.ts` | `buildConfig.templates` 测试 |
| `packages/cli/tests/unit/build-config.test.ts` | `buildConfig` 校验测试 |
| `packages/cli/tests/smoke/pack-smoke.test.ts` | repo root `pnpm pack:cli` tarball 内容与 embedded runtime smoke |
| `packages/cli/tests/integration/authoring-tools.test.ts` | 回归 `init_plugin.js`、参考文档同步，以及 runtime marketplace 禁写与源码 metadata contract |
| `packages/cli/tests/fixtures/codex-config/**` | `codex-config.ts` 的 golden fixtures |

### 修改文件

| 文件 | 变更 |
|------|------|
| `package.json` | 仓库根 `build` / `test` / `smoke` / `pack:cli` 代理入口，统一 monorepo 验证 contract |
| `packages/cli/package.json` | 发布配置、build / smoke 脚本，以及 `codex-config.ts` 需要的 TOML round-trip parser 依赖 |
| `packages/cli/vitest.config.ts` | 常规测试与 smoke 测试的 include / exclude contract |
| `plugins/*/.agents-plugin/plugin.json` | 补充 `marketplace` entry metadata，并继续作为源码 manifest 真值 |
| `packages/cli/src/index.ts` | 注册 `aw init` |
| `packages/cli/src/commands/install.ts` | 接入 `ensureLocalMarketplace()` 和新流程 |
| `packages/cli/src/commands/uninstall.ts` | 按新 scope 语义清理 |
| `packages/cli/src/commands/upgrade.ts` | 改为“原生层 + 产物层”双刷新 |
| `packages/cli/src/commands/status.ts` | 分层展示状态 |
| `packages/cli/src/commands/common.ts` | 接入共享插件解析，并移除命令阶段 manifest 同步副作用 |
| `packages/cli/src/adapters/claude.ts` | 走原生 CLI，并按三层状态读写 Claude |
| `packages/cli/src/adapters/codex.ts` | 接入 `requiresNativePlugin`、`catalogCompatibility`、user-only native state、repo-managed artifacts |
| `packages/cli/src/adapters/helpers.ts` | 增补 Claude settings、`known_marketplaces.json`、`installed_plugins.json` 的 scope-sensitive 解析、`activeLocalBundle` / `platformRuntimeEvidence` / `platformNativeFallbackEvidence` 所需的辅助读取、`externalOwnership` 检测，并让 Codex 旧轻量 parser 退出写回职责 |
| `packages/cli/src/generators/instructions.ts` | Claude rules 生成与 Codex `developer_instructions` 文本聚合渲染 |
| `packages/cli/src/generators/permissions.ts` | Claude 受管 permissions 与 Codex `.rules` 渲染 |
| `packages/cli/src/generators/hooks.ts` | Claude runtime hooks bundle 生成与 Codex `hooks.json` 渲染 |
| `packages/cli/src/generators/agents.ts` | Claude runtime agents bundle 生成与 Codex agent role 输出，并满足上游 role file 契约 |
| `packages/cli/src/utils/paths.ts` | `~/.aw`、bundled plugins、Claude 固定 plugins 目录，以及 `resolveEmbeddedPluginsRoot()` 的内部 override、对齐上游当前 project 边界语义的 `claudeProjectKey` / `codexProjectKey`、Codex project / user `config.toml` 路径解析 |
| `packages/cli/src/utils/manifest.ts` | 源码 manifest、`plugins/marketplace-source.json` 与 `marketplace` entry metadata 解析校验，以及 build-time 运行时 manifest 生成输入 |
| `packages/cli/src/utils/tracking.ts` | tracking manifest 追踪生成产物，并作为 status / cleanup 的辅助输入 |
| `packages/cli/src/utils/detect.ts` | 纳入 Codex project trust、layer enabled/disabled 判定、`developer_instructions` / `rules` / `hooks` / `agents` 落点识别，以及 `instructionsSessionState` / `repoManagedSessionState` 与外部 layer overlay 诊断判定 |
| `packages/cli/src/types.ts` | 扩展 marketplace root / entry 源码元数据、`buildConfig`、Claude / Codex 扩展归属、`ledgerState`、`scopeInitialized = yes|no|unknown`、`capabilitySnapshot`、按 `当前 scope 受管证据` / `platformRuntimeEvidence` / `platformNativeFallbackEvidence` 派生的三态 `catalogCompatibility`、`platformRuntimeEvidence` / `platformNativeFallbackEvidence` / `externalOwnership` 诊断、失败降级原因、`requiresNativePlugin`、`instructionsSessionState`、`repoManagedSessionState` 与外部 layer overlay 诊断表达 |
| `packages/cli/tests/unit/manifest.test.ts` | 断言运行时真值只来自 `embedded plugins root` 与 bundle |
| `packages/cli/tests/unit/generators.test.ts` | 更新 Codex `developer_instructions` 聚合写入与 agents 新落点语义 |
| `packages/cli/tests/unit/detect.test.ts` | 覆盖 instruction-only 插件、Codex `developer_instructions` 落点检测，以及 `rules` / `hooks` / `agents` 的 trust 可见性 |
| `packages/cli/tests/integration/cli.test.ts` | 改写关键回归到 `embedded plugins root` / `~/.aw` / Codex 新模型 |
| `packages/cli/tests/fixtures/**` | 夹具切换到运行时 bundle 与本地市场新模型 |
| `.agents/skills/create-agent-workflows-plugin/SKILL.md` | 同步源码 / 运行时边界和作者工作流 |
| `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js` | 脚手架改成只生成源码结构 |
| `.agents/skills/create-agent-workflows-plugin/references/*.md` | 同步 source manifest、bundle 和平台边界文档 |
| `docs/dev/plans/project-init.md` | 标记为历史文档，并注明 repo 根 marketplace / 源码树 platform manifest 模型已被当前方案替代 |
| `docs/codex-claude-plugin-marketplace-research.md` | 标记为历史调研文档，并回链当前执行计划，避免继续把旧 marketplace 结构当现行方案 |
| `docs/dev/plans/npm-plugin-marketplace.md` | 删除或标记为历史文档，避免与当前执行计划并列为活动方案 |
| `docs/dev/plans/npm-plugin-marketplace-copy.md` | 删除或标记为历史文档，避免与当前执行计划并列为活动方案 |
| `docs/dev/plans/codex-repo-managed-artifacts.md` | 作为继续维护的计划文档与本方案保持一致；如果同批无法同步完成，先显式标记为历史文档并列出失效范围 |
| `.gitignore` | 忽略 `packages/cli/plugins-dist` |

### 删除文件

| 文件 | 变更 |
|------|------|
| `.claude-plugin/marketplace.json` | 从仓库移除，运行时 marketplace 只保留在 `plugins-dist` 与 `~/.aw` |
| `.agents/plugins/marketplace.json` | 从仓库移除，运行时 marketplace 只保留在 `plugins-dist` 与 `~/.aw` |
| `plugins/*/.claude-plugin/plugin.json` | 从源码树移除 generated 版本 |
| `plugins/*/.codex-plugin/plugin.json` | 从源码树移除 generated 版本 |

---

## 实施顺序

1. **批次 A（原 Phase 1 + Phase 4）**：build-time contract 与发布/打包链路
   - root + `packages/cli/package.json` / `tsconfig`
   - `plugins/marketplace-source.json`
   - `types.ts` / `manifest.ts`
   - `.agents-plugin/plugin.json.marketplace`
   - `buildConfig`
   - `template-engine`
   - `fileRules`
   - 受限 `manifestOverrides`
   - `local-plugin.ts`
   - `bundle-plugins.ts`
   - `plugins-dist`
   - 删除源码树和 repo 根运行时 generated manifest
   - 里程碑 smoke：`pnpm build` 能稳定产出 `plugins-dist`，并通过最小 `bundle-plugins` / catalog 读取校验
   - 同批冻结源码仓库运行 / 测试契约：已 build CLI 读真实 `plugins-dist`，Vitest 读 synthetic embedded root，不再依赖旧 repo-root marketplace
2. **批次 B（Phase 2）**：`~/.aw` 本地市场
   - `aw init`
   - `ensureLocalMarketplace()`
   - `validateLocalMarketplaceLayout()`
   - staging + 原子替换
   - `installed.json` 管理账本
   - 里程碑 smoke：临时 home 下 `aw init --force` 与 `validateLocalMarketplaceLayout()` 闭环通过
3. **批次 C（Phase 3.0）**：`codex-config.ts` feasibility gate
   - `toml-eslint-parser`
   - `codex-config` golden fixture
   - 独立 build-free smoke
   - range patch round-trip 验证
4. **批次 D（Phase 3）**：平台原生安装链路
   - `native-cli.ts`
   - Claude 三层状态
   - Codex `requiresNativePlugin`
   - `codex-config.ts`
5. **批次 E（Phase 5）**：命令串联
   - `install`
   - `uninstall`
   - `upgrade`
   - `status`
   - `--platform auto|both`
6. **测试与文档收尾**
   - 单元测试
   - 集成测试
   - repo root `pnpm pack:cli` smoke
   - 生成器与开发文档同步
   - 旧模型文档的历史标记、回链和活动文档清单验收

---

## 验证方式

测试使用 Vitest 体系，重点覆盖下面这些场景。

### 单元测试

- `bundle-plugins`
  - source-level 的 `bundle-plugins` 纯逻辑 contract，不直接执行 `dist/scripts/bundle-plugins.js`
  - 源码插件到运行时 bundle 的目录结构
  - `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 的生成结果
  - root metadata 来自 `plugins/marketplace-source.json`，不会回读 repo 根 runtime marketplace
  - 双 marketplace manifest 的 `source` 统一为 `./plugins/<plugin>`
  - 双 marketplace manifest 会保留 root `owner` / `interface`，以及 entry `category` / `tags` / `strict` / `policy`
  - 共享 `skills` 会生成 `claude/skills/**`，并且 `.claude-plugin/plugin.json.skills` 显式引用 `./claude/skills`，不会退回 root `./skills`
  - `.codex-plugin/plugin.json` 的 `skills`、`mcpServers`、`apps` 始终写成显式 bundle 路径
  - 共享 `mcpServers` 只接受 path-only 源输入；`.claude-plugin/plugin.json.mcpServers` 与 `.codex-plugin/plugin.json.mcpServers` 都写成显式 bundle 路径
  - `extensions.hooks` 会生成 `claude/hooks/hooks.json`，并且 `.claude-plugin/plugin.json.hooks` 只会引用 `./claude/hooks/hooks.json`
  - `extensions.agents` 会生成 `claude/agents/*.md`，写入 `.claude-plugin/plugin.json.agents`，且生成的 agent 文件保留 `name`、`description`、`tools` frontmatter 与原样 `prompt` 正文
- `buildConfig`
  - `templates`
  - `fileRules`
  - 受限 `manifestOverrides`
  - 路径类字段 `outputStyles`
  - Claude runtime manifest 的路径项统一归一化到 `./claude/**`，不会退回到 root 默认 loader 路径
  - `lspServers` 的 path / inline / mixed array
  - 共享 `mcpServers` 的 path-only 作者模型与 namespaced path rewrite
  - inline 字段 `userConfig`、`channels`
  - `agentOverrides`
  - `manifestOverrides.claude` 不允许再声明 `hooks` / `agents`
- `plugin-catalog`
  - `~/.aw` / `embedded plugins root` 的解析优先级
  - `sourceVersion` 或 `bundleFingerprint` freshness mismatch 时优先回退到 `embedded plugins root`
  - catalog 解析只读
  - `resolveEmbeddedPluginsRoot()` 在源码仓库缺少 `packages/cli/plugins-dist` 时给出显式错误，不回退旧输入
  - `resolveEmbeddedPluginsRoot()` 的内部 override 只能指向通过同一套布局校验的 synthetic embedded root
- `local-marketplace`
  - `init`
  - `ensureLocalMarketplace`
  - 同版本损坏目录自动修复
  - 同版本重 build 后只要 embedded bundle 内容变化，就会通过 `bundleFingerprint` 触发刷新
  - 只要 `installed.json` schema 合法，就会在 `--force` 下保留
  - marketplace `source`、platform manifest 路径与 bundle 真实文件的完整性校验
  - Claude runtime manifest 里 `skills`、`commands`、`agents`、`hooks`、`outputStyles`、`mcpServers` 的路径项全部落在 `./claude/**`，不会混入 root 默认 loader 路径
  - platform manifest 直接引用 `./shared/**` 时，`validateLocalMarketplaceLayout()` 与 manifest 校验会直接失败
  - Claude 的 `skills`、`commands`、`hooks`、`mcpServers` 只接受路径项并做落点检查；`lspServers` 继续区分 path / inline，`userConfig`、`channels` 不会被误当成路径
  - `installed.json` 缺失或结构非法时写出 `degraded ledger`，而不是健康空账本
  - `sourceVersion` 或 `bundleFingerprint` 变化只触发本地 bundle 刷新，不触发账本丢弃
- `installed-ledger`
  - 账本读写
  - `ledgerState = available | degraded`
  - `scopeInitialized = yes | no | unknown`
  - scope 级 `resolvedVersion` 与平台化 `capabilitySnapshot`
  - Claude `capabilitySnapshot.managedExtensions`
  - Codex `capabilitySnapshot.requiresNativePlugin | hasRepoManagedArtifacts`
- `catalogCompatibility = current | missing | capabilityChanged`
- `当前 scope 受管证据` 按 scope-sensitive 规则判定，Codex `sharedNativeRefs` 只有命中当前 scope 时才算证据
- Claude `platformRuntimeEvidence` 只用于 `status` 的恢复与 drift 展示；`platformNativeFallbackEvidence` 只用于 `status` 补充说明和 `uninstall` 的保守恢复；两者都不把 `scopeInitialized` 改成 `yes`，也不单独授权显式 `upgrade`
- current catalog 命中但当前 scope 无受管证据、且也没有 Claude `platformRuntimeEvidence` / `platformNativeFallbackEvidence` 时，`catalogCompatibility` 字段缺失，不引入 `not_applicable`
  - 账本与真实状态冲突时不参与真值判定
  - `ledgerState = degraded` 时，缺失记录不能被解释成 `no`
  - native state 已改写但 tracking manifest / `installed.json` 提交失败时，账本切到 `degraded(operation_interrupted_after_native_write)`
  - instruction-only / artifact-only 路径下，repo-managed artifacts 或 tracking manifest 已改写但账本提交失败时，账本切到 `degraded(operation_interrupted_after_artifact_write)`
  - Claude `userScope` / `projectScopes[claudeProjectKey]` 可以独立增删，不再用 `lastRequestedScope` 代替当前受管集合
  - Codex `sharedNativeRefs` 的终态固定为 `{ user: boolean, projects: string[] }`
  - `sharedNativeRefs.user` 不会靠删除字段表达“false”
- Claude 状态解析
  - scope `settings.json`
  - 当前 scope marketplace declared source 是否仍指向当前 `~/.aw`
  - `~/.claude/plugins/known_marketplaces.json`
  - `~/.claude/plugins/installed_plugins.json`
- scope ledger 的 `resolvedVersion` 与 `capabilitySnapshot.managedExtensions`
- `scope=user` / `scope=project` 的 `installed_plugins.json` 相关性按上游规则分别判断，不能混用“当前项目相关”这类泛化语义
- ledger / tracking manifest 缺失时，`settings.json + known_marketplaces.json + activeLocalBundle` 可单独派生 `platformRuntimeEvidence`；`settings.json + installed_plugins.json` 只有命中匹配当前 scope 语义的记录，才派生 `platformNativeFallbackEvidence`
  - 同名插件已由非 `aw` marketplace 管理时，单独标记为 `externalOwnership`
  - 本地目录 marketplace 的相对 `source` 以 `known_marketplaces.json.installLocation + source` 解析当前 bundle，而不是走 `installed_plugins.json.installPath`
  - `installed_plugins.json.installPath` 只参与安装相关性、scope 过滤与诊断，不承担当前本地 bundle 内容判定
  - 同一仓库不同子目录分别做 Claude `--scope project` 安装时，`installed.json` 与 `status` 必须按 `claudeProjectKey` 保持独立 project 记录
  - `claudeProjectKey` 对齐上游当前 project 身份语义：`settings.json` root 侧对齐 `resolve(getOriginalCwd())`，`installed_plugins.json.projectPath` 侧对齐 `getOriginalCwd()` 原值；两者都落在上游启动阶段 canonicalize 后的同一 real path，CLI 不得再叠加第二层 canonical 化，也不能退回 raw cwd
  - `status` 在 `~/.aw` 过期、缺失或损坏时，会把 `embedded plugins root` 作为 `currentCatalog`，但仍要单独报告 `activeLocalBundle`
  - marketplace add 的 scope 必须跟随目标安装 scope，而不是默认写 `user`
  - install 前对 marketplace 声明层 + 物化层的双检查，其中声明层要覆盖 declared source drift，而不是只看是否存在 `aw`
  - 卸载后重新回读目标 scope `settings.json`、`known_marketplaces.json`、`installed_plugins.json`
- 仅依赖原生 runtime manifest、没有 tracking manifest 的 Claude 插件，在 ledger 缺失、current catalog miss、甚至 `installed_plugins.json` 缺失后，只要 `settings.json + known_marketplaces + activeLocalBundle` 仍能证明 loader 会读取该插件，`status` 也不能退化成 `Unknown plugin`；`uninstall` 至少进入受控 refusal
  - `managedExtensions` 变化时，Claude 可派生 `catalogCompatibility = capabilityChanged`
  - 只有原生 manifest / `./claude/**` bundle 内容变化、但 `managedExtensions` 不变时，Claude 仍保持 `catalogCompatibility = current`；这类变化由 `ensureLocalMarketplace()` 刷新 `~/.aw` 吸收，不阻断 `upgrade --all`
  - `extensions.instructions` 的 install / status / uninstall 回归
  - `extensions.permissions` 仍通过受管 `settings.json` 区段写入与清理
  - `extensions.hooks` / `extensions.agents` 的作者输入到 Claude runtime manifest 与 `claude/agents/*.md` 文件格式的映射
  - 共享 `skills` 会显式写回 `.claude-plugin/plugin.json.skills = "./claude/skills"`，而不是只复制目录
  - Claude generated bundle 的 `./claude/**` 路径契约，以及 root 默认 loader 路径非法化校验
  - 共享 `mcpServers` 维持 path-only 源输入，`.claude-plugin/plugin.json.mcpServers` 归一化到 `./claude/...`
  - `commands`、`lspServers` 的路径与结构校验
  - `outputStyles` 路径落点与 `userConfig` / `channels` 结构校验
- Codex
  - `requiresNativePlugin`
  - 默认 `skills/`、`.mcp.json`、`.app.json` 存在但 manifest 未声明时直接报错
  - 共享 `mcpServers` 以 path-only 源输入时，双端 manifest 都能生成且语义一致；Claude inline / mixed MCP 源输入会在校验阶段直接失败
  - `hasRepoManagedArtifacts`
  - `catalogCompatibility`
  - `codex-config` round-trip
  - `codex-config` 写回 `[marketplaces.aw]` 时必须包含 `source_type = "local"` 和 `source = "<~/.aw canonical directory path>"`，不能把 `.agents/plugins/marketplace.json` 写成 source
  - 按 Codex 上游 `installed_marketplace_roots_from_layer_stack()` 语义反推 marketplace roots 时，能把 `[marketplaces.aw]` 解析回 `~/.aw`
  - `codex-config` 读取到 manifest 文件路径 source 时必须视为错误配置并修复
  - 多行 `developer_instructions` + 注释 + 无关 section 共存时的 round-trip 保真
  - `codex-config` golden fixture 在连续多次增量写入 / 删除后保持稳定
  - 插件 instruction 正文命中 `[[aw-managed:` sentinel 前缀时明确拒绝
  - 用户手写 `# aw:` 标题或普通 Markdown 文本不会被误判成受管区块
  - `codex-config` 命令链路接入前的独立 build-free smoke
  - project `.codex/config.toml` 的 `developer_instructions` 聚合写入
  - user `~/.codex/config.toml` 的 `developer_instructions` 聚合写入
  - `.codex/agents/*.toml` 生成结果可通过与上游一致的 role file 契约校验
  - `extensions.agents.prompt -> developer_instructions`
  - `extensions.agents.tools` 不写入 Codex role file
  - project trust：`trusted` / `untrusted` / `unknown`
  - canonical path / raw path alias 的 trust regression
  - `cwd/config.toml`、tree `.codex/config.toml` 在 trusted 且 enabled 时命中 `instructionsSessionState.unknownByExternalLayer`
  - `cwd/config.toml`、tree `.codex/config.toml` 在 untrusted 且 disabled 时不遮蔽 user scope
  - user `.codex/rules/*.rules` 与 trusted project `.codex/rules/*.rules` 同时存在时，`repoManagedSessionState.rules = visible`，并额外报告 external overlay 诊断
  - user `.codex/hooks.json` 与 trusted project hooks 同时存在时，`repoManagedSessionState.hooks = visible`，并额外报告 external overlay 诊断
  - `.codex/agents/*.toml` 在 `trusted` / `untrusted` / `unknown` 下的 `repoManagedSessionState.agents`
  - enabled 更高优先级 layer 只有在命中同名 agent role 时，user `repoManagedSessionState.agents` 才记为 `unknownByExternalLayer`
  - 没有 `.codex/config.toml`、只有 `.codex/hooks.json` / `.codex/rules/` / `.codex/agents/` 时，project trust 仍然生效
  - tracking manifest、`scopeInitialized`、`instructionsSessionState` 与 `repoManagedSessionState`
  - hybrid 插件先做 `scope=project` 安装时，user scope 不能被误记成 initialized
  - repo A 里的 hybrid 插件只做过 `scope=project` 安装后，在 repo B 执行 `status / uninstall / upgrade <plugin> --scope user` 时，不会因为 `sharedNativeRefs.projects = [repoA]` 被误判成当前 scope 仍受管
  - 当前 repo 没有 `projectScopes[codexProjectKey]`、tracking manifest，也没有命中本 repo 的 `sharedNativeRefs.projects` 时，`status --scope project` 明确显示当前 scope 未受管
  - `upgrade --all --scope user` 不会因为 shared native ref 被误纳入集合
  - user uninstall 在仍有 project 引用时不会提前删掉当前插件的 shared user plugin enabled
  - 两个 `aw` native / hybrid 插件同时存在时，卸载其中一个不会删掉 `[marketplaces.aw]`
  - 只有最后一个仍引用 `aw` marketplace 的 native plugin 被移除后，才会删 `[marketplaces.aw]`
  - 任一剩余插件的 `sharedNativeRefs.user` 或 `projects` 缺失、非法或无法规范化时，不会授权删除 `[marketplaces.aw]`
  - 最后一个 shared native 引用移除后，账本写成 `sharedNativeRefs = { user: false, projects: [] }`
  - current catalog miss 且仍有 `当前 scope 受管证据` 或 `platformNativeFallbackEvidence` 时，可派生 `catalogCompatibility = missing`
  - Codex native-only 插件在 `scope=user`、ledger 缺失、current catalog miss 后，`status` / `uninstall` 仍能靠 `platformNativeFallbackEvidence` 进入受控路径
  - 只剩 `platformNativeFallbackEvidence`、但没有安装时快照时，显式 `upgrade <plugin>` 会拒绝进入历史 reconcile，并提示先 `uninstall` 再 `install`
  - 同名插件能力变化时，可派生 `catalogCompatibility = capabilityChanged`
  - current catalog 命中但当前 scope 既无受管证据、也无 `platformNativeFallbackEvidence` 时，`status` 不返回 `catalogCompatibility`，`uninstall` 明确 no-op
  - 同名插件已由非 `aw` marketplace 管理时，单独标记为 `externalOwnership`，不进入任何接管或 fallback 路径
  - instruction-only 插件仅存在 `developer_instructions` 受管区块时的检测
  - 多次 install / upgrade / uninstall 后，`developer_instructions` 里的受管区块顺序、空行和剩余用户文本保持稳定
  - user / project 混装时的 `shadowedByProjectDeveloperInstructions`
  - native-only 插件 `--scope project` 直接报错
- `native-cli`
  - 参数构造
  - 超时
  - 错误传播

### 集成测试

- smoke harness 隔离
  - `packages/cli/tests/smoke/**` 不属于 `pnpm test`、`pnpm test:integration`
  - `pnpm test:smoke:build` / `pnpm test:smoke:pack` 才会执行 build / pack smoke
  - 仓库根 `package.json` 暴露 `test:smoke*` 与 `pack:cli` 代理入口，文档与 CI 一律从 repo root 执行
  - `codex-config-smoke.test.ts` 虽命名为 smoke，但属于 build-free round-trip gate，继续由常规测试集合覆盖
- `pnpm build`
  - 从干净工作区执行一次 build
  - 断言 `packages/cli/plugins-dist` 已生成
  - 断言 build 过程中真实执行 `dist/scripts/bundle-plugins.js`，而不是由常规测试直接代替这个边界
  - 首个实现批次里就要能跑通最小 `bundle-plugins` / catalog smoke，不能等到命令链路全部接完再验证
- 源码仓库测试入口
  - 在没有预生成 `packages/cli/plugins-dist` 的 clean checkout 上，`pnpm test:unit` / `pnpm test:integration` 仍能稳定执行
  - 需要 embedded root 的用例会自举 synthetic root，不依赖 repo 根 marketplace / 源码树 generated manifest
  - 源码仓库直接运行未 build 的 CLI 时，会返回明确错误并提示先 `pnpm build`
- `aw init`
  - 初次初始化
  - `--force` 重建
  - 同版本损坏目录自动修复
  - 同版本重 build 且 embedded bundle 内容变化时，会因 `bundleFingerprint` 不匹配而自动刷新
  - 只要 schema 合法就保留 `installed.json`
  - `sourceVersion` 或 `bundleFingerprint` 变化时刷新本地 marketplace bundle，但不丢弃合法账本
  - `installed.json` 缺失或非法时进入 `degraded ledger`
  - marketplace manifest 存在，但 `source` 指向目录缺失时会自动修复
  - platform manifest 仍在，但其引用的 `claude/` 或 `codex/` 子路径缺失时会自动修复
  - root `owner` / `interface` 或 entry `category` / `tags` / `strict` / `policy` 与当前 embedded bundle 不一致时，也会触发本地 marketplace 修复
  - 临时 home 下 `aw init --force` 后，`validateLocalMarketplaceLayout()` 能直接通过，证明 Phase 2 不依赖未实现的临时 contract
- 跨版本生命周期
- current catalog 已移除的插件，只要 ledger / tracking manifest 仍有受管证据，`status` / `uninstall` 仍可走受控路径
- current catalog 已移除、但 ledger / tracking manifest 已缺失时，只要 Claude `platformRuntimeEvidence` 或 `platformNativeFallbackEvidence` 仍在，`status` / `uninstall` 也不能退化成 `Unknown plugin`
  - 旧版 hybrid Codex 插件升级到“同名 instruction-only”后，显式 `upgrade <plugin>` 会清理旧 native state，并重写快照
  - 旧版带 repo-managed artifacts 的 Codex 插件升级到“同名 native-only”后，`uninstall --scope project` 仍能清掉旧 artifacts
  - `upgrade --all` 遇到 `catalogCompatibility = missing | capabilityChanged` 的受管插件时直接拒绝，并列出待显式处理插件
  - current catalog 仍命中，但当前 scope 没有 ledger / tracking manifest / `sharedNativeRefs` 证据，且也没有 `platformNativeFallbackEvidence` 时，`status` 不输出 `catalogCompatibility`
  - 同一场景下，`uninstall` 返回“当前 scope 未受管，无需清理”
- Claude
- marketplace 声明与物化状态分离，且声明层会单独诊断 declared source drift
- 当前 scope 已声明 `aw`，但 `known_marketplaces.json` 缺记录时，install 仍会先补做 `marketplace add`
- 当前 scope 已声明 `aw`，但 declared source 漂移到旧目录时，install 仍会重新执行 `marketplace add`
- 当前 scope 已声明 `aw`，但 `installLocation` 漂移或 materialized manifest 损坏时，install 会重新执行 `marketplace add`
- `status` 会把 declared source drift 与 materialized drift 分开显示
- `project` 安装时，`marketplace add` 与 `plugin install` 都显式带 `--scope project`
- 对本方案固定的本地目录 marketplace，状态解析按 `known_marketplaces.installLocation + entry.source` 定位当前 bundle，不把 `installed_plugins.json.installPath` 当成当前本地载荷来源
- build 输出的 `.claude-plugin/plugin.json` 只引用 `./claude/**` 下的生成产物，不混用 Claude root 默认 loader 路径
- `project` 安装不被其他项目记录污染
- `user` 安装在 ledger / tracking manifest 缺失、current catalog miss 后，只要 `settings.json` + `installed_plugins.json.scope = user` 记录仍在，`status` / `uninstall` 仍能进入保守恢复路径
- `user` 安装在 ledger / tracking manifest 缺失、current catalog miss、`installed_plugins.json` 缺失或损坏后，只要 `settings.json + known_marketplaces + activeLocalBundle` 仍证明 loader 会读取该插件，`status` 不会退化成 `Unknown plugin`
- 同一场景下，`uninstall` 返回受控 drift / refusal，而不是 `Unknown plugin`
- `project` 安装的 `platformNativeFallbackEvidence` 只接受 `scope=project` 且 `projectPath === getOriginalCwd()` 的记录，不能被别的项目记录命中
  - 用 symlink 路径安装后，再用真实路径执行 `status` / `uninstall --scope project`，会命中同一条 project 记录
  - 同一插件同时存在 `user` / `project` 安装时，两个 scope 的 `scopeInitialized` 能独立判断
  - 同一插件同时存在 `user` / `project` 安装时，两个 scope 的 `platformRuntimeEvidence` / `platformNativeFallbackEvidence` 也按各自 scope 语义独立判断
  - Claude scope ledger 会持久化 `resolvedVersion` 与 `capabilitySnapshot.managedExtensions`
  - `managedExtensions` 变化时，Claude 可派生 `catalogCompatibility = capabilityChanged`
  - 只有 runtime manifest / `./claude/**` bundle 变化、但 `managedExtensions` 不变时，Claude 保持 `catalogCompatibility = current`
  - 同一插件同时存在 `user` / `project` 安装时，只卸载目标 scope
  - `uninstall --scope project` 后会重新回读 project `settings.json`，且 user 侧状态不受影响
  - 同名插件已由非 `aw` marketplace 管理时，`install` / `upgrade` / `uninstall` 全部拒绝接管，`status` 明确显示 `externalOwnership`
  - `extensions.instructions` 安装后会生成 `.claude/rules/*.md`，卸载后按 tracking manifest 精确清理
  - 手写 permissions 保留
  - `extensions.permissions` 继续通过 `settings.json` 的 aw 受管区段增删
  - `outputStyles` 通过 bundle manifest 原生透传，不生成额外 tracking artifact
  - 共享 `skills`、共享 `mcpServers`（path-only）以及 `extensions.hooks` / `extensions.agents` 都通过 bundle manifest 原生透传，安装链路不改写结构
  - `userConfig`、`channels` 纯 inline 配置不会被误当成路径
- Codex
  - 默认 `skills/`、`.mcp.json`、`.app.json` 但 manifest 未声明的源码插件，在 build / manifest 校验阶段直接失败
  - `project` 安装在 `requiresNativePlugin = true` 时同时写 user native state + repo-managed artifacts
  - hybrid 插件先 `scope=project` 安装后，`status --scope user` 不会被误报成 initialized
  - repo A 留下的 `sharedNativeRefs.projects` 不会让 repo B 的 `status / uninstall / upgrade <plugin>` 误进历史受管路径
  - 两个 repo 都做过 `scope=project` 安装后，执行 `uninstall --scope user` 仍会保留当前插件的 shared user plugin enabled，且不会误删 `[marketplaces.aw]`
  - 最后一个 shared native 引用移除后，账本终态固定写成 `sharedNativeRefs = { user: false, projects: [] }`
  - `sharedNativeRefs.user` 或 `projects` 缺失时，不会误删当前插件的 shared user plugin enabled / marketplace
  - `upgrade --all --scope user` 不会因为 shared native ref 隐式生成 user artifacts
  - native-only 插件在 `scope=user` 且只剩 `[plugins."<plugin>@aw"].enabled = true` 时，`status` / `uninstall` 仍能进入保守恢复路径
  - 只剩 user native fallback、但无法证明没有 project 共享引用时，`uninstall --scope user` 返回明确 refusal，而不是盲删 native state
  - 同名插件已由非 `aw` marketplace 管理时，`install` / `upgrade` / `uninstall` 全部拒绝接管，`status` 明确显示 `externalOwnership`
  - instruction-only 插件 `scope=user` 时只改 `~/.codex/config.toml` 的 `developer_instructions` 字段，不写 marketplace / plugin enabled
  - instruction-only 插件 `scope=project` 时只改 `.codex/config.toml` 的 `developer_instructions` 字段，不写共享 user native state
  - 需要 native plugin 的 Codex 插件安装后，`~/.codex/config.toml` 中 `[marketplaces.aw]` 使用 `source_type = "local"` 和 `source = "<~/.aw canonical directory path>"`，不是 manifest 文件路径
  - native-only 插件 `scope=project` 直接失败，要求改用 `--scope user`
  - instruction-only 插件 user + project 混装时，project `developer_instructions` 会遮蔽 user scope
  - project scope 卸载后，user scope instructions 在当前 repo 重新可见
  - `codex-config.ts` 在命令链路接入前先通过独立 build-free smoke，证明 round-trip 不会打乱注释、字段顺序和无关 section
  - current repo project trust = `trusted` 时，project instructions 进入会话
  - current repo project trust = `untrusted` 时，project instructions 记为 `blockedByProjectTrust`
  - current repo project trust = `unknown` 时，project instructions 记为 `projectTrustUnknown`
  - current repo project trust = `trusted` 时，project rules / hooks / agents 分别记为 `visible`
  - current repo project trust = `untrusted` 时，project rules / hooks / agents 分别记为 `blockedByProjectTrust`
  - current repo project trust = `unknown` 时，project rules / hooks / agents 分别记为 `projectTrustUnknown`
  - 没有 `.codex/config.toml`、只有 `.codex/rules/`、`.codex/hooks.json` 或 `.codex/agents/*.toml` 时，trust 仍然决定 `repoManagedSessionState`
  - `cwd/config.toml`、tree `.codex/config.toml` 在 untrusted 时不会把 user instructions 误记成 `unknownByExternalLayer`
  - user `.codex/rules/*.rules` 与 trusted project `.codex/rules/*.rules` 同时存在时，`repoManagedSessionState.rules` 仍为 `visible`，但会额外报告 external overlay
  - user `.codex/hooks.json` 与 trusted project hooks 同时存在时，`repoManagedSessionState.hooks` 仍为 `visible`，但会额外报告 external overlay
  - enabled 更高优先级 layer 只有在命中同名 agent role 时，user `repoManagedSessionState.agents` 才记为 `unknownByExternalLayer`
  - `.codex/agents/*.toml` 的生成与清理
  - `.codex/agents/*.toml` 能被与上游一致的 role file 校验通过，而不是只检查文件存在
  - 跨 repo project scope 隔离，以及同一仓库不同子目录的 Claude project scope 隔离
  - 同一物理目录通过 symlink / alias / real path 进入时，Claude `scopeInitialized`、project ledger 与 `installed_plugins.json.projectPath` 相关性判断都对齐上游 `getOriginalCwd()` 语义，命中同一条 project 记录
  - 用 symlink 路径安装后，再用真实路径执行 Claude `status` / `uninstall --scope project`，应命中同一条 project 记录；同一仓库不同子目录仍保持隔离
- 通用
  - 消费仓库没有本地 `plugins/` 目录时，四个核心命令仍可用
  - `pnpm test` 在干净 checkout 上不依赖预生成的 `packages/cli/plugins-dist`
  - `pnpm test:integration` 在干净 checkout 上同样不依赖预生成的 `packages/cli/plugins-dist`
  - 需要 runtime bundle 的测试会自举 synthetic embedded root，且不会偷偷回退到 repo 根 marketplace / 源码树 generated manifest
  - `status` 在 `~/.aw/config.json` 的 freshness metadata 落后于当前 embedded bundle 时优先使用 `embedded plugins root`
  - `upgrade --all` 不隐式初始化未安装插件
  - `upgrade --all` 在 `ledgerState = degraded` 时拒绝执行
  - 上面枚举的切换前基线状态不会参与当前版本的 `upgrade --all` 或 shared native cleanup 推断
  - `status --platform auto` 在同时检测到 Claude / Codex 时会并列展示两边状态，而不是退化成单平台输出
  - 会修改状态的 `--platform auto` 在“唯一已初始化平台”场景下能稳定推断到目标平台
  - 会修改状态的 `--platform auto` 在 `scopeInitialized = unknown` 时拒绝自动推断
  - 双平台同时可用但无法唯一推断时，会修改状态的 `--platform auto` 会明确报错并要求显式传 `--platform`
  - 只有单平台可用时，`--platform both` 会明确拒绝
  - `status` 只读
  - `status` 在 `ledgerState = degraded` 时展示 `scopeInitialized = unknown`
  - 注入“Claude native install 成功、tracking / ledger 提交失败”后，账本会降级，后续 `status` / `upgrade --all` 不会把缺失记录当成 `no`
  - 注入“Codex native write 成功、project artifacts / ledger 提交失败”后，账本会降级，后续 `status` / `upgrade --all` / `--platform auto` 不会误判
  - 注入“Codex instruction-only artifacts 已写成功、tracking / ledger 提交失败”后，账本会降级为 `operation_interrupted_after_artifact_write`，后续 `status` / `upgrade --all` / `--platform auto` 不会误判
  - 注入“Codex project artifacts 卸载删了一半、tracking / ledger 提交失败”后，账本会降级为 `operation_interrupted_after_artifact_write`，后续 `status` 不能把它解释成 `no`
  - 命令阶段不回写 repo `plugins/` 或包内 `embedded plugins root`
  - fake CLI 调用链可验证，不依赖本机真实二进制
- 作者工具
  - 在临时仓库执行 `node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js ...`
  - 只生成源码结构和带 `marketplace` block 骨架的 `plugins/<name>/.agents-plugin/plugin.json`
  - 不生成源码树 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`
  - 不生成 runtime marketplace，也不偷偷改写 `plugins/marketplace-source.json`
  - `SKILL.md` 与 `references/*.md` 不再把 repo 根 marketplace 或源码树平台 manifest 当成运行时真值，并明确区分 `plugins/marketplace-source.json` 这种源码输入
- 文档同步
  - `docs/dev/plans/project-init.md` 与 `docs/codex-claude-plugin-marketplace-research.md` 文首带有明确的“历史文档”标记，并链接到当前执行计划
  - `docs/dev/plans/npm-plugin-marketplace.md` 与 `docs/dev/plans/npm-plugin-marketplace-copy.md` 要么已删除，要么文首带有明确的“历史文档”标记，并链接到当前执行计划
  - `docs/dev/plans/codex-repo-managed-artifacts.md` 如果继续作为活动文档，正文已同步到新模型；如果不再继续维护，文首显式标记为历史文档并列出失效范围
  - 同主题旧计划不再以活动计划身份与本文并列
  - 仓库内所有未标记为历史的活动文档，不再把 repo 根 marketplace、源码树平台 manifest 或命令阶段生成 runtime manifest 写成当前默认路径

### 发包验证

- 在 repo root 执行 `pnpm pack:cli`
- 解包后至少断言这些路径存在
  - `package/dist/index.js`
  - `package/plugins-dist/.claude-plugin/marketplace.json`
  - `package/plugins-dist/.agents/plugins/marketplace.json`
  - `package/plugins-dist/plugins/<sample-plugin>/.agents-plugin/plugin.json`
  - `package/plugins-dist/plugins/<sample-plugin>/.claude-plugin/plugin.json`
  - `package/plugins-dist/plugins/<sample-plugin>/.codex-plugin/plugin.json`
- 从解包目录验证 `resolveEmbeddedPluginsRoot()` 能定位到 tarball 内的 `plugins-dist`
- 从解包目录校验两份 marketplace manifest 的 root `owner` / `interface` 与样例插件 entry `category` / `tags` / `strict` / `policy` 都被完整保留
- 从解包目录直接解析一个样例插件的 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`，继续校验它们声明的 bundle-local 路径都能在 tarball 内真实解析，且不会直接指向 `./shared/**`
- 从解包目录执行一次依赖 embedded bundle 的最小 smoke，优先覆盖 `aw init --force` 或最小 catalog 读取路径，确认 CLI 不再依赖源码仓库相对路径

### 验收标准

- `plugins-dist/plugins/*` 是唯一的 npm 包内运行时插件真值
- 仓库根 `package.json` 提供与正文一致的 `test:smoke` / `test:smoke:build` / `test:smoke:pack` / `pack:cli` 入口，文档与 CI 都能从 repo root 直接执行
- `pnpm build` 在干净工作区可直接产出 `plugins-dist`，不依赖 JS 直接 import TS 源模块
- `pnpm test` 与 `pnpm test:integration` 在干净 checkout 上都不依赖预生成的 `packages/cli/plugins-dist`；需要 runtime bundle 的测试会自举 synthetic embedded root，且不会回退到 repo 根 marketplace / 源码树 generated manifest
- 运行时读取 bundle 只能经过 `resolveEmbeddedPluginsRoot()`，不能硬编码 `packages/cli/plugins-dist`
- `aw init` 只复制和校验，不做二次生成；校验必须覆盖 marketplace `source`、platform manifest 的存在性，以及 platform manifest 声明路径能否真实解析到 bundle 内容
- 两份 marketplace manifest 保持镜像一致；root metadata 来自 `plugins/marketplace-source.json` 的正式 schema，entry metadata 来自源码 manifest 顶层与 `marketplace` block 的正式 schema，`source` 统一为相对 marketplace root 的 `./plugins/<plugin>`，不回读旧 runtime marketplace，也不静默补默认值
- 差异化生成能力仍保留，但只发生在 build 阶段
- `installed.json` 作为管理账本存在，不参与 Claude / Codex 平台真值判定；只要 schema 合法就保留账本，`sourceVersion` 或 `bundleFingerprint` 变化只触发本地 bundle 刷新，账本缺失 / 损坏时写出 `degraded ledger`
- 新方案上线后的正常包版本升级里，current catalog 移除旧插件或同名插件能力变化，都有正式的 `status` / `uninstall` / 显式 `upgrade` 受控路径
- Claude 的状态判断按三层工作，不再把某一层误当全貌
- 对本方案固定的 Claude 本地目录 marketplace，默认 startup 的 cache-only loader 会按 `known_marketplaces.installLocation + entry.source` 读取当前物化 bundle；`installed_plugins.json.installPath` 只用于安装元数据、project 相关性和诊断
- Claude `status` 会显式区分 `currentCatalog` 与 `activeLocalBundle`；`~/.aw` 过期或损坏时，embedded fallback 只代表当前目标 catalog，不代表下一次标准启动会读取它
- Claude 的 `scopeInitialized` 来源于 `installed.json` 的显式 scope ledger；同一插件可同时存在 `user` / `project` 两条受管记录
- Claude scope ledger 也会保存 `resolvedVersion` 与 `capabilitySnapshot.managedExtensions`；Claude 的 `catalogCompatibility` 只比较需要 scope reconcile 的历史副作用，不把 runtime manifest / `./claude/**` bundle 变化单独记成 `capabilityChanged`
- Claude project ledger key 对齐上游当前 project 身份：`settings.json` root 侧对齐 `resolve(getOriginalCwd())`，`installed_plugins.json.projectPath` 侧对齐 `getOriginalCwd()`，两者都指向上游启动阶段 canonicalize 后的同一 real path；CLI 不再额外造第二套路径语义；同一仓库不同子目录的 `--scope project` 安装不会互相覆盖
- Claude 的 `platformRuntimeEvidence` 按 scope-sensitive 规则判定：当前 scope `settings.json` 仍启用 `<plugin>@aw`，`known_marketplaces.installLocation` 可解析，且 `activeLocalBundle` 可定位到当前插件；它只用于 `status`
- Claude 的 `platformNativeFallbackEvidence` 按 scope-sensitive 规则判定：`scope=user` 只认 `installed_plugins.json.scope = user`；`scope=project` 只认 `scope=project` 且 `projectPath === getOriginalCwd()`；它只用于 `status` 补充说明和受控 native uninstall / refusal
- Claude install 不只看 scope `settings.json` 是否声明 marketplace；声明层 source 漂移、`known_marketplaces.json` 缺记录、`installLocation` 漂移或 materialized manifest 损坏时都会重新执行 `marketplace add`
- Claude 的原生 uninstall 始终显式带 `--scope <scope>`，并在清理 / 回显前统一回读目标 scope `settings.json`、`known_marketplaces.json`、`installed_plugins.json`
- Claude 的 marketplace 声明 scope 跟随本次目标安装 scope，不再保留“示例写 user、规则写当前 scope”两套口径
- Claude 的 generated manifest 路径项统一落到 `./claude/**`，不再混用默认 `skills/`、`commands/`、`agents/`、`hooks/hooks.json`、`output-styles/`、`.lsp.json`、`.mcp.json` 入口；`userConfig` / `channels` 仍保持 inline 结构
- `shared/` 如果存在，只作为 bundle 内部实现目录；运行时平台 manifest 不会直接引用 `./shared/**`
- Claude 的共享 `skills` 必须显式写回 `.claude-plugin/plugin.json.skills = "./claude/skills"` 或等价 namespaced 路径，不能只依赖根目录 `skills/` 自动发现
- Claude 的 `extensions.instructions` 继续生成 `.claude/rules/*.md`，`extensions.permissions` 继续写受管 `settings.json`
- Claude 的共享 `mcpServers` 固定为顶层 path-only 字段；首版不支持 Claude-only inline / mixed MCP 输入
- Claude 的共享 `skills` / `mcpServers` 与 `extensions.hooks`、`extensions.agents`、`commands`、`outputStyles`、`lspServers`、`userConfig`、`channels` 都作为原生 manifest 字段处理，不额外生成 repo-managed artifacts
- Codex native 能力只认 manifest 显式声明；默认 `skills/`、`.mcp.json`、`.app.json` 未声明时直接视为非法输入
- Codex `scopeInitialized` 来源于 `installed.json` 的显式 scope ledger，不能从 `nativeInstalled` 或 shared native ref 反推
- Codex `project` scope 的 `scopeInitialized` 只由当前 repo 的 project 记录决定
- Codex 会显式区分 `current catalog capabilities` 与 `installed capability snapshot`；`current` / `capabilityChanged` 只在存在 `当前 scope 受管证据` 时暴露，`missing` 可额外由 `platformNativeFallbackEvidence` 派生
- Codex marketplace 写回对齐上游 local-source 结构：`[marketplaces.aw]` 必须写 `source_type = "local"` 与 `source = "<~/.aw canonical directory path>"`，不能把 `.agents/plugins/marketplace.json` 文件路径当 source
- `scopeInitialized` 的对外语义固定为 `yes | no | unknown`；`ledgerState = degraded` 时缺失记录必须显示 `unknown`
- Codex `sharedNativeRefs` 一旦存在，就固定使用 `{ user: boolean, projects: string[] }`；`user = false` 才表示“无 user 引用”，字段缺失不代表 `false`
- Codex 当前插件自己的 shared user plugin enabled 只有在账本明确显示 `sharedNativeRefs = { user: false, projects: [] }` 时才允许删除
- `[marketplaces.aw]` 只有在全账本扫描确认没有任何其它 native plugin 仍在引用，且不存在不明确 `sharedNativeRefs` 条目时才允许删除
- Claude / Codex 只要发现同名插件已由非 `aw` marketplace 管理，就统一标记为 `externalOwnership`；`install` / `upgrade` / `uninstall` 都不会接管
- Codex native-only 插件不支持 `--scope project`
- Codex instructions 写入 scope 对应 `config.toml` 的 `developer_instructions` 字段
- Codex `developer_instructions` 的受管区块使用成对 sentinel `[[aw-managed:start ...]]` / `[[aw-managed:end ...]]`；插件正文命中 sentinel 前缀时直接拒绝，用户手写普通标题不会被误删
- Codex 当前 repo `.codex/config.toml` 一旦定义 `developer_instructions`，会整体覆盖 user `~/.codex/config.toml` 的同字段；CLI 会单独报告 `instructionsSessionState`
- Codex project trust 纳入 `developer_instructions`、`rules`、`hooks`、`agents` 的可见性判断，`untrusted` / `unknown` 不能再报成可见
- `.codex/config.toml` 不存在但 `.codex/hooks.json`、`.codex/rules/` 或 `.codex/agents/` 存在时，Codex project trust 仍然生效，`status` 不能只因文件存在就报告可见
- Codex `repoManagedSessionState.rules` / `hooks` 反映的是当前 scope 受管产物是否进入 enabled layer 视图；更高优先级 enabled layer 只追加 overlay 诊断，不把已加载的 user rules / hooks 误报成 `unknown`
- Codex `unknownByExternalLayer` 只会在 enabled 的更高优先级外部 layer 命中 `developer_instructions`，或命中同名 agent role 时出现；被 trust 禁用的 layer 不会误伤 user scope
- instruction-only Codex 插件不会平白改写共享 user native marketplace / plugin enabled state
- Codex 不再依赖 `config.toml.instructions` 或 `.codex/AGENTS.md`
- Codex repo-managed artifacts 的落点固定为对应 scope 的 `config.toml`、`rules/*.rules`、`hooks.json` 和 `agents/*.toml`
- Codex role file 生成结果满足上游契约：`prompt -> developer_instructions`，`name` / `description` / `developer_instructions` 非空，且不写未知字段
- `codex-config.ts` 先通过独立 golden fixture 与 build-free smoke，再接入命令链路；写回过程保持无关 section、注释、字段顺序和多行 `developer_instructions` 的 round-trip 保真
- 首个实现批次已经把 build-time contract、`local-plugin.ts`、`bundle-plugins.ts` 和 `plugins-dist` 一起落地，不再让 Phase 2 依赖一版临时 bundle 结构
- `status` 在 `~/.aw` 的 freshness metadata 落后或目录损坏时会只读回退到 `embedded plugins root`
- `status` 能清楚区分 native state、generated artifacts、`scopeInitialized`、`catalogCompatibility`（如适用）、`instructionsSessionState` 和 `repoManagedSessionState`
- current catalog miss 或 capability changed 的受管插件会在 `status` 中清楚显示，`upgrade --all` 不会把它们误解释成“未初始化”
- `upgrade --all` 在账本 `degraded` 时不会把“未知”误当“未初始化”；会修改状态的 `--platform auto` 在 `scopeInitialized = unknown` 时拒绝自动推断
- install / uninstall / upgrade 只要出现“任何受管状态已改写，但 tracking manifest / `installed.json` 未提交成功”，就必须把账本降级，不能留下 `available` + 缺口记录
- instruction-only / artifact-only 路径出现半成功时，账本必须降级为 `operation_interrupted_after_artifact_write`，后续 `status` 不能把缺失账本记录解释成 `no`
- 作者工具和参考文档不会再生成或指导使用 repo 根 marketplace、源码树 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`
- npm 包的 tarball 内容经过 repo root `pnpm pack:cli` 验证，至少锁住样例插件的 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 及其路径闭环，并且能在解包目录下真实跑通依赖 embedded bundle 的最小命令路径
- 当前版本不为上面枚举的切换前基线状态提供兼容迁移；这不等同于新方案上线后的正常包版本升级策略
