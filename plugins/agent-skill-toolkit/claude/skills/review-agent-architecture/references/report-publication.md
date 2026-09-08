# Review Report Publication

只在用户明确要求归档本次顶层 Review 时读取。默认在聊天中交付；leaf Reviewer 只返回材料，不独立归档。归档已有报告不改变 findings、运行 Eval、生成 Release Check 或更新 production README。

## AW 归档入口

在提供 AW 归档能力的环境中，先读取 `aw review publish --help`，使用当前公开参数。普通人读报告无需转换成 JSON。已有独立 `release-check.json` 只是可选附件，不由归档动作推导 readiness。

`aw-plugin` 归档会为目标身份构建 production bundle，可能执行插件 build/renderer。运行前说明这一范围并核对当前授权；若用户要求全程不执行被审代码，则只交付报告文件，不调用该归档入口。其它 kind 按各自公开合同取得目标摘要。

| 目标 | Kind | Target | Scope |
| --- | --- | --- | --- |
| 单 Skill | `skill` | Skill root 或 `plugin/skill` id | 不使用 |
| 通用 workflow | `workflow` | scope id | 必须提供 `scope.json` |
| 单 AW Plugin | `aw-plugin` | plugin root 或 plugin id | 不使用 |
| 跨 AW Plugin workflow | `aw-workflow` | scope id | 必须提供 `scope.json` |

Catalog composition 和 portfolio 没有对应 archive kind；将人读报告写到用户指定目录，不伪装成 workflow，也不新增 kind。其它环境使用其实际归档能力或用户指定文件。

```bash
aw review publish --kind <kind> --target <target> --report <report.md>
```

按已有材料附加 `--check <kind=path>`、`--evidence <kind=path>`、`--release-check` 或可选 `--result`；workflow 还需 `--scope <scope.json>`。修订已有记录时创建新的不可变记录，用 `--supersedes <review-id>` 指向同 kind、同 target id 的旧记录。不要覆盖不同身份的旧报告。

## Workflow scope

只为已明确边界的 workflow 创建 scope。对每个 component 运行 `aw review digest <component-path> --json`，原样使用返回的 `path` 和 `digest`；失败时停止，不猜测摘要。

`scope.json` 使用现有合同：`schemaVersion: 1`、与归档 kind 相同的 `kind`、scope `id`、`userOutcome`、`entry`、非空 `components`、非空 `representativePaths`、`externalDependencies` 和 `excluded`。每个 component 包含 `kind`、`id`、`path` 和 `digest`。该文件供 AW archive 消费，不是通用 Skill 调用合同。

使用返回的 record 路径或 id 运行 `aw review verify`。只有用户要查询历史时才使用 `aw review list` 或 `aw review show`。
