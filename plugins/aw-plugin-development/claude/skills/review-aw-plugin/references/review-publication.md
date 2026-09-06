# Review Publication

只在用户明确要求归档 Quality Review，且当前 Skill 是本次请求的顶层 Reviewer 时读取。作为其它 Reviewer 的子级运行时，只返回报告、结构化结果、checks 和 evidence；不自行发布记录。默认只归档用户请求的顶层目标；只有用户明确要求多个归档目标时，才为 leaf 创建独立记录。

## 稳定边界

- Publication 只归档已有材料，不改变 findings、design 或 complexity，不运行 Eval 或 Release Check，也不更新 README。
- Quality Review 不拥有 readiness 或 Eval 执行事实。已有的独立 `release-check.json` 只能作为附件。
- 先运行 `aw review publish --help`，以当前公开 CLI 参数为准。
- 修订已有记录时创建新的不可变记录，并用 `--supersedes <review-id>` 指向同 kind、同 target id 的旧记录。

## 目标映射

| 顶层 Reviewer | Kind | Target | Scope |
| --- | --- | --- | --- |
| `review-agent-skill` | `skill` | Skill root 或 `plugin/skill` id | 不使用 |
| `review-agent-workflow` | `workflow` | scope id | 必须提供 `scope.json` |
| `review-aw-plugin` | `aw-plugin` | plugin root 或 plugin id | 不使用 |
| `review-aw-workflow` | `aw-workflow` | scope id | 必须提供 `scope.json` |

使用 `aw review publish --kind <kind> --target <target> --report <report.md>` 发布。按已有材料附加 `--result`、`--check <kind=path>`、`--evidence <kind=path>`、`--release-check` 或 `--supersedes`；workflow 类目标还要传 `--scope <scope.json>`。

## Workflow scope

只为 admitted workflow 创建 scope。先对每个 component 运行：

```bash
aw review digest <component-path> --json
```

把命令返回的 `path` 和 `digest` 原样写入 component。任一 digest 失败时停止，不自行计算或猜测。`scope.json` 包含 `schemaVersion: 1`、与发布 kind 相同的 `kind`、scope `id`、`userOutcome`、`entry`、非空 `components`、非空 `representativePaths`、`externalDependencies` 和 `excluded`。每个 component 包含 `kind`、`id`、`path` 和 `digest`。

发布后使用命令返回的 record 路径或 id 运行 `aw review verify`。只有用户需要查询历史记录时，才运行 `aw review list` 或 `aw review show`。
