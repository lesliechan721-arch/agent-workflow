# AW Config 与标准 Helper

只在插件声明 `config.schema`、配置 store、AW config CLI 或 `scripts.helpers.config` 时读取。字段级 manifest schema 仍以 `plugin-manifest-spec.md` 为准。

## AW Config

`config.schema` 是 AW config 的唯一真值。首版支持 `string`、`number`、`boolean`、`enum`、`file`、`directory`。字段可声明 `title`、`description`、`default`、`required`、`sensitive`；`enum` 用 `values`，`number` 可用 `min` / `max`。

`config.presentation` 是可选展示合同。显式 `groups` 按声明顺序显示；未分组的普通字段进入“其他设置”，未分组且字段 presentation 声明 `advanced: true` 的字段进入合成高级组，显式 group 归属优先。没有 presentation 时，全部 schema 字段仍进入通用组并保持可编辑。

`valueLabels` 只改变 enum token 的显示文本，不改变 store、helper 或 lifecycle 中的原值。preset 只更新 `values` 中列出的 key，不重置其它 key；推荐值和 preset 值必须符合 schema 类型、enum、`min` 和 `max`。插件首次采用 presentation 时，`compatibility.aw.minVersion` 必须声明首个支持该合同的 AW CLI 发布版本，不能使用更低的 compatibility floor。

配置有三层 store：

| scope            | 路径                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `user`           | `<AW_HOME>/plugin-config/<sourceId>/<pluginName>/config.json`                                       |
| `project shared` | `<repo-or-workspace-root>/.agent-workflows/plugin-config/<sourceId>/<pluginName>/config.json`       |
| `project local`  | `<repo-or-workspace-root>/.agent-workflows/plugin-config.local/<sourceId>/<pluginName>/config.json` |

每个 store 是 schema 2 envelope，固定绑定 `sourceId`、`sourceIdentity`、`pluginName` 和 `values`。裸 plugin name store 属于 legacy state，helper 和 CLI 都 fail closed。JSON、owner、receipt 和诊断使用 canonical `sourceId/pluginName`。

project shared config 是平台中立的 AW 项目配置，同一个仓库里的 Claude 和 Codex 安装默认读到同一份项目配置，并且它是 repo-visible project artifacts 的唯一共享配置输入。project local config 是本机私有覆盖层，默认应被 ignore，只影响本机读命令、lifecycle 和 helper，不触发 repo-visible artifact refresh。

读取 project effective config 的顺序是 `manifest default < user < project shared < project local`。写命令默认写 `user`；`aw config set --scope project` 写 project shared store，`aw config set --scope project --local` 写 project local store；读命令默认读 effective。

`file` / `directory` 类型写入时按 AW project root 解析相对路径，并以 canonical absolute realpath 落盘。每次读取本机 effective config 都会重新校验路径存在且类型正确；路径失效时，lifecycle 和 helper 会 fail closed。路径型 key 不能写入 project shared config，也不能进入 project artifact render config、digest、stale 判断或 refresh；需要项目内本机路径时，用 `--scope project --local`。

`sensitive: true` 表示 AW CLI、status、lifecycle 输出、debug log 和插件测试失败摘要要脱敏；它不是系统 keychain 或加密存储承诺。插件自己的脚本如果读取了原始值，不能把它打印到 stdout、stderr 或日志里。

### CLI 用法

```bash
aw config list <plugin>
aw config get <plugin>
aw config get <plugin> apiKey
aw config get <plugin> --scope user --json

aw config set <plugin> apiKey sk-test
aw config set <plugin> maxFiles 20 --value-json
aw config set <plugin> enabled true --value-json --scope project
aw config set <plugin> workspaceDir ./tmp --scope project --local

aw config unset <plugin> apiKey --scope user
aw config reset <plugin> --scope project --yes
aw config list <plugin> --scope project --local
```

要点：

- `list` 展示 schema key 的来源、required/default 状态和配置问题。
- `get` 不带 key 时按 `key=value` 输出所有可见配置；带 key 时只输出该值。敏感值在 AW CLI 输出中会显示为 `[redacted]`。
- `--json` 控制命令输出格式；`--value-json` 只用于 `set`，表示把传入的 `<value>` 当 JSON literal 解析，适合 number、boolean，以及需要保留 JSON 字符串语义的值。
- 交互式配置向导只在 `aw` 主控制台中提供；脚本化写配置只使用 `set`、`unset` 和 `reset`。
- 插件只要能从当前 catalog 解析，即使还没有安装，也可以先用 `set` 预配置。
- `aw config set --scope project` 会写 project shared config；如果 key 是 `file` / `directory` 类型，命令会在写入前失败，请改用 user store 或 `--scope project --local`。
- `aw config get/list --scope project` 必须区分 project shared、project local 和最终 effective value；project local 覆盖不表示 repo-visible project artifacts 会刷新。
- `unset` 删除某一层 store 中的单个 key，不会删除其它 key。
- `reset` 删除整个 scope store。目标 store 存在时脚本化调用需要 `--yes`；目标 store 不存在时是 no-op。
- `reset` 不需要当前 catalog 里仍有这个插件，因此可以用来清理已卸载或已从 catalog 移除的插件残留配置。
- `aw uninstall` 和 `aw cleanup` 保留 AW config。只想删除配置时显式运行 `aw config reset <plugin> -s user|project`。

### 输出分层和 receipt

默认人类输出只承诺展示完成状态、友好原因和必要下一步，不适合脚本解析。需要详细诊断时使用 `--verbose` 或 `--debug`。

所有脚本化写命令的 `--json` stdout 都是单一 JSON receipt。五个写命令和配置写命令使用 receipt schema 4，并返回 canonical plugin identity；配置写命令还返回 `updatedKeys` / `removedKeys` 和 target reinstall 结果。

`aw status` 是 live ownership 只读投影：默认输出友好摘要，`aw status --verbose` 展示组件检查，`aw status --json` 输出 `schemaVersion: 4`、multi-source catalog、filters、targets 和 errors。每个 target 的状态只允许 `present`、`absent`、`partial`、`error`。

## 标准配置 Helper

新插件推荐复用当前 Skill 的 `assets/aw-config.mjs`；先检查 `aw plugin init --help`，再使用 `aw plugin init ... --with-config-api` 让确定性脚手架复制它。helper 支持两个命令：

```bash
node scripts/aw-config.mjs get apiKey
node scripts/aw-config.mjs json
node scripts/aw-config.mjs get mode --scope user
node scripts/aw-config.mjs json --scope project
node scripts/aw-config.mjs json --scope project-local
```

helper 的读取路径分两种：

- 有 `AW_PLUGIN_CONTEXT` 时，优先读取 context 里的 `config.values`、`config.sources`、`config.schema` 和 `paths.configStores`。lifecycle、`pnpm plugin:test` 和受 AW 管理的脚本都走这条路径。
- 没有 `AW_PLUGIN_CONTEXT` 时，从当前 helper 文件定位 bundle manifest，并要求它位于 `<AW_HOME>/marketplaces/<sourceId>/plugins/<pluginName>`。helper 验证 marketplace `config.json` 的 schema 2 source identity，再读取同 source 的 namespaced schema 2 config envelope。

无 context fallback 使用的是“当前 namespaced marketplace bundle 视图”，而 `aw config get/list` 使用的是当前 multi-source resolution。helper 找不到 bundle manifest、不能验证 source identity、发现旧裸名 store、envelope identity 不匹配或 schema 校验失败时必须 fail closed，不能回退到其它 source 或 schema-less raw store。

`get` 输出原始值，供脚本使用；`json` 同时包含 `values` 和 `redactedValues`。调试、日志和错误消息应优先使用 `redactedValues`。
