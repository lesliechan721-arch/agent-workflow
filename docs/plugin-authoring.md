# Plugin Authoring

## Manifest Contract

插件源码 manifest 以 `plugins/<name>/.agents-plugin/plugin.json` 为唯一真值，`plugins/marketplace-source.json` 汇总 marketplace 元数据。

- `extensions.*`（`instructions`/`permissions`/公共 `hooks`/`nativeHooks`/`agents`）用于声明派生能力，不新增顶层 `claude` block
- 路径字段（`skills`、`mcpServers`、`apps`）必须以 `./` 开头，单个字符串形式
- `skillTriggers` 只声明哪些 skill 允许用户在安装时用 `--skill-trigger` 覆盖触发策略；省略时全部 skill 都不可覆盖
- `buildConfig` 控制 build 阶段 bundle 生成，不是平台私有字段出口
- 不手改 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`（这两个是 bundle 产物）
- 详细约定见 `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`

创建或维护插件时，优先从 `.agents/skills/create-agent-workflows-plugin/SKILL.md` 的场景入口开始读。

## Hook Contract

- `extensions.hooks` 只放跨平台公共事件：`before_tool`、`after_tool`、`session_start`。
- 公共 `session_start` 只表示 `startup / resume / clear`。Claude compact 场景请写 `extensions.nativeHooks.claude[]`，事件为 `SessionStart`，matcher 为 `compact`。
- `extensions.nativeHooks.<agent>` 用平台原生事件名，例如 Claude `Notification`、`SessionEnd`，Codex `UserPromptSubmit`、`Stop`。
- matcherless 原生事件不要写 `matcher`；`agentOverrides` 只用于公共 extension 条目，不用于 `nativeHooks`。
- 公共 `session_stop` 已移除；Claude `Stop` / `SessionEnd`、Codex `Stop` 都应写到对应平台的 `nativeHooks`。

## Skill Trigger Rules（两平台不共享开关）

- **Codex 自动触发**：取决于 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`
- **Codex 显式触发**：用 `$skill-name` 或结构化 skill mention
- **Claude 用户手动触发**：取决于 `SKILL.md` frontmatter 的 `user-invocable`
- **Claude 模型自动调用**：取决于 `SKILL.md` frontmatter 的 `disable-model-invocation`

`.agents-plugin/plugin.json` 里的 `skillTriggers` 不定义默认触发策略，只定义安装时是否允许用户覆盖。例如：

```json
{
  "skills": "./skills",
  "skillTriggers": {
    "commit": {
      "allowInstallOverride": true
    }
  }
}
```

`allowInstallOverride: true` 表示 `aw install --skill-trigger manual|auto|default` 可以改写本地 marketplace 里的运行时 skill 文件；默认值仍由源码中的 `SKILL.md` 和 `agents/openai.yaml` 决定。`allowInstallOverride: false` 或省略 `skillTriggers` 都会保持保守策略，不允许安装命令覆盖该 skill。

详见 `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md`。

## Scope Semantics

- **Claude**：`project` 和 `user` scope 都完整支持，settings 层别区分
- **Codex**：native plugin enabled 仍仅 user scope；`project` scope 只代表 repo-managed artifacts（`.agents/`、`.claude/`、`.codex/` 下的 managed 文件），不代表 native plugin 已在 project 级别启用
