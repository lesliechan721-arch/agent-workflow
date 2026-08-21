# AW 验证和版本

## 工作区验证

从目标工作区的 manifest/schema、package scripts、CI 配置或维护规则发现适用的 build、test、materialization 和 Eval 命令。将这些确定性命令逐个传给：

```bash
node scripts/prepare-aw-authoring-context.mjs <plugin-root> \
  --repo-root <workspace-root> \
  --components <json-file> \
  --validator "<command>"
```

`<json-file>` 的根值是非空组件数组。现有 manifest 提供插件名、默认 change mode 和产品范围；每个组件的 `profiles` 必须在该产品范围内。新插件没有 manifest 时，同时传 `--plugin`，需要收窄产品时重复传 `--product`。

`prepare-aw-authoring-context.mjs` 不为未知工作区臆造默认命令。不要假设：

- 插件位于 `plugins/<name>/`；
- `author-aw-plugin` 位于宿主工作区的固定目录；
- 工作区使用 `pnpm`；
- 一定存在 `plugin:test` 或 `plugin:eval`。

插件作者的稳定 CLI 入口只有以下四个：

| 任务 | capability check | 执行 |
| --- | --- | --- |
| 创建插件和初始 Skill 骨架 | `aw --version`；`aw plugin init --help` | `aw plugin init <plugin-name> ... --repo-root <workspace-root> --plugin-root <plugin-root>` |
| 向现有插件增加静态 Skill 骨架 | `aw --version`；`aw plugin add-skill --help` | `aw plugin add-skill <plugin-name> ... --repo-root <workspace-root> --plugin-root <plugin-root>` |
| 验证一个插件根 | `aw --version`；`aw plugin validate --help` | `aw plugin validate <plugin-root>` 加 help 明确支持的 flags |
| 查看 production bundle 开发状态 | `aw --version`；`aw plugin status --help` | 单插件运行 `aw plugin status <plugin-name> --repo-root <workspace-root> --plugin-root <plugin-root> --base <git-ref>`；`--all` 只用于标准 `plugins/` 布局 |

`--plugin-root` 相对 `--repo-root` 解析，必须位于该 Git repository 内，且目录名和 manifest name 都必须匹配 `<plugin-name>`。显式根的 `init` 不读取或修改 `plugins/marketplace-source.json`。

每个分支必须先检查对应 help。所需命令或 flag 不存在时停止并报告 capability 缺口。不得通过 `npx` 获取另一版本，不得猜测 CLI 或仓库路径，不得调用本 Skill 内的 validator/scaffolder 副本。

## Full Access 授权策略

真实模型 Eval 需要目标工作区 runtime 的进程管理门禁。作者 agent 必须遵守以下结构化不变量：

<!-- aw-full-access-consent-policy:v1 -->
| policy invariant | Agent requirement |
|---|---|
| `single_escalation_is_not_full_access` | 单次提权不等于整个会话的 Full Access，agent 不得用单次提权重试该门禁。 |
| `agent_must_not_add_allow_unmanaged_processes` | agent 不得自行添加 `--allow-unmanaged-processes`。 |
| `agent_must_stop_without_user_choice` | 用户未明确选择整个会话使用 Full Access 或明确接受 unmanaged 降级时，agent 必须停止并请求用户选择。 |
<!-- /aw-full-access-consent-policy -->

## Manifest 版本

- 新插件保留目标工作区规定的初始稳定版本。
- 日常开发不因 production bundle 变化直接提高插件版本；`unreleasedChanges` 是通过状态。
- release 请求只声明 target 由 workspace release workflow 设置。目标工作区提供 `release:target` / `release:prepare` 时使用这些入口；未提供时报告能力缺口，不指示作者为每次开发改 manifest version。

## 完成条件

- `aw plugin validate`、适用的 `aw plugin status` 与目标工作区要求的 tests 通过；
- build-required 分支生成的 artifact 存在且来源可追溯；
- Eval case 已通过独立 preflight；
- 不存在的工作区命令不伪装成已运行，未运行的模型证据明确标为未验证。
