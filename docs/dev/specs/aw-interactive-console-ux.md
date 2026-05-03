# `aw` 交互控制台与安装输出重设计需求 Spec

日期：2026-04-30

## 背景

上一轮 `codex-install-native-interactive-ux` 已经把交互式安装、候选发现、默认输出、debug 日志和 `status` 面板都落到了代码里，但真实体验仍然失败：

- 交互只能输入编号，不能用方向键移动、回车确认。
- `install` 成功后仍会混入用户不需要理解的状态信息，例如 lifecycle snapshot、marketplace、账本、`degraded`、`healthSource`、`config=no-schema`、`scripts=not_declared`。
- 状态输出把内部模型直接暴露给用户，例如 `Codex / git-commit / user scope`、`ledger`、`repo-managed`、`skill trigger drift`。
- `install` / `uninstall` / `upgrade` / `config` 子命令都可能进入 prompt，导致脚本化入口和交互入口混在一起。

本 spec 重新定义交互入口和默认输出：`aw` 主命令是唯一交互入口；子命令只服务非交互脚本调用；默认人类输出只展示用户能理解、能行动的信息。

## 已确认决策

- 直接运行 `aw` 进入插件控制台。
- 插件控制台使用方向键交互，依赖指定为 `@inquirer/prompts`。
- 子命令删除所有交互模式。旧的 `-i/--interactive`、`--no-interactive` 和纯交互命令 `config configure` 直接移除。
- 首屏展示全部插件的简化汇总状态，不在列表中展开 Codex/Claude、user/project 的完整矩阵。
- 第一版不做批量操作，一次只进入一个插件详情页。
- 必填配置、安装位置、平台和 skill 触发等选择在主入口 TUI 里用向导完成。
- TUI 里只展示友好详情，不提供内部诊断页；内部诊断继续由 `aw status --verbose`、`--debug` 和 JSON 输出承担。
- 非 TTY 中直接运行 `aw` 返回明确错误和可复制的非交互命令示例。
- `aw status` 默认仍是给人看的友好摘要，但不再输出内部术语；诊断字段只进 `--verbose` / `--json` / debug log。
- 脚本化子命令补齐 JSON receipt。所有命令的 `--json` stdout 必须是纯 JSON。

## 当前实现探索结论

### CLI 入口

- [packages/cli/src/index.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/index.ts) 当前只注册子命令，直接运行 `aw` 会显示 help 并返回非 0。
- `install`、`uninstall`、`upgrade` 的参数是 `[plugins...]`，缺插件名时会在 CLI runtime 里尝试进入交互计划。
- `config configure` 和 `config reset` 仍会调用 prompt；`config configure` 本身没有非交互语义。
- `init`、`install`、`uninstall`、`upgrade` 还没有 JSON receipt；`status` 和多数 `config` 子命令已有 JSON。

### 交互实现

- [packages/cli/src/commands/runtime.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/runtime.ts) 的 `createReadlinePrompt()` 基于 `readline/promises`，`select` / `multiSelect` 会打印编号列表，要求用户输入编号或逗号分隔的编号。
- [packages/cli/src/commands/interactive.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/interactive.ts) 已有 install/uninstall/upgrade 的候选构建和分组 dispatch，但它服务子命令 prompt，不适合作为新的主入口控制台直接复用。
- 当前 prompt 接口包括 `selectScope`、`selectPlatform`、`selectPlugins`、`selectUpgradeMode`、`selectSkillTrigger`、`configurePlugin`。新设计可以保留其中的测试注入思路，但默认实现需要换成 TUI 控制器。

### 状态与候选发现

- [packages/cli/src/commands/discovery.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/discovery.ts) 已能从 current catalog、AW 安装记录、tracking manifest、Codex native config、Claude settings/runtime evidence 合并候选。
- [packages/cli/src/commands/status.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/status.ts) 已有状态矩阵和 JSON 结构，但默认文案仍把矩阵细节直接展开，包含 `healthSource`、`config`、`scripts`、证据来源等内部字段。
- 这些能力应保留为内部数据源，再投影成用户友好的 `PluginConsoleItem` / `PluginFriendlyStatus`，避免 UI 和默认输出直接暴露底层字段。

### 输出层

- `writeCommandReceipt()` 会打印 marketplace、插件目录、native 注册、repo-managed artifacts 和 `aw status` 下一步。对用户来说信息密度过高。
- `formatWarnings()` 会把 warning 源格式化成 `Codex / git-commit / user scope`，并把部分内部词翻译成中文，但仍然保留“账本”“scope”等概念。
- `filterPostCommandDriftWarnings()` 只做了有限抑制，status 默认输出仍会暴露大量诊断细节。

### 依赖现状

- `packages/cli/package.json` 目前只有 `chalk`、`commander`、`fs-extra`、`toml-eslint-parser`、`yaml` 等依赖，没有方向键 prompt/TUI 库。
- 本机 `npm view` 被 registry 策略返回 403，实施前需要用项目实际 registry 验证 `@inquirer/prompts` 的可安装版本。spec 仍按已确认决策指定该依赖。

## 产品目标

1. 用户直接运行 `aw` 就能看到所有插件和状态，不需要先记住 `install/status/upgrade` 等子命令。
2. 交互过程支持方向键、回车、返回、确认，不再要求输入编号。
3. 默认输出不出现内部实现词汇，用户只看到“发生了什么”“现在能不能用”“下一步该做什么”。
4. 子命令成为稳定的非交互 API，适合脚本、CI 和文档复制。
5. JSON receipt 覆盖所有子命令，stdout 可直接解析。
6. 仍保留现有 discovery、install、upgrade、uninstall、config、status 的核心安全语义，包括 project scope 安全预检、外部 ownership 检查、rollback、debug log 和只读 status 边界。

## 非目标

- 第一版不做批量安装、批量卸载或多选批量升级。
- TUI 不展示完整诊断矩阵，不替代 `status --verbose`。
- 不改变插件 manifest/schema/scope 的底层语义。
- 不重新设计 native marketplace、ledger、tracking 的持久化格式。
- 不在本轮引入远程 marketplace 浏览能力。

## 术语与文案规则

默认人类输出和 TUI 中禁止出现以下内部术语，除非用户显式进入 `--verbose`、`--debug` 或 JSON：

- `ledger`、`账本`
- `degraded`
- `healthSource`
- `installSnapshot`、`currentCatalog`、`historical`
- `repo-managed`
- `tracking`
- `scope`
- `config=no-schema`、`scripts=not_declared`
- `skill trigger drift`

推荐替代表达：

- `user scope` -> `个人`
- `project scope` -> `当前项目`
- `Codex / git-commit / user scope` -> `git-commit 已安装到 Codex（个人）`
- `degraded ledger` -> `安装记录需要修复`
- `repo-managed artifacts` -> `已写入项目文件`
- `external marketplace ownership` -> `同名插件已由其它来源管理`
- `skill trigger` -> 仅在设置项里展示为 `触发方式`

默认输出的格式必须优先使用完整句子，避免像日志、patch note 或内部状态 dump。

## 主入口 TUI

### 启动行为

TTY 环境运行：

```bash
aw
```

进入插件控制台。

非 TTY、CI 或 stdin/stdout 不支持交互时，返回非 0，并输出：

- `aw` 主入口需要交互终端。
- 可复制命令示例，例如 `aw status`、`aw install <plugin> --platform codex --scope user`。
- 如果用户需要机器可读输出，提示使用 `--json`。

### 首屏

首屏展示插件列表，来源为 current catalog + 已安装或可发现插件。列表每一行至少包含：

- 插件名
- 简短描述
- 友好状态：`未安装`、`已安装`、`可升级`、`需要处理`、`部分可用`、`由其它来源管理`
- 简化位置摘要，例如 `Codex（个人）`、`Claude Code（当前项目）`、`多个位置`

首屏可以包含搜索或过滤，但第一版不要求高级筛选。若插件数量超过屏幕高度，必须支持方向键滚动。

### 插件详情页

从首屏选择插件后进入详情页。详情页展示：

- 插件名、版本、描述
- 当前友好状态
- 安装位置摘要
- 可执行动作

动作按当前状态动态展示：

- 未安装：`安装`
- 已安装：`升级`、`配置`、`卸载`
- 可升级：`升级`、`配置`、`卸载`
- 需要处理：展示一条用户可理解的问题说明，并给出可执行修复动作
- 由其它来源管理：只展示说明和返回，不自动接管

详情页必须有 `返回`，破坏性操作必须二次确认。

### 安装向导

安装动作在 TUI 内完成必要选择：

- 平台：Codex、Claude Code，必要时可选两者，但第一版不做批量插件。
- 位置：个人、当前项目。
- 触发方式：只在插件确实需要且允许覆盖时出现；文案使用 `默认`、`手动`、`自动`。
- 必填配置：按 manifest config schema 生成表单。

如果某个组合不可安装，显示用户能理解的原因，例如：

- `这个插件不能安装到当前项目，请改为安装到个人位置。`
- `Codex 当前不可用，但此插件可以写入当前项目文件。`
- `同名插件已由其它来源管理，请先处理冲突。`

### 配置向导

配置表单使用 schema 信息生成：

- `string` / `file` / `directory` 用输入框。
- `number` 用输入框并校验范围。
- `boolean` 用确认开关。
- `enum` 用选择框。
- `sensitive` 值隐藏输入，已配置时只显示 `已配置`。

写入位置默认跟当前安装位置一致；如果插件尚未安装，默认写入 `个人`，但允许选择 `当前项目`。

### 完成反馈

TUI 动作完成后只显示简短结果：

- `git-commit 已安装到 Codex（个人）。`
- `git-commit 已升级。`
- `git-commit 已从当前项目移除。`
- `配置已保存。`

如果有需要用户处理的问题，用 `注意` 或 `下一步` 表达，不输出内部诊断字段。

## 子命令行为

### 删除交互入口

以下入口从 help、解析和文档中移除：

- `install -i/--interactive`
- `install --no-interactive`
- `uninstall -i/--interactive`
- `uninstall --no-interactive`
- `upgrade -i/--interactive`
- `upgrade --no-interactive`
- `config configure`
- `config reset -i/--interactive`
- `config reset --no-interactive`

旧命令直接变成 unknown option/unknown command，不再保留兼容报错。

### 非交互合同

- `aw install` 没有插件名时直接失败，提示运行 `aw` 进入交互控制台，或运行 `aw install <plugin>`。
- `aw uninstall` 没有插件名时直接失败，提示运行 `aw` 或 `aw uninstall <plugin>`。
- `aw upgrade` 没有插件名且没有 `--all` 时直接失败，提示运行 `aw` 或 `aw upgrade <plugin>` / `aw upgrade --all`。
- `config reset` 遇到已有配置时必须显式传 `--yes`，不再 prompt。
- 安装/升级遇到缺少必填配置时，子命令必须失败并给出 `aw config set ...` 或 `aw` 主入口的下一步，不再在子命令中补问。

### JSON receipt

所有子命令支持 `--json`。成功时 stdout 只能是一份 JSON；失败时 stderr 输出错误，人类 warning 不得混入 JSON stdout。

最小公共结构：

```json
{
  "ok": true,
  "command": "install",
  "warnings": [],
  "nextSteps": []
}
```

写命令还应包含：

- `plugins`
- `targets`：平台和位置使用稳定字段 `platform`、`scope`，这是 JSON API，可保留技术字段
- `actions`：安装、升级、卸载、配置写入等结构化结果
- `skipped`：升级跳过项
- `artifacts`：只包含稳定路径和 kind，不要求给人类阅读

`status --json` 保持现有矩阵结构可向后兼容，但可以新增 `friendlySummaries` 字段服务新 UI。不得破坏现有 JSON 可解析性。

### 默认人类输出

写命令默认输出要比当前 receipt 更短。示例：

```text
git-commit 已安装到 Codex（个人）。
下一步：运行 aw 查看和管理插件。
```

如果是当前项目安装：

```text
skills-mcp 已安装到 Codex（当前项目）。
已写入项目文件：.agents/skills、.codex/config.toml。
```

不再默认输出：

- `使用插件目录`
- `已复用本地 marketplace`
- `已确认 Codex marketplace 注册`
- `已确认插件启用`
- `healthSource`
- `config`
- `scripts`
- 安装记录内部状态

这些信息可以进入 debug log、JSON 或 `--verbose`。

## `aw status` 友好摘要

默认 `aw status` 输出应回答三个问题：

1. 装了哪些插件？
2. 它们能不能用？
3. 用户下一步应该做什么？

推荐形态：

```text
插件状态
git-commit      已安装       Codex（个人）
skills-mcp      需要处理     Codex（当前项目）

下一步
- skills-mcp：当前项目配置不完整，运行 aw 打开控制台完成配置。
```

默认输出不展示每个 platform/scope 的底层状态点。用户传 `--verbose` 时，可以继续输出诊断矩阵，但应把它放在 `诊断信息` 小节，并接受内部术语。

## 内部设计要求

### 新增友好状态投影层

在 `commands/status.ts` / `commands/discovery.ts` 之上新增友好投影，不直接把 `StatusMatrixCell` 渲染给默认人类输出或 TUI。

建议结构：

```ts
interface PluginConsoleItem {
  pluginName: string;
  title: string;
  description?: string;
  version?: string;
  status: 'notInstalled' | 'installed' | 'upgradeAvailable' | 'needsAction' | 'partial' | 'external';
  statusLabel: string;
  locationSummary: string;
  actions: PluginConsoleAction[];
  blockingMessage?: string;
}
```

底层仍可保留 `StatusMatrixReport` 给 JSON、verbose 和测试使用。

### TUI 控制器

新增主入口控制器，例如 `commands/console.ts` 或 `commands/dashboard.ts`：

- 负责加载 console items。
- 负责调用 `@inquirer/prompts`。
- 负责把用户选择转换成现有非交互 command API 调用。
- 不在 adapter 层直接 prompt。
- 不绕过现有 install/uninstall/upgrade/config 的安全预检。

当前 [commands/interactive.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/packages/cli/src/commands/interactive.ts) 可以删除，或只保留测试辅助逻辑；CLI 子命令不再调用它。

### Prompt 抽象

保留可注入 prompt/TUI 适配层，保证测试不依赖真实终端。默认实现使用 `@inquirer/prompts`。

至少需要：

- 单选
- 确认
- 文本输入
- 密码/隐藏输入
- 可滚动列表
- 返回/取消语义

第一版不要求 checkbox 多选，因为不做批量。

### 输出分层

输出必须分成三层：

- 友好人类输出：默认 stdout/TUI。
- 诊断输出：`--verbose` 和 debug log。
- 机器输出：`--json`。

warning 需要有分类，默认只显示用户可行动的 warning。内部诊断 warning 进入 debug log 或 verbose，不再通过 `formatWarnings()` 直接泄露给默认输出。

## 测试验收

### TUI

- 注入 fake prompt 时，`runCli([])` 能进入插件控制台流程并完成安装。
- 非 TTY/CI 下 `runCli([])` 不挂起，返回清晰错误和示例。
- 首屏候选来自 current catalog + 已安装/可发现插件。
- 首屏同名插件跨平台/位置时只显示一个简化汇总项。
- 详情页动作会按状态变化，例如未安装只显示安装，已安装显示升级/配置/卸载。
- 安装向导能选择平台、位置、触发方式和必填配置。
- 破坏性卸载必须确认；取消后不写状态。

### 子命令

- `aw install --interactive`、`aw install --no-interactive` 返回 unknown option。
- `aw uninstall --interactive`、`aw upgrade --interactive` 返回 unknown option。
- `aw config configure` 返回 unknown command。
- `aw config reset <plugin>` 在需要确认时失败并提示 `--yes`，不会 prompt。
- `aw install`、`aw uninstall`、`aw upgrade` 缺少必要参数时失败并提示运行 `aw` 主入口。
- 子命令不会调用 prompt，即使 runtime 注入了 fake prompt。

### 输出

- 成功安装默认输出不包含 `marketplace`、`账本`、`degraded`、`healthSource`、`config=no-schema`、`scripts=not_declared`、`repo-managed`。
- `aw status` 默认输出不包含上述内部词。
- `aw status --verbose` 可以包含诊断字段。
- 所有 `--json` stdout 都能 `JSON.parse`，stderr 不影响 stdout。
- `install/uninstall/upgrade/init/config/status --json` 都有稳定 `ok`、`command` 字段。

### 回归安全

- Codex project scope 安装仍不要求 native Codex runner。
- Codex user scope 和 Claude native runtime 仍按需同步 `~/.aw`。
- 外部 marketplace ownership 仍会阻断危险写入。
- required config 在子命令中失败，在 TUI 中走向导。
- rollback/degraded 写入语义保留，但默认文案不暴露内部状态名。
- `status` 仍保持只读，不为读取状态创建、同步或修复 `~/.aw`。

## 文档更新要求

实现本 spec 时必须同步更新：

- `README.md`
- `docs/plugin-installation.md`
- `docs/architecture.md`
- `docs/testing.md`

需要删除旧交互模式说明，新增：

- `aw` 主入口控制台说明
- 子命令非交互合同
- JSON receipt 合同
- 默认输出与 verbose/debug/json 的边界

按仓库维护原则，如果插件作者技能、模板或示例中提到 `aw config configure`、`--interactive`、`--no-interactive` 或旧安装体验，也必须同步检查 `.agents/skills/create-agent-workflows-plugin/` 并更新。

## 实施风险

- 这是 breaking change：旧的交互 flag 和 `config configure` 会直接消失。
- 新依赖需要确认能通过项目实际 registry 安装、打包和 smoke test。
- TUI 必须有可注入抽象，否则测试会变脆。
- 默认输出变短后，诊断信息必须能在 `--verbose`、`--debug` 和 JSON 中找回。
- JSON receipt 一旦发布就要稳定，字段命名需要在实现前再做一次 schema review。
