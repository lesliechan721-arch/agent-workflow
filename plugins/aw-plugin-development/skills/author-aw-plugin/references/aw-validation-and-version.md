# AW 验证、构建、Catalog 与版本

只在验证、构建、Catalog source、版本、materialization、Eval 或 release 分支读取。AW CLI/Core 是这些合同的唯一机器真值；每次先运行对应 `--help`，不要猜测 flag，也不要使用 `npx`、仓库私有脚本或旧的 repository-root 参数。

## 公共命令表

所有 `<workspace-root>` 都是 Workspace v1 根。`<plugin-root>` 可以是 workspace 内的相对 plugin 目录，例如 `plugins/example-plugin`。

| 任务 | capability check | 执行 |
| --- | --- | --- |
| 创建 workspace | `aw --version`；`aw catalog init --help` | `aw catalog init --workspace-root <workspace-root>` |
| 读取或设置 Catalog 版本 | `aw catalog version --help` | `aw catalog version [<semver>] --workspace-root <workspace-root>` |
| 创建插件和初始 Skill | `aw plugin init --help` | `aw plugin init <plugin-name> ... --workspace-root <workspace-root> [--plugin-root <plugin-root>]` |
| 增加静态 Skill | `aw plugin add-skill --help` | `aw plugin add-skill <plugin-name> ... --workspace-root <workspace-root> [--plugin-root <plugin-root>]` |
| 验证一个 source plugin | `aw plugin validate --help` | `aw plugin validate <plugin-root> --workspace-root <workspace-root> [--json]` |
| 运行声明的确定性 Node tests | `aw plugin test --help` | `aw plugin test <plugin-root> --workspace-root <workspace-root> [--json]` |
| materialize 一个插件 bundle | `aw plugin build --help` | `aw plugin build <plugin-root> --workspace-root <workspace-root> [--out <path>] [--force]` |
| 查看开发状态 | `aw plugin status --help` | `aw plugin status <plugin-name> --workspace-root <workspace-root> [--plugin-root <plugin-root>] [--base <git-ref>]` |
| materialize 完整 development snapshot | `aw catalog build --help` | `aw catalog build --workspace-root <workspace-root> [--out <path>] [--force]` |
| 验证生成 snapshot | `aw catalog validate --help` | `aw catalog validate <workspace-root>/.aw/catalog [--json]` |
| 增加 path source | `aw catalog source add --help` | `aw catalog source add <source-id> --path <snapshot-path> [--primary] [--json]` |
| 增加 Git source | `aw catalog source add --help` | `aw catalog source add <source-id> --git <url> (--ref <ref> \| --default-ref) [--primary] [--json]` |
| 安装精确 selector | `aw install --help` | `aw install <source-id>/<plugin-name> -p codex\|claude\|both [--json]` |
| 发布 Git Catalog（显式授权后） | `aw catalog publish --help` | `aw catalog publish --workspace-root <workspace-root> --remote <name> --branch <name> --yes [--json]` |

`aw plugin status` 不传 `--base` 时不要求 Git。传 `--base` 时才执行 Git comparison。`catalog validate` 接收 snapshot directory，因此没有 `--workspace-root`；使用 workspace 的 `.aw/catalog` 输出即可。

## 构建、测试和 release 边界

先运行 `aw plugin validate` 和 `aw plugin test`。只有需要 materialized bundle 或 Catalog snapshot 时，才运行 `aw plugin build` 或 `aw catalog build`，并验证输出。生成 output、manifest、digest 和 marketplace 都由 CLI 维护；`--force` 只处理可证明为生成 output 的目标。

日常开发不因 production 内容变化直接提高 plugin `version`；`unreleasedChanges` 是有效状态。`catalog.version` 是 Source Workspace 的 release identity，用 `aw catalog version <higher>` 修改。发布 production artifact 内容已变化、且当前稳定 plugin `version` 已进入 release ledger 的插件前，按作者 release policy 提高该插件 `version`；只提高 `catalog.version` 不能解决同一 plugin version 的不同 content。只有用户明确请求且已授权发布时，才调用 `aw catalog publish`。它要求干净且已有提交的 Git worktree、有效 remote/branch；非 TTY 或 `--json` 必须加 `--yes`。失败或结果不确定后，不能重试同一 Catalog 版本：提高 `catalog.version` 后再发布；这不会替代所需的 plugin version bump。

第三方 Catalog release 与 `agent-workflows` 的官方 release train 分离。官方仓库维护者另遵循其仓库规则；不要把官方 release 命令放进普通第三方作者路径。

## Eval 边界

Author 可以创建或修改 Eval 资产，但不自动做 Oracle Audit 或模型运行。用户明确要求运行 Eval 时，由上层工作流单独组合 Auditor、兼容 Runner 和必要授权。Author 的完成条件不依赖模型 Eval。

## 完成条件

- `aw plugin validate`、`aw plugin test`、适用的 `aw plugin status` 与本次修改直接相关的 build 通过；
- build-required 分支生成的 artifact 存在且可由 `aw plugin build` 或 `aw catalog build` 重新生成；
- 不存在的 CLI capability 不伪装成已运行；
- 未执行的独立 Review、Eval Audit、模型 Eval 和 publish 明确标为未验证或未授权。
