# 插件安装指南

## 前置条件

- Node.js `>= 20`
- 全局安装 `@yiliang/aw`
- Claude 写入需要 Claude Code `>= 2.1.88`
- Codex 写入需要 Codex `>= 0.145.0`

```bash
npm install -g @yiliang/aw
aw init
aw install git-commit -p both
aw status
```

`aw init` 只预热 catalog 和 strict artifact cache。`install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 是五个写命令，它们都通过同一条 rebuild pipeline 执行。

## Target

绑定插件 target 的写命令必须明确平台：

```bash
aw install git-commit -p codex -s user
aw install git-commit -p codex -s project
aw install git-commit -p both -s user
```

- `-p, --platform`：`codex`、`claude` 或 `both`
- `-s, --scope`：`user` 或 `project`，默认 `user`
- `install`、`upgrade` 和 `reinstall` 使用 `both` 时，只展开插件实际支持的平台；`uninstall` 和 `cleanup` 仍检查两个选中平台，以便删除历史残留
- Codex project scope 只写当前仓库，不注册用户级 Codex plugin

插件 manifest 不支持顶层 `dependencies`。CLI 不自动安装其它插件，也不提供插件依赖保护。

## Catalog 和 Cache

`aw init` 先获取 `@yiliang/aw-plugins-manifest` sidecar，再获取同版本 `@yiliang/aw-plugins` full catalog，并校验 package identity、manifest digest 和 artifact digest。

catalog manifest 使用 `schemaVersion: 2`，只描述 selector 当前指向的 catalog。schema 1 和带 `history` 字段的 manifest 都不受支持。

```bash
aw init
aw init --force
aw init --catalog-channel beta
aw init --catalog-version 1.2.0-beta.1
```

- 普通 `init`、`install` 和 `upgrade` 要求一次远程检查；远程失败时，可以使用 selector 和 identity 都严格匹配的合法 cache。
- `status` 和主控制台 warm load 使用 `cacheFirst`，不会为了显示状态自动刷新远程内容。
- `init --force` 跳过 cache 快路径。远程刷新失败时，公开命令返回失败。
- cache 按 selector 和 registry source identity 隔离，并使用 immutable entry、原子 selector publication 和有界 lock。
- active marketplace 重建会保留 strict catalog cache、AW config store、Codex user Skill overlay 和 lifecycle active snapshot。

如果 channel selector 当前 catalog 的最低 CLI 版本高于当前 `aw`，CLI 直接返回 `awVersionTooLow`。显式 catalog version 不兼容时返回 `explicitCatalogIncompatible`。这两类结果都不下载 full catalog，也不使用 cache fallback。

### 环境变量

| 环境变量 | 默认值 | 合法值 | 说明 |
|----------|--------|--------|------|
| `AW_CATALOG_CACHE_TTL_MS` | `300000` | 整数 `0..86400000` | settled cache TTL |
| `AW_CATALOG_REMOTE_TIMEOUT_MS` | `5000` | `0` 或整数 `100..60000` | catalog 远程 deadline |
| `AW_NATIVE_CLI_TIMEOUT_MS` | `60000` | `0` 或整数 `1000..600000` | Codex/Claude 原生命令 timeout |

## 五个写命令

### Install

```bash
aw install <plugin...> -p codex|claude|both [-s user|project] [--script-timeout <ms>] [--json]
```

`install` 按 current catalog 生成期望组件，检查 live ownership，再写平台原生和 repo-managed 组件。成功后保存 lifecycle active snapshot。

### Upgrade

```bash
aw upgrade <plugin...> -p codex|claude|both [-s user|project] [--json]
aw upgrade --all -p codex|claude|both [-s user|project] [--json]
```

`upgrade` 按 current catalog 重建目标。`--all` 只从 live owner marker 发现当前 target。

### Reinstall

```bash
aw reinstall <plugin> -p codex|claude|both [-s user|project] [--json]
```

`reinstall` 先删除能证明属于 AW 的目标组件，再按 current catalog 完整重建。它保留 AW config。配置会参与重建后的 artifact 渲染和 lifecycle context。

### Uninstall

```bash
aw uninstall <plugin...> -p codex|claude|both [-s user|project] [--json]
```

`uninstall` 删除 AW-owned 组件。最后一次成功写入留下 lifecycle active snapshot 时，命令使用它运行 uninstall lifecycle。snapshot 缺失不改变 live ownership 判断。

### Cleanup

```bash
aw cleanup <plugin> -p codex|claude|both -s user|project [--json]
```

`cleanup` 只删除能通过 owner marker 或平台 ownership 检查证明属于 AW 的现场组件。它不运行 uninstall lifecycle，也不删除 AW config。无法证明归属的组件不会被删除。

## Live Status

```bash
aw status
aw status git-commit -p codex -s project
aw status git-commit -p codex -s project --verbose
aw status git-commit -p codex -s project --json
```

`status` 读取 current catalog、live owner marker 和平台原生组件。它不运行 lifecycle 或 renderer，不刷新 marketplace，也不创建配置目录。

target 状态只允许：

| 状态 | 含义 | 建议 |
|------|------|------|
| `present` | 所有期望 AW-owned 组件都存在 | 无 |
| `absent` | 没有发现目标的 AW-owned 组件 | `aw install` |
| `partial` | 只存在部分组件，或组件不完整 | `aw reinstall` |
| `error` | catalog、发现或组件检查失败 | 查看 target errors |

status v3 JSON 示例：

```json
{
  "schemaVersion": 3,
  "catalog": {
    "source": "cache",
    "catalogVersion": "1.2.0"
  },
  "filters": {
    "plugins": ["git-commit"],
    "platform": "codex",
    "scope": "project",
    "cwd": "/workspace"
  },
  "targets": [
    {
      "target": {
        "plugin": "git-commit",
        "platform": "codex",
        "scope": "project",
        "cwd": "/workspace"
      },
      "state": "present",
      "components": [],
      "errors": []
    }
  ],
  "errors": []
}
```

主控制台使用同一份 live status，不维护另一套状态投影。

## Config

```bash
aw config list codex-explore -s user --json
aw config get codex-explore standardModel -s user --json
aw config set codex-explore standardModel gpt-5.6-terra -s user --json
aw config unset codex-explore standardModel -s user --json
aw config reset codex-explore -s user --yes --json
```

配置合并顺序：manifest default、user store、project shared store、project local store。

- config read 使用 `configSchemaVersion: 3`。
- config write 使用 `receiptSchemaVersion: 3`。
- config 写入会对当前可定位 target 运行完整 reinstall。
- `uninstall`、`cleanup` 和 `reinstall` 都保留 config。
- `config reset` 是删除 config store 的唯一入口。
- project shared 配置可提交；`--local` 写 project local 配置。
- project repo-visible artifact 不能使用 user、project local 或路径型私有配置。

## Lifecycle Active Snapshot

带 lifecycle 的插件在成功 install 或 upgrade 后保存最小 active snapshot。它只包含下一次 uninstall 所需的脚本输入和 bundle 内容。

- snapshot 不表示插件已安装。
- status 不读取 snapshot 来决定 target 状态。
- uninstall 可以使用 snapshot 运行 uninstall lifecycle。
- reinstall 的 cleanup 不运行旧 snapshot；重建后使用 current bundle 运行 install lifecycle。
- cleanup 不运行 uninstall lifecycle。
- snapshot 缺失时，live owner marker 仍是清理边界。

## 平台输出

Codex project scope 可以写：

- `.agents/skills/<skill>/`
- `.codex/config.toml`
- `.codex/hooks.json`
- `.codex/rules/`
- `.codex/agents/`

Codex user scope 可以使用 `codex plugin marketplace add/list/remove` 和 `codex plugin add/remove`。Claude user/project scope 使用 Claude 的 settings、skills、hooks 和 plugin 目录。

Skill 的调用行为来自平台原生元数据：Codex 使用 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`；Claude 使用 `SKILL.md` 的 `disable-model-invocation` 和 `user-invocable`。AW 校验并保留这些值。

MCP、apps、hooks、permissions、roles、instructions、skills 和 slash commands 都继续由平台能力层处理。

## JSON 和退出码

| 输出 | 版本 |
|------|------|
| 五个写命令 receipt | `receiptSchemaVersion: 3` |
| status | `schemaVersion: 3` |
| config list/get | `configSchemaVersion: 3` |
| config set/unset/reset | `receiptSchemaVersion: 3` |

- `--json` 成功时 stdout 只包含一个可解析 JSON 对象。
- verbose/debug 信息和错误说明写 stderr。
- 写命令 target 失败时，receipt 保留失败结果，命令返回非零退出码。
- status 含 `error` target 时返回非零退出码；其它 target 仍保留在 JSON 中。

## 常见处理

状态为 `absent`：

```bash
aw install git-commit -p codex -s project
```

状态为 `partial`：

```bash
aw reinstall git-commit -p codex -s project
```

只删除已证明属于 AW 的现场组件：

```bash
aw cleanup git-commit -p codex -s project
```

只删除配置：

```bash
aw config reset git-commit -s project --yes
```

原生命令超时后，先运行 `aw status --verbose`。如果组件是 `partial`，运行 `reinstall`；如果只需要删除 AW-owned 输出，运行 `cleanup`。
