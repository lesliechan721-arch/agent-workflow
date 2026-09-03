---
name: publish-aw-catalog
description: >-
  当用户清晰要求把一个 AW Catalog 发布到明确的 Workspace root、Git remote 和 branch 时使用。先生成 publication plan、展示稳定身份并取得该 planDigest 的一次授权，再 apply；普通维护、build、验证、development activation 或只读 Review 不使用。
compatibility: 需要 Node.js 22+、可用的 aw CLI，以及合法 Catalog Workspace。
user-invocable: true
metadata:
  short-description: 对 planDigest 取得授权后发布 AW Catalog
---

# Publish AW Catalog

这是唯一拥有远端 Catalog publication 的 Skill。最初的发布请求允许生成 plan，但不授权 apply。

## Runtime gate

在首次 AW 命令前，从平台提供的本 Skill 实际根取得 `<skill-root>`：使用 Skill locator 或当前加载的 `SKILL.md` 所在根，绝不从 cwd 猜测。随后运行：

```bash
aw self check --from <skill-root> --json
```

找不到 `aw` 或 `aw self check` 命令时立即停止，并精确报告 `missing: aw` 或 `missing: aw self check`。若 JSON 的 `ok` 为 `false`，立即停止并逐项报告 `missingCapabilities`；不添加 `--require`、不维护 Skill 内 capability 列表，也不固定 executable。

## 工作流

1. 要求用户明确提供 Workspace root、remote 和 branch。任一项缺失时停止并请求该值；不得从 cwd、Git current branch、remote defaults、旧 receipt 或其它 Skill 推断。不要用 `request_user_input` 收集这些目标值。
2. 告知用户 plan 会读取远端 refs，并从已提交 source HEAD 执行插件 validator/build 和 Catalog build。随后运行：

   ```bash
   aw catalog publish plan --workspace-root <user.workspaceRoot> \
     --remote <user.remote> --branch <user.branch> --json
   ```

3. plan 失败时报告错误并停止；不请求授权，不运行 apply。plan 成功后，从同一 receipt 展示：绝对 `workspaceRoot`、`workspaceIdentity`、`sourceHead`、`catalogVersion`、`channel`、`pluginCount`、`remote`、安全的 `fetchUrl` 和 `pushUrl`、`descriptor.remote.identityDigest`、`branch`、`parent`、`tag`、`expectedCommit`、`snapshotDigest`、`state` 和完整 `planDigest`。说明 `planDigest` 授权 canonical `{ descriptor, expectedCommit }`，因此 `expectedCommit` 是授权身份的一部分。任一授权身份字段缺失时停止，不猜测或重算。
4. 只调用一次 `request_user_input`，问题只授权已展示的完整 `planDigest` 及其 canonical `{ descriptor, expectedCommit }`，并提供“授权”和“拒绝”选择。最初发布请求、不同 plan 的授权或只授权 remote 都不能代替该选择。用户拒绝时停止，不运行 apply。
5. 用户授权后运行：

   ```bash
   aw catalog publish apply --workspace-root <plan.workspaceRoot> \
     --remote <plan.remote> --branch <plan.branch> \
     --expected-plan-digest <plan.planDigest> --yes --json
   ```

6. 通常把 plan receipt 的 `remote` 和 `branch` 回传给 apply。恢复时可使用另一 remote alias，但该 alias 必须解析到 plan 中的 `descriptor.remote.identityDigest`；`branch` 必须与 plan 完全相同。核对 apply receipt 的 `workspaceRoot`、`workspaceIdentity`、plan-bound `sourceHead`、remote identity digest、`branch`、`expectedCommit`、`snapshotDigest` 和 `planDigest` 与已授权 plan 一致。成功时报告 `state`、`commit`、`reconciliation` 和任何 cleanup warning。

## 恢复与停止边界

- apply 用授权 digest 在 `.aw/publish/<version>/journal.json` 中唯一定位 schema v2 journal；不从当前 metadata version 推断 journal，也不要求用户提供 version。
- `prepared` 或 `uncertain` 的同一 journal plan 可以使用相同 `planDigest` 对账或重试 apply，即使当前 source HEAD、dirty state 或 metadata version 已改变；不因这些当前 source 变化要求新 plan 或自动提高版本。
- apply 仍必须重新核验 Workspace identity、所选 remote 的 identity digest、branch、pending repository integrity 和 remote refs。remote alias 名称可以变化，remote identity 和 branch 不可变化。
- digest 不唯一、schema v2 journal 缺失或损坏、授权 digest 不匹配、Workspace/remote identity 或 branch 改变、pending repository 缺失或损坏、远端 ref 冲突，或 immutable tag 已占用时，停止并按 CLI 指令恢复或提高 Catalog version。
- `published` journal 和已核验 remote refs 优先表示发布成功；此后的 repository cleanup warning 不使 apply 失败。报告该 warning，不自行删除 residue。
- plan/apply 的结果不确定时，只按 CLI 指令用同一 `planDigest` 重试 apply；不删除或改写 publication journal/repository。
- 不复制 CLI 的 journal、Git ref、tag 或 recovery 算法；只消费 plan/apply 的当前公开 receipt。
