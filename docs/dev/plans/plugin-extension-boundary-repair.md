# 插件扩展能力边界修复计划

## 结论

这次 review 的主体判断成立：当前仓库维护的是一套项目公共 contract，并不等于 Claude Code / Codex 的完整原生插件边界。此前报告列出的 3 个问题都存在；本轮复核又确认了 Claude permissions 这类同级原生错配，以及若干会影响实现落地的执行层缺口，计划需要一并补齐：

- Claude hooks 当前输出格式和 `PluginHooksSchema` 不兼容。
- Codex permissions 当前 `.rules` 语法和 execpolicy `prefix_rule(...)` 不兼容。
- Claude permissions 当前仍把裸命令字符串直接写入 `settings.permissions` / `settings.awGenerated.permissions`，没有对齐 Claude 原生的 `Bash(...)` tool-scoped rule 语法。
- `.app.json` 当前示例与校验口径没有对齐 Codex 实际消费的 `apps.*.id`。
- 模板化 JSON native asset 的修复面当前仍偏向 `.app.json`，还没有把同样支持模板渲染的 `.mcp.json` 纳入同一套 source / rendered / 作者工具 / 测试规则。
- Codex hooks 当前生成的是自定义 `{ "commands": [...] }`，Codex 实际读取的是 `{ "hooks": { "<Event>": [...] } }`。
- `command` hook 语义还没收口，但真实样例、生成器和集成测试已经依赖它。
- `session_stop` 当前仍被当成公共 hook 事件，但计划还没有把它和 Claude `SessionEnd` / Codex `Stop` 的映射或移除策略一起收口。
- `extensions.hooks[].description` 目前仍是公共字段，但两端生成目标都没有稳定消费语义，去留还没正式收口。
- `agentOverrides` 只在本地 bundle 阶段生效，Claude / Codex 安装扩展主路径还在直接消费原始 entries。
- 平台生效视图目前还没覆盖 ledger、`status()` 和 historical fallback 这条状态链，`agentOverrides` 很容易出现“装得对、状态错”的假阳性。
- Codex `status()` 对 hooks 当前主要还是靠 tracking 和共享 `hooks.json` 文件存在性判断，缺少“当前插件自己的 handlers 仍然在共享文件里”的内容核对。
- permissions 公共层仍在沿用“精确匹配 / `*` 通配”的说法，还没有正式对齐 Codex 实际支持的 token 前缀匹配语义。
- `extensions.permissions` 还没有正式定义共享 source 语法与 Claude / Codex 各自稳定渲染目标；若只修 Codex，会落成“Codex 生效、Claude 失效”的半修状态。
- 模板化 JSON native asset 校验层次还没收口：当前既不会在主链路拦住缺少 `apps.*.id` 的最终 `.app.json` artifact，也还没把同样支持模板渲染的 `.mcp.json` 纳入同一套 source / rendered / 作者工具边界。
- source 插件校验和 bundle 插件加载当前仍共用 `readPluginManifest()` 入口，若把 source 语义继续直接塞进这个共享入口，会连带打坏 current catalog、local bundle 和 historical fallback 的 bundle 读取。
- rendered native asset 校验还没接入 `validateBundleLayout()` 与 `pnpm test:smoke:build`，embedded bundle 健康检查现在仍然主要只能发现“文件缺失”，发现不了“产物语义已经失真”。
- `init_plugin.js --with-apps` 当前仍会生成空 `apps` stub，和新 contract 下的默认作者路径不兼容。

当前处于开发阶段，不考虑旧版构建物兼容，所以这轮修复可以直接切到新 contract，不必为旧 `{ "commands": [...] }` hooks artifact、旧 tracking 字段或旧行式 rules 设计迁移桥接。

## 已核对的问题

### 1. Claude hooks 格式错配

本仓库当前模型：

- `extensions.hooks[]` 使用 `{ event, matcher, command, description }` 数组。
- `renderHooksArtifact(..., "claude")` 输出 `{ "hooks": [{ "event": "beforeToolUse", ... }] }`。

Claude Code 当前模型：

- hook 文件外层是 `{ description?, hooks }`。
- `hooks` 是按事件名分组的对象，事件名来自 `PreToolUse`、`PostToolUse`、`SessionStart`、`SessionEnd` 等枚举。
- 每个事件下是 matcher group 数组：`{ matcher?, hooks: [{ type: "command", command, ... }] }`。

所以现有 `hooks/hooks.json` 不是 Claude 原生兼容格式。

### 2. Codex permissions 语法错配

本仓库当前把 Codex 权限写成：

```text
allow git status
ask git commit
deny git push --force
```

Codex 当前 execpolicy 使用 Starlark 风格规则：

```starlark
prefix_rule(pattern = ["git", "status"], decision = "allow")
prefix_rule(pattern = ["git", "commit"], decision = "prompt")
prefix_rule(pattern = ["git", "push", "--force"], decision = "forbidden")
```

同时，原来的 `ask` / `deny` 决策名需要分别映射为 `prompt` / `forbidden`。

### 3. Claude permissions 原生规则形状也还没收口

本仓库当前把 Claude 权限直接合并进 `settings.permissions` / `settings.awGenerated.permissions`，形状类似：

```json
{
  "permissions": {
    "allow": ["git status", "git diff"],
    "ask": ["git commit"]
  }
}
```

Claude Code 原生会先把每条规则解析成 `{ toolName, ruleContent? }`。只有 `Bash(...)` 这类 tool-scoped 规则才会进入 Bash 命令级匹配；裸字符串 `git status` 会被当成 `toolName = "git status"`，不会作为 Bash 子命令规则生效。当前上游区分 exact / prefix / wildcard 这些 shell 模式，但它们都建立在 `Bash(<pattern>)` 语法之上。

所以现有 `mergeClaudePermissions(...)`、`ClaudeAdapter.installExtensions()` 和相关单测，实际上都在固化一个“Claude settings 能写进去、但原生不会按 Bash 子命令规则消费”的错误 contract。这轮如果继续把 `extensions.permissions` 作为双平台公共能力，就不能只修 Codex，还必须把 Claude 的原生渲染目标一起写进计划。

### 4. `.app.json` schema 错配

本仓库文档把 `.app.json` 写成：

```json
{
  "apps": {
    "dashboard": {
      "url": "https://dashboard.example.com",
      "description": "项目仪表盘"
    }
  }
}
```

Codex 当前只读取 `apps.*.id`，最终消费的是 `AppConnectorId`。对象 key 不会自动作为 app id，`url` 和 `description` 也不会被 loader 消费。

### 5. Codex hooks 生成也已错配

本仓库当前写入 `.codex/hooks.json`：

```json
{
  "commands": [
    {
      "matcher": "git *",
      "command": "echo git hook"
    }
  ]
}
```

Codex 当前读取的是：

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "...",
        "hooks": [
          {
            "type": "command",
            "command": "..."
          }
        ]
      }
    ]
  }
}
```

由于 `HooksFile` 的 `hooks` 字段有默认值，旧结构不会直接报错，但会变成空 hooks，效果等同于没有注册。

### 6. Codex scope 说明基本正确

报告中关于 Codex scope 的结论成立：

- repo 中可以发现 `.agents/plugins/marketplace.json`。
- 原生 plugin enabled 状态主要从 user layer 的 `[plugins.*]` 读取。
- 当前 `CodexAdapter.installPlugin()` 也按这个模型写 `~/.codex/config.toml`，`--scope project` 只影响 repo-managed artifacts。

这块不需要推翻，只需要在文档里说得更清楚，避免让插件作者误以为 repo-local marketplace 等于 repo-local native install。

## 额外确认的落地缺口

### 1. 公共 HookEvent 集合目前仍未收口，不能只盯 `command`

当前仓库里已经有真实依赖：

- `plugins/git-commit/.agents-plugin/plugin.json` 直接声明了 `event: "command"`。
- `packages/cli/src/generators/hooks.ts` 当前只会把 `command` 事件抽成 Codex hooks。
- `packages/cli/tests/integration/cli.test.ts` 现有断言也是围绕这个语义写的。
- `packages/cli/src/types.ts` 和 `references/extensions-spec.md` 仍把 `session_stop` 当成公共事件。
- `packages/cli/src/generators/hooks.ts` 目前还把 `session_stop` 映射成 `sessionStop`，但上游真实事件分别是 Claude `SessionEnd` 和 Codex `Stop`。

如果不先把公共 HookEvent 集合收口，后续 hooks 生成器、fixture 和集成测试都会一边改一边返工；`command` 会继续悬空，`session_stop` 也会继续挂着一个当前并不存在的伪公共事件名。

### 2. `agentOverrides` 现在只在 bundle 阶段解析，安装扩展主路径并没有真正按平台生效

当前只有 `packages/cli/src/generators/local-plugin.ts` 在本地 bundle 生成时调用了 `resolvePlatformEntries(...)`。但 `packages/cli/src/adapters/codex.ts` 和 `packages/cli/src/adapters/claude.ts` 的安装扩展逻辑，仍然直接消费 `plugin.manifest.extensions.*` 原始条目。

这意味着：

- `agentOverrides.<platform> = null` 还不能保证该条目真的不会进入目标平台；
- 后续新增的 hooks / permissions / instructions 校验如果继续基于原始 entries，很容易对本不该生效的条目报错；
- 文档里承诺的平台差异化能力，目前没有落到安装主路径。

### 3. 模板化 JSON native asset（至少 `.app.json` / `.mcp.json`）校验需要拆成 source / rendered 两层，不能只停在作者工具，也不能直接绑到 raw source 读取

`validate_plugin.js` 现在会对 `.mcp.json` 和 `.app.json` 都直接 `JSON.parse`，CLI 主入口 `readPluginManifest()` 则只校验 manifest 里有没有声明对应路径、默认文件有没有漏声明，并不会在共享 source contract 里统一处理这两类 JSON native asset 的模板命中与 raw source 约束。与此同时，当前参考文档已经承诺 `.mcp.json` 和 `.app.json` 都支持 `buildConfig.templates`，`bundleLocalPlugin()` / `copyFileWithTemplateSupport(...)` 也会对命中 include 规则的任意 `.json` 文件先渲染再写入 bundle。

这意味着如果继续维持现状，无效 app 配置仍然能通过主链路，被打进 bundle 或安装过程，最后只在 Codex 原生 loader 读取时被静默丢掉；而如果只把 `.app.json` 的 source / rendered 分层补齐，却不把 `.mcp.json` 一并纳入同一套规则，那么模板化 `.mcp.json` 仍然会在作者工具或 source 校验里被当成 raw JSON 误报，最终留下“`.app.json` 修好了，`.mcp.json` 继续漂移”的半修状态。

### 4. 平台生效视图还没有覆盖 ledger / status / historical fallback，状态链仍会直接读取原始 manifest

当前计划已经意识到 `agentOverrides` 不能只停在 bundle 阶段，但范围还不够完整。当前基线里，下面这些状态链节点仍然直接看原始 `plugin.manifest.extensions.*`：

- `packages/cli/src/adapters/codex.ts` 里的 `requiresNativePlugin(...)`、`hasRepoManagedArtifacts(...)`、ledger `capabilitySnapshot`、`status()` 中的 `currentCapabilities` 和 `repoManagedSessionState.declarations`
- `packages/cli/src/adapters/claude.ts` 里的 `getClaudeManagedExtensions(...)`、ledger `capabilitySnapshot` 和 `status()` 的 `repoManagedSessionState`
- `packages/cli/src/commands/common.ts` 里的 `createHistoricalExtensionKinds(...)` / `createHistoricalPluginMeta(...)`

这意味着即使安装产物已经按平台生效视图生成正确，只要某个条目被 `agentOverrides.<platform> = null` 排除，状态面仍然可能继续把它算进 capability snapshot、`catalogCompatibility`、`visible` / `missing`，甚至在 historical fallback 时重新伪造占位条目。

另外，当前 Codex `status()` 对 hooks 的 managed / visible 判断，基本只看 tracking 里有没有 hook artifact，以及共享 `.codex/hooks.json` 是否还在。只要共享文件还在，即使当前插件自己的 hook group 或 handlers 已经丢了，状态面也仍可能继续报“可见”。所以第 5 步除了切到平台生效视图，还要把共享 hooks 文件内容核对写进去，否则仍会留下单插件级别的假阳性。

### 5. permissions 的公共语义与 Claude / Codex 的稳定渲染目标都还没有正式收口

当前 `references/extensions-spec.md` 仍把 permissions 模式写成：

- `"git status"` 表示精确匹配
- `"git *"` 表示前缀通配

但这个描述同时和两端原生能力都有偏差：

- Codex 当前 execpolicy 的真实能力是 token 级前缀匹配：`prefix_rule(pattern = ["git", "status"], ...)` 也会匹配 `git status --short`，而 `"git *"` 也不是原生 token 语法，最多只能被宽化为更短的前缀，或者在公共层直接拒绝。
- Claude 当前 shell 规则要求 `Bash(<pattern>)` 这类 tool-scoped 语法，prefix / wildcard 语义来自 `ruleContent` 本身；如果继续把公共输入原样写成裸 `git status`，连正确的 tool scope 都进不去。
- 若公共层允许 `"git status"`、`"git push --force"`、`"git *"` 这类输入，就必须先定义共享 parser / normalizer，再固定它们在 Claude / Codex 两侧各自渲染成什么；否则生成器、validator 和运行时会继续各自解释。

如果不先把公共语义定下来，后续会很容易出现文档、manifest 校验、generator 渲染和最终运行时各自解释不一致的问题。

### 6. `init_plugin.js --with-apps` 的默认 scaffold 也要和新 contract 一起收口

当前 `init_plugin.js --with-apps` 会创建：

```json
{
  "apps": {}
}
```

同时自动把 `apps: "./.app.json"` 写进 manifest。若这轮修复要求 `.app.json` 的最终 artifact 必须提供有效的 `apps.*.id`，那官方脚手架默认生成的插件就会在不做任何修改的情况下直接变成无效输入。

这不是文档示例还没更新的小问题，而是默认作者路径会先被我们自己的 validator / build / install 主链路拦住；并且当前作者工具测试还没有覆盖 `--with-apps` 分支，这个回归很容易在实现时漏掉。

### 7. `extensions.hooks[].description` 也要在这轮一起处理，不能继续作为“看起来合法但没有明确消费方”的悬空字段

当前公共 schema、参考文档和生成器都还保留 `extensions.hooks[].description`，但无论 Claude 还是 Codex，这个字段都不是当前计划要对齐的稳定原生 handler 字段。继续保留会带来两个问题：

- 文档会继续承诺一个“可以写”的公共字段，但实现阶段既不知道它该进哪层 schema，也不知道它是否应该进入 tracking。
- hooks 结构这轮本来就要重做；如果不趁这次明确删掉，后面只会在类型、fixture、生成器和回滚逻辑里继续拖着一个没人真正消费的属性。

### 8. source 插件校验和 bundle 插件加载还没有正式分层，后续若继续沿用同一个入口，很容易把 bundle 读取链一起打挂

当前 `readPluginManifest()` 会固定读取 `.agents-plugin/plugin.json`，并在读取后执行 `validateDeclaredNativeAssets(...)`，检查 `skills`、`.mcp.json`、`.app.json` 这些源码侧声明与默认路径是否匹配。与此同时：

- `bundleLocalPlugin()` 会把 source manifest 原样写入 bundle 的 `.agents-plugin/plugin.json`；
- bundle 真正落盘的文件却会被复制到 `./claude/**` 或 `./codex/**`，不会保证源码声明路径在 bundle root 原样存在；
- `resolvePluginsFromCatalog()`、`resolveTrackedPlugin()` 以及 tracked plugin 缺失 current catalog 时的 fallback，都会继续对 bundle root 调用 `readPluginManifest()`。

这意味着计划里如果只写“给 `readPluginManifest()` 增加 `.app.json` source 层约束”，实现阶段就很容易顺手把 source 校验继续灌进 bundle 入口，最后不是只影响作者工具，而是把 current catalog、local bundle、historical fallback 和 uninstall/rebuild hooks 这条主路径一起打挂。

### 9. rendered native asset 校验还没有挂到 embedded bundle 健康检查主链路，`pnpm build` 产物仍可能在运行时才暴露 contract 破坏

当前基线里：

- `resolveEmbeddedPluginsRoot()` 依赖 `validateBundleLayout()` 判断 embedded bundle 是否可用；
- `validateBundleLayout()` 现在会校验 marketplace mirror、一组必需文件、source manifest 可 parse，以及平台 manifest 指向的文件路径是否存在；
- `pnpm test:smoke:build` 目前只断言 `plugins-dist` 下少量文件生成成功，并不会调用编译后的 `validateBundleLayout()` 或 `resolveEmbeddedPluginsRoot()`。

所以即便后续实现补了 install preflight 或 bundle 生成阶段的 rendered 语义校验，只要没把同一套校验接到 `validateBundleLayout()` 和 build smoke，embedded bundle 仍然可能在 `pnpm build` 之后被当成“健康产物”发布出去，直到 CLI 真正加载它时才暴露坏的 `.app.json`、hooks 或 permissions artifact。

## 修复目标

- 在 `.agents/skills/create-agent-workflows-plugin` 和作者文档中说清楚：这里维护的是 agent-workflows 的源码层公共 contract，不是 Claude Code / Codex 原生插件 schema 的全集。
- 让 `agentOverrides` 在 bundle、install、validation、ledger/status、historical fallback 这些主路径中基于同一份平台生效视图工作。
- 修复 Claude hooks、Claude permissions、Codex permissions、Codex hooks、`.app.json` 的真实落盘格式，并把模板化 JSON native asset（至少 `.app.json` / `.mcp.json`）统一到同一套 source / rendered 两层校验口径。
- 在生成和校验之前先收口 permissions 的公共语义与双平台渲染目标，避免文档、validator 和 Claude / Codex 运行时各说各话。
- 保留当前公共层的最小能力面，但清楚列出未纳入公共层的上游原生能力。
- 用测试固定上游兼容格式，降低后续漂移风险。

## 非目标

- 不一次性覆盖 Claude Code / Codex 的完整原生插件能力。
- 不把 Claude-only 或 Codex-only 高级能力塞进公共 `extensions` 模型。
- 不重写 marketplace / install / ledger 的总体状态模型。

## 实施步骤

### 1. 先收口公共 HookEvent 的 contract

- 把 `extensions.hooks[].event` 作为前置决策处理，不再只盯 `command`，至少把 `command` 和 `session_stop` 一起收口。
- 复核当前公共事件集合中每个事件是否都能稳定映射到 Claude / Codex 的真实原生事件；不能稳定映射的，直接移出公共层。
- 只接受两种结果：
  - 从公共层移除 `command`，现有样例、fixtures、测试和文档直接迁到新的公共事件集合；
  - 保留 `command`，但必须同时定义：
    - Claude / Codex 各自映射到哪个原生事件；
    - `matcher` 匹配的对象究竟是工具名、命令前缀，还是别的公共语义。
- 对 `session_stop` 也只接受两种结果：
  - 从公共层移除 `session_stop`，旧样例、fixture 和文档同步删除；
  - 保留 `session_stop`，但必须明确它为什么可以共用一个公共事件名，以及它在 Claude / Codex 上分别映射到 `SessionEnd` / `Stop` 的依据。
- 当前处于开发阶段，不做兼容桥接；决策完成后，旧样例与旧断言直接切到新 contract。

### 2. 统一平台生效视图

- 把 `resolvePlatformEntries(...)` 从 `packages/cli/src/generators/local-plugin.ts` 提到共享位置，避免只在本地 bundle 阶段生效。
- 把源码插件校验与 bundle 插件加载正式拆开，不再让同一个 manifest 入口同时承担两种语义：
  - source 入口面向 `plugins/<name>/` 源码目录和作者工具，负责声明存在性、模板命中规则与 raw source 约束；
  - bundle 入口面向 `plugins-dist/plugins/<name>/`、`~/.aw/plugins/<name>/`、tracked plugin fallback，负责读取 `.agents-plugin/plugin.json` 的公共 contract，不再假设源码声明路径会在 bundle root 原样存在；
  - 若继续复用 `readPluginManifest()` 这个名字，也至少要显式引入 `mode: "source" | "bundle"`，避免实现时把 source 校验误灌进所有调用点。
- source 侧必须导出一条作者工具可直接复用的权威入口，例如 `readSourcePluginManifest()`、`validateSourcePluginManifest()`，或 `readPluginManifest(..., { mode: "source" })`：
  - CLI 源码主链路与 `validate_plugin.js` built 模式都只调用这条 source 入口来校验共享 source contract；
  - 共享 source contract 只覆盖公共源码主链路本来就要负责的约束，例如 manifest shape、声明存在性、模板命中规则和 raw source 级 fail fast 约束；
  - `validate_plugin.js` 现有的目录名匹配、build output 目录禁入、`SKILL.md` frontmatter / TODO / `agents/openai.yaml` 之类作者工具附加检查，继续留在作者工具层，不要求 CLI source 主链路也报同样的错；
  - `validatePluginManifest()` 这类字段级 shape validator 若继续保留，只给 bundle loader、内部归一化或单测使用，不能再承载 source 层 contract 真值。
- 让以下路径都基于同一份“目标平台生效 entries”工作：
  - Claude / Codex 安装扩展路径
  - hooks / permissions / instructions / agents 生成器
  - source manifest 级校验与 rendered native asset 校验
  - ledger `capabilitySnapshot`、`catalogCompatibility` 和 `repoManagedSessionState` 计算
  - historical fallback 占位条目构造
- 明确约束：
  - `agentOverrides.<platform> = null` 表示该条目完全不进入目标平台；
  - `agentOverrides.<platform> = { ... }` 先覆盖默认值，再进入后续校验和生成。
- 明确把这些函数列入改造范围：
  - `getClaudeManagedExtensions(...)`
  - `requiresNativePlugin(...)`
  - `hasRepoManagedArtifacts(...)`
  - `createHistoricalExtensionKinds(...)` / `createHistoricalPluginMeta(...)`
  - Claude / Codex `status()` 里 declarations、capability 和 compatibility 的计算逻辑
- 相关生成器、adapter 和状态辅助逻辑不再直接消费原始 `plugin.manifest.extensions.*`。

### 3. 对齐 skill 与文档口径

这一节只负责把作者能读到的说明改准、改顺。所有 hooks 相关文字都等第 1 步完成 HookEvent 决策后再回填，尤其是 `session_stop` / `Stop` 的去留和映射关系；文档不能先写一套结论，后面的类型和生成器再改成另一套。

文档更新时沿用现有作者文档的表达方式：先讲插件作者该怎么写，再讲 CLI 会生成什么，最后补平台差异和限制。不要把 Claude / Codex 的原生 schema 逐项翻译进公共文档，也不要把内部实现名堆成一段难读的说明；确实需要保留的术语用短句解释清楚。

- 更新 `.agents/skills/create-agent-workflows-plugin/SKILL.md`：
  - 开头补一句边界说明：这个 skill 面向 `agent-workflows` 仓库里的源码插件，描述的是源码层公共 contract；Claude Code / Codex 的完整原生插件能力只在需要时作为参考，不是这里的默认承诺。
  - “验证”部分改成两层口径：共享源码 contract 由 CLI 的源码校验入口负责；`SKILL.md` frontmatter、TODO 占位、`agents/openai.yaml` 等仍属于作者工具体验检查。
  - 说明 `validate_plugin.js` 在已构建 CLI 时复用权威源码校验；CLI 未构建时只做轻量预检，输出里要明确“预检通过不等于完整 contract 通过”。
  - `--with-apps` 的描述从“生成 `.app.json` 存根”改成“生成带示例 connector id 的最小 `.app.json`，作者需要替换成真实 id”，避免默认脚手架一生成就是无效输入。
- 同步更新 `docs/plugin-authoring.md`、`docs/plugin-installation.md`、`docs/coding-conventions.md` 以及其他会展示 permissions / hooks / 安装产物的入口：
  - `docs/plugin-authoring.md` 继续保持短说明风格，重点讲源码 manifest、scope 语义和公共 extension 的作者写法；不要把平台原生产物细节写成作者必须手工维护的结构。
  - `docs/plugin-installation.md` 删除旧 Codex 产物路径，比如 `.codex/permissions.json`、`.codex/agents.json`；安装后产物只描述这轮 contract 下真实会写入、可排查的文件和状态。
  - `docs/coding-conventions.md` 里的 `HookEvent`、hooks artifact 形状和相关约定跟随第 1 步最终结论回填，不再写死旧公共事件集合或旧 artifact 结构。
  - 这些入口里的 Claude permissions 示例都要换成原生可消费、带工具作用域的规则，不再把裸 `git status` / `git diff` 当作正确输出。
- 更新 `references/extensions-spec.md`：
  - permissions 先从作者输入说起：公共层到底接受哪些命令模式，`"git status"` 是 token 前缀匹配还是精确匹配，`"git *"` 是保留、归一化还是直接拒绝。规则定下来后，再给出共享 parser / 中间表示和失败条件。
  - 在同一套公共语义下面展示平台输出：Claude 渲染为原生可解析、带工具作用域的规则字符串（至少覆盖 `Bash(...)`），Codex 渲染为 `prefix_rule(...)`；示例至少覆盖 `"git status"`、`"git commit"`、`"git push --force"`，以及 `"git *"` 的最终接受 / 拒绝结果。
  - hooks 改成两层说明：公共 hook 子集负责作者能写什么，平台映射负责 Claude / Codex 最终落到哪个原生事件和文件结构。第 1 步对 `command`、`session_stop` 以及其他 stop / command 类事件的结论，要在这里用同一套术语写清楚。
  - 删除 `extensions.hooks[].description` 这个公共字段，不再承诺 per-hook 说明会进入平台产物。
  - 写清 Claude hooks 输出符合 `PluginHooksSchema`，Codex hooks 输出符合 `HooksFile`，但正文用作者能理解的例子带出来，不写成上游 schema 的机械翻译。
  - `agentOverrides` 改成“先得到目标平台生效条目，再做校验和生成”的规则说明，避免读者误以为它只是文档层的提示。
- 更新 `references/mcp-and-apps.md`：
  - `.app.json` 示例改为 `apps.<name>.id`，并说明 `url` / `description` 目前不是 Codex loader 会消费的字段。
  - 把 `.mcp.json` 和 `.app.json` 放在同一个“模板化 JSON 原生资产”口径下说明：两者都可以命中 `buildConfig.templates`，源码层只做适合源码的快速检查，最终语义以渲染后的产物为准。
  - 渲染后的 `.mcp.json` 至少要求顶层 `mcpServers` 为对象；渲染后的 `.app.json` 要求 `apps.*.id` 是非空字符串。
- 更新 `references/comprehensive-example.md`：
  - 替换旧的行式 `allow/ask/deny` rules、旧 `commands` hooks 和旧 `.app.json` 示例。
  - 增加一段模板化 `.mcp.json` / `.app.json` 的统一示例，让读者能看出两类 JSON 资产走的是同一套“源码到渲染产物”的规则。
- 新增或扩展“当前不纳入公共层”章节。这里不要写成“平台能力缺失清单”，而要说明这些能力仍属于上游原生能力，只是本轮不放进 `extensions` 公共模型：
  - Claude skill frontmatter：`hooks`、`context: fork`、`agent`、`effort`、`paths` 等。
  - Claude plugin agent frontmatter：`skills`、`color`、`model`、`background`、`memory`、`isolation`、`maxTurns`、`disallowedTools` 等。
  - Claude plugin agent 当前明确忽略的字段：`permissionMode`、`hooks`、`mcpServers`。
  - Codex hooks 原生事件：除第 1 步最终保留并映射进公共层的事件外，其余 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`SessionStart`、`UserPromptSubmit`，以及未被公共层吸收的原生 `Stop`，都只作为平台原生能力记录，不写进公共 hook contract。

### 4. 修复类型、生成器与主链路校验

- 调整 `packages/cli/src/types.ts`：
  - 按第 1 步结论收敛 `HookEvent` 的公共事件集合，特别是把 `session_stop` 的去留与映射一起收口，不再让它悬空指向未定义语义。
  - 从 `HookDefinition` 和对应 `agentOverrides` 结构里移除 `description`，不再把它作为公共 hook contract 的一部分。
  - 为 Codex hooks tracking 引入稳定的内部结构，避免继续用 `commands` 作为持久化真值。
- 把 hook 事件约束从 TypeScript 类型收口到运行时 manifest 校验：
  - `readPluginManifest()` / `normalizeHookEntry(...)` 对 `extensions.hooks[].event` 做枚举校验，只接受第 1 步最终定下的公共事件集合。
  - `agentOverrides.<platform>.event` 走同一套校验，不再只做字符串断言后强转成 `HookEvent`。
  - 若第 1 步最终移除 `command` 或 `session_stop`，旧 `event: "command"` / `event: "session_stop"` 都必须在 manifest 读取阶段直接失败，不能延后到 hooks 生成或安装阶段才暴露。
  - 同时拒绝 `extensions.hooks[].description` 和 `agentOverrides.<platform>.description` 这类已移出公共 contract 的字段，避免文档已删、实现却静默吞掉。
- 把 permissions 语义约束也收口到运行时 manifest 校验：
  - `readPluginManifest()` / `normalizePermissionEntry(...)` 只接受第 3 步最终定下的公共模式语义。
  - 若 `"git *"` 或其他历史写法不再被公共层接受，必须在 manifest 读取阶段直接失败，不能在 Codex 生成时静默放宽。
  - 若公共层继续支持带空格、引号、转义或 `:*` / `*` 这类模式，必须先归一化到共享 parser / normalizer，再分别渲染到 Claude / Codex，不能让两个平台各自解释字符串。
- 修改 `packages/cli/src/generators/hooks.ts`：
  - Claude 输出改为 `{ description?, hooks: { [NativeEvent]: MatcherGroup[] } }`。
  - Codex 输出改为 `{ hooks: { [NativeEvent]: MatcherGroup[] } }`。
  - 每个 handler 输出 `{ type: "command", command }`，后续再按平台补充 `timeout`、`statusMessage` 等扩展字段。
  - 不再把旧的 per-hook `description` 写进 Claude / Codex 产物或 tracking 结构。
  - 只根据第 1 步已经收口的公共事件做映射，不能继续输出旧 `commands`，也不能继续产出当前错误的 `sessionStop` 事件名。
- 修改 `packages/cli/src/generators/permissions.ts`：
  - Claude 输出改为原生可解析的 tool-scoped rule 字符串，不再把裸命令字符串写进 `settings.permissions` / `settings.awGenerated.permissions`。
  - Codex rules 输出 `prefix_rule(pattern = [...], decision = "...")`。
  - `allow` -> `allow`，`ask` -> `prompt`，`deny` -> `forbidden`。
  - 同一条公共输入先解析成共享中间表示，再分别渲染成 Claude 原生规则与 Codex `prefix_rule(...)`；若某种模式无法稳定双向映射，在 source 层直接拒绝。
  - 所有规则都基于第 2 步解析后的平台生效 entries 生成，只渲染已经通过第 3 步 contract 校验的模式。
- 把 native asset 校验拆成 source / rendered 两层，并把 rendered 校验输入显式抽象成“产物描述”，而不是继续把语义校验绑死在 bundle 文件路径上：
  - source 层把 `.app.json` / `.mcp.json` 统一当作模板化 JSON native asset 处理：复用 `buildConfig.templates` 的命中规则校验声明存在、路径合法；若文件命中模板渲染，不要求 raw source 能直接 `JSON.parse`；若未命中模板渲染，则继续做基础 `JSON.parse` 和顶层结构 fail fast。
  - bundle 内原生产物的 descriptor 由 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 或等价平台 manifest 提供，指向 bundle root 里真实存在、可寻址的文件；`validateBundleLayout()` 只负责这类输入。
  - install 阶段生成的 repo-managed 产物 descriptor 由 generator 输出提供，至少携带 `platform`、`kind`、逻辑来源和最终 content；必要时可先 materialize 到 staging / temp，再交给同一套语义校验器，但不能假设它们都能从平台 manifest 反查路径。
  - source 层对未命中模板渲染的 JSON native asset 至少要求：
    - `.mcp.json` 顶层存在 `mcpServers`，且其值是对象；
    - `.app.json` 顶层存在 `apps`，且其值是对象；
    - 但 `.app.json` 的 `apps.*.id` 仍属于 rendered 语义，不提前绑到 raw source。
  - rendered 层在 `bundleLocalPlugin()` 产物校验、`validateBundleLayout()` 和 install 前 preflight 共享同一套 parse / semantic checks：对目标平台最终 materialized 的 `.mcp.json` 做 `JSON.parse` 并校验顶层 `mcpServers` 为对象；对目标平台最终 materialized 的 `.app.json` 做 `JSON.parse` 并校验 `apps.*.id` 为非空字符串；对 hooks / permissions 做目标平台最终 artifact 语义校验。
  - 同一类 contract 违规在 bundle 校验和 install preflight 里要产出一致的错误语义，避免 bundle、install、embedded runtime 各走各的检查逻辑。
  - hooks / permissions 若存在会影响平台映射的非法 matcher 或模式，仍在 source 层统一 fail fast。
- 同步修改作者工具：
  - `validate_plugin.js` 明确分成两层职责：共享 source contract 校验，以及作者工具附加检查。
  - 已构建 CLI 时，`validate_plugin.js` 只复用第 2 步导出的 source 权威入口来覆盖共享 source contract，不直接 import `validatePluginManifest()` 这类字段级 validator；未构建时只做轻量预检，不在 fallback 里复制这轮完整 contract 逻辑。
  - built 模式与 CLI source 主链路对同一份共享 source contract 违规输入，必须得到一致的 accept / reject 结果和同类错误语义，避免出现“主链路已 fail fast、作者工具仍放过”的漂移。
  - 作者工具附加检查继续保留，且失败归因、输出文案和测试命名要与共享 source contract 失败区分开，避免实现时为了“结果一致”把私有 lint 硬塞进 CLI 公共入口。
  - fallback 模式继续复用模板命中判定：对命中模板渲染的 `.mcp.json` / `.app.json` 都不做 JSON hard fail；对未命中模板的文件继续做基础 JSON / 顶层结构检查。
  - fallback 模式的输出文案必须明确标注“这是预检，不代表通过完整 contract 校验”，不能继续用容易被误解成完整通过的成功提示。
  - `init_plugin.js --with-apps` 改为生成带非空示例 `id` 的最小合法 `.app.json`，并保留 manifest `apps` 声明；不再生成空 `apps` stub。
- 让 Claude / Codex adapter 安装扩展时也消费第 2 步的解析结果，而不是原始 manifest 条目。
  - Claude adapter 写 `settings.permissions` / `awGenerated.permissions` 时也只落原生可消费的规则值，不再把原始命令字符串直接 merge 进去。

### 5. 收口状态链与清理逻辑

- ledger `capabilitySnapshot`、`resolveClaudeCatalogCompatibility(...)`、`resolveCodexCatalogCompatibility(...)`、Claude / Codex `status()` 的 declarations 判断都改成基于平台生效视图，不再直接按原始 manifest 长度做真假判断。
- `createHistoricalExtensionKinds(...)` / `createHistoricalPluginMeta(...)` 只为目标平台真实生效、且当前仍有 evidence 的扩展构造占位条目，不再为 `agentOverrides.<platform> = null` 的条目回填假扩展。
- Codex `status()` / `repoManagedSessionState.hooks` 不能只看 tracking 里有 hook artifact 且共享 `hooks.json` 文件存在，还要解析当前共享 hooks artifact，确认当前插件在目标平台应有的 hook groups / handlers 仍然存在。
- 若共享 hooks 文件还在，但当前插件自己的 hook handlers 已经不在文件里，`repoManagedSessionState.hooks` 不能继续报 `visible`，并且要追加专门的 drift warning。
- 不保留旧 `{ commands: [...] }` hooks artifact 的读取兼容；当前版本尚未上线，没有需要迁移的安装产物。
- tracking manifest 直接改成新 hooks 结构，不再保留 `hookCommands` 迁移字段。
- `GeneratedArtifact`、`mergeGeneratedArtifacts()` 和错误回滚附带的 artifact 快照一起切到新 hooks tracking 载荷，不再依赖 `hookCommands` 做去重或恢复。
- uninstall / upgrade 只按新结构处理 CLI 自己写入的 hook handler，不为旧格式写额外分支。
- Codex permissions 直接改写为 Starlark `prefix_rule(...)`，Claude permissions 只保留第 3 步确定的原生 tool-scoped 规则输出；不为当前错误的裸命令字符串或旧行式 rules 设计兼容桥接。

### 6. 更新测试

- 更新 generator 单测：
  - Claude hooks 输出匹配 `PluginHooksSchema` 形状。
  - Codex hooks 输出匹配 `HooksFile` 形状。
  - 若公共层保留 stop 类事件，生成结果要固定断言 Claude 落到 `SessionEnd`、Codex 落到 `Stop`，不能继续出现 `sessionStop`。
  - Claude permissions 输出为原生可解析的 `Bash(...)` tool-scoped 规则，不再出现裸 `git status` / `git diff`。
  - Codex permissions 输出 `prefix_rule(...)`，并覆盖 `ask` / `deny` 映射。
  - permissions contract 覆盖 `"git status"`、`"git commit"`、`"git push --force"`，以及 `"git *"` 在 Claude / Codex 两侧的接受 / 拒绝与渲染结果。
  - rendered `.mcp.json` 校验要求顶层 `mcpServers` 为对象。
  - rendered `.app.json` 校验要求 `apps.*.id`。
  - JSON 模板资产覆盖 `.mcp.json` / `.app.json` source -> rendered artifact 两条链，而不只覆盖 Markdown 模板。
  - hooks fixture 和生成结果都不再出现 per-hook `description`。
- 新增主链路校验断言：
  - source validator 与 bundle loader 对同一个插件目录的失败点不同，并且这个差异有稳定断言覆盖。
  - `readPluginManifest()` 或等价共享入口在 `extensions.hooks[].event` 非法时直接失败。
  - `readPluginManifest()` 或等价共享入口在 `agentOverrides.<platform>.event` 非法时直接失败。
  - 若第 1 步移除 `command`，旧 `event: "command"` 样例在 manifest 读取阶段就报错。
  - 若第 1 步移除 `session_stop`，旧 `event: "session_stop"` 样例在 manifest 读取阶段就报错；若保留，则平台输出映射必须固定为 Claude `SessionEnd`、Codex `Stop`。
  - `readPluginManifest()` 或等价共享入口在 hook entry 继续使用 `description` 这类已移除字段时直接失败。
  - 命中 `buildConfig.templates` 的 `.mcp.json` / `.app.json` source 都不会因为 raw JSON parse 而在 manifest 读取阶段提前失败；其中 `.app.json` 也不会因为 `apps.*.id` 缺失而在渲染前提前失败；
  - 未命中模板渲染的坏 `.mcp.json` 会在 source 层直接因为 JSON 或顶层 `mcpServers` 结构不合法而失败；
  - 保留源码路径声明的 bundle root 仍能被 `resolvePluginsFromCatalog()`、`resolveTrackedPlugin()` 正常加载，不会因为 source 层存在性校验被误判为坏 bundle；
  - 渲染后的 `.mcp.json` 顶层 `mcpServers` 非对象或缺失时，bundle / install 主链路直接失败；
  - 渲染后的 `.app.json` 缺少 `apps.*.id` 时，bundle / install 主链路直接失败；
  - 坏的 Codex rules / hooks、Claude generated permissions 这类不经过 bundle manifest 的 repo-managed 产物，也会在 install 前 preflight 被共享 rendered validator 拦住；
  - 同一类 rendered contract 违规在 `validateBundleLayout()` 和 install preflight 中报出的错误语义保持一致；
  - `readPluginManifest()` 或等价共享入口在 permissions 模式不符合最终公共 contract 时直接失败；
  - Claude adapter / settings 相关断言固定 `settings.permissions` 与 `settings.awGenerated.permissions` 中写入的是 Claude 原生可消费的 tool-scoped 规则，而不是裸 `git status` / `git diff`；
  - 含 `agentOverrides` 的 instructions / permissions / hooks / agents，在 Claude / Codex 安装后分别只看到各自的生效条目。
- 更新 CLI 集成测试中 `.codex/hooks.json` 的断言，从 `commands` 改为 `hooks.<Event>[]`。
- 补齐状态与回滚回归：
  - `agentOverrides.<platform> = null` 时，ledger `capabilitySnapshot` 与平台生效 entries 保持一致。
  - Claude / Codex `status()` 的 `catalogCompatibility`、`repoManagedSessionState` 和 capability 相关断言只反映目标平台真实生效条目。
  - 两个插件共享 `.codex/hooks.json` 时，只移除其中一个插件的 hook group / handlers，未受影响的插件仍保持 `visible`，被删掉的那个不能继续报 `visible`，并要出现对应 drift warning。
  - `status()` 的 hooks 状态不再由共享 hooks 文件“是否存在”单独驱动。
  - current catalog 缺失时，historical fallback 不会为被平台排除的 instruction / permission / hook / agent 再造占位产物。
  - current catalog 缺失后，historical fallback + tracked local bundle 仍能走通 uninstall / rebuild hooks 路径。
  - `CodexAdapter.uninstallExtensions()` 基于新 hooks tracking 结构覆盖扣减与重建两条路径。
  - 保留“tracked plugin 从 current catalog 消失后剩余 hooks 仍然保住”和 historical fallback 两条现有 CLI 集成回归。
  - 覆盖卸载失败后的 pre-uninstall snapshot 恢复，避免新 tracking 结构破坏回滚。
  - 为 `mergeGeneratedArtifacts()` 或等价共享逻辑补单测，确认移除 `hookCommands` 后仍能按新 hooks tracking 载荷稳定去重。
- 补一组漂移防护 fixture：
  - Claude hooks fixture 使用 `PreToolUse` / `SessionStart` 这类原生事件名。
  - Claude permissions fixture 使用 `Bash(...)` 这类原生 rule 形状。
  - Codex hooks fixture 使用 `PermissionRequest` 或公共层选定的事件映射。
  - Codex rules fixture 使用 `prefix_rule`。
  - `.mcp.json` fixture 覆盖模板 / 非模板两种输入，以及 rendered 顶层结构校验。
  - `.app.json` fixture 使用 `apps.*.id`。
  - `agentOverrides` fixture 覆盖 `null` 排除和对象覆盖两种情况。
- 同步更新 `plugins/git-commit/`、`packages/cli/tests/fixtures/repo-template/` 和作者工具参考文档，符合 `docs/testing.md` 的 contract 变更要求。
- 补一条轻量文档漂移断言：
  - `docs/plugin-installation.md` 不再出现 `.codex/permissions.json`、`.codex/agents.json` 这类旧产物术语；
  - `docs/coding-conventions.md` 中 `HookEvent` / hooks artifact 的关键术语与第 1 步最终决策保持一致。
- 补作者工具回归：
  - `init_plugin.js --with-apps` 生成的插件能通过计划定义的新主链路校验；
  - `validate_plugin.js` 覆盖模板 / 非模板 `.mcp.json` / `.app.json` 两类行为。
  - 显式构造 `packages/cli/dist` 不存在的场景，断言 `validate_plugin.js` 会给出“仅为轻量预检”的清晰提示，而不是把 fallback 结果表述成完整 contract 通过；
  - 已构建 CLI 的场景继续覆盖新 contract 的权威拒绝行为，确保旧 `event: "command"`、旧 hook `description`、旧 `"git *"` 等输入不会只在 fallback 外才被发现；
  - 已构建 CLI 时，`validate_plugin.js` 对“存在默认 `.app.json` / `.mcp.json` 但 manifest 未声明”的输入，与 CLI source 主链路报出同类错误；
  - 已构建 CLI 时，命中 `buildConfig.templates` 的 `.mcp.json` / `.app.json` 即使 raw source 不是最终可直接 `JSON.parse` 的 JSON，`validate_plugin.js` 也不会误报 source-level JSON 错；
  - 构造一个只违反作者工具附加检查、但不违反共享 source contract 的样例，例如 `SKILL.md` 缺 frontmatter 或仍带 TODO；断言 `validate_plugin.js` built 模式会失败，但失败归因属于作者工具附加检查，而不是 source contract 漂移；
  - 构造一个共享 source contract 违规样例，例如默认 `.app.json` / `.mcp.json` 未声明、非法 hook event、或被公共层拒绝的 permissions 模式；断言 `validate_plugin.js` built 模式与 CLI source 主链路报出同类错误；
  - 同一份输入在 `validate_plugin.js` built 模式与 CLI source 主链路上的 accept / reject 一致性，只对共享 source contract 违规建立断言，不把作者工具私有附加检查也硬绑到 CLI 主链路一致性上；
  - `pnpm build` / `pnpm test:smoke:build` 覆盖 `.mcp.json` / `.app.json` 的 JSON 模板资产与 scaffold `--with-apps` 场景，并通过编译后的 `validateBundleLayout()` 或 `resolveEmbeddedPluginsRoot()` 把 `plugins-dist` 当成真正可加载的 runtime bundle 来验。
- 补 bundle-root 级失败用例：
  - rendered `.mcp.json` / `.app.json`、hooks 或 permissions artifact 语义不合法时，`validateBundleLayout()` 会拒绝该 bundle；
  - `pnpm test:smoke:build` 不再只检查文件存在，而是能拦住 embedded bundle contract 已坏但文件仍齐全的情况。
- 不添加旧 hooks artifact 兼容测试；测试只覆盖新 contract 和当前生成逻辑。

### 7. 验证命令

完成实现后至少运行：

```bash
pnpm test:unit
pnpm test:integration
pnpm build
pnpm test:smoke:build
```

若进一步改到 tarball 打包清单，再补跑：

```bash
pnpm test:smoke:pack
```

## 建议提交顺序

1. 先收口 `command` contract，并同步改 docs、样例插件和测试期望，让边界与失败点清楚暴露。
2. 再抽出平台生效视图，让 bundle / install / validation 三条路径共用同一份解析结果。
3. 然后修 hooks / permissions / apps 生成与主链路校验。
4. 最后收敛 tracking / uninstall / upgrade 的新结构处理，并跑通 integration / build。

这样每一步都能独立 review，避免把 `command` 决策、平台差异解析、格式改造和状态管理混成一团。
