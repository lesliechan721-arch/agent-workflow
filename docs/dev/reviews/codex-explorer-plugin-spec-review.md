# `codex-explorer-plugin-spec.md` 复审报告

审查对象：`docs/dev/sepcs/codex-explorer-plugin-spec.md`  
审查时间：2026-05-02

## Findings

### 1. `effective config` 的定义仍和 user-scope-only 策略冲突

严重度：中

这版 spec 已经明确 `codex-explore` 首版只支持 Codex user scope 安装，但配置语义这里还留着一处真值冲突。

spec 一方面把 renderer 输入写成 “effective config”，并多次要求按它来渲染 artifact：

- `docs/dev/sepcs/codex-explorer-plugin-spec.md:56`
- `docs/dev/sepcs/codex-explorer-plugin-spec.md:217`
- `docs/dev/sepcs/codex-explorer-plugin-spec.md:223`
- `docs/dev/sepcs/codex-explorer-plugin-spec.md:616`
- `docs/dev/sepcs/codex-explorer-plugin-spec.md:620`

另一方面，同一份 spec 又明确：

- user scope artifact 只应使用 `schema default + user config`
- `codex-explore` 首版实际运行时只用 user config
- project config 可以保存，但不会触发本插件 project artifact refresh
- 插件本身也不支持 project scope 安装

相关位置：

- `docs/dev/sepcs/codex-explorer-plugin-spec.md:218-220`
- `docs/dev/sepcs/codex-explorer-plugin-spec.md:483-489`
- `docs/dev/sepcs/codex-explorer-plugin-spec.md:605`

当前仓库里，“effective config” 的既有真值并不是这个含义。文档和实现都把它定义成 `default < user < project`：

- `docs/plugin-authoring.md:40-46`
- `docs/architecture.md:66-69`
- `packages/cli/src/utils/plugin-config.ts:405-507`

而且当前 `aw config set/configure/unset` 写完后回显的也是这套合并结果：

- `packages/cli/src/index.ts:855-885`
- `packages/cli/src/index.ts:911-985`
- `packages/cli/src/index.ts:1005-1039`

这会带来一个很具体的歧义：

- 如果实现继续沿用当前 `resolveEffectivePluginConfig()`，那 user scope install/refresh 会错误吃到 project config，和 spec 的 scope 策略冲突。
- 如果实现按 spec 忽略 project config，那 `aw config get/list`、`configure` 回显和实际写进 `~/.codex` 的 artifact 又会对不上，用户会看到“配置生效了”，但运行时其实没用。

建议二选一写进 spec：

- 方案 A：对 `codex-explore` 这类只允许 user scope 安装的插件，直接禁止 `project` scope config 写入/读取。
- 方案 B：保留 project config store，但不要再把 renderer 输入叫做 “effective config”，改成显式的 `render config` 或 `scope-resolved config`，并要求 `aw config get/list`、status 或相关提示明确说明这类插件当前只应用 user config。

在这个点收口之前，不建议直接开做实现，否则 config helper、config 命令回显和 artifact refresh 很容易各自拿一套不同的真值。

## 已解决项回看

上一轮报告里的主要问题，这版已经基本收住：

- 默认轻量 instruction 已明确降级成建议性入口，不再暗示它能突破 `spawn_agent` 的授权规则。
- `codex.agentRole` 的路径真值已经收回到 AW core，renderer 不再返回 `config_file`。
- `codex-explore` 已明确拒绝 project scope 安装，规避了 skill 全局暴露、role 仅仓库本地的 scope 不一致。
- role 冲突检测已经前置到所有副作用之前，不再留半安装窗口。
- refresh、drift 和回滚规则已经写到足够可实现的粒度。
- 当前还在开发阶段，不要求兼容历史安装迁移，这一点也已经在 spec 里说清楚了。

## 可落地性判断

除上面这一个配置语义问题外，我没有再看到新的结构性阻塞点。

我的判断是：

- 需求方向是合理的。
- 在当前基线下可以落地。
- 处理完 `effective config` / `user-only render config` 这处真值冲突后，这份 spec 就可以进入实现拆分。
