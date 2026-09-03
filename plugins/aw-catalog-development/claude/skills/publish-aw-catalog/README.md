# publish-aw-catalog

在用户清晰要求发布 Catalog，并明确给出 Workspace root、remote 和 branch 时使用。普通维护、build、验证、development activation 和只读 Review 不会触发远端写入。

本 Skill 先运行 `catalog publish plan`。plan 会读取远端 refs，并从已提交 source HEAD 执行插件 validator/build 和 Catalog build。它展示 Workspace identity、source HEAD、安全 remote identity、branch、parent、tag、`expectedCommit`、snapshot digest、Catalog 展示信息和完整 `planDigest`。`planDigest` 授权 canonical `{ descriptor, expectedCommit }`。用户只授权该 digest 后，Skill 才运行 `catalog publish apply --expected-plan-digest ... --yes`。

用户拒绝或 plan 失败时没有 apply。apply 用 digest 在 schema v2 `.aw/publish/<version>/journal.json` 中唯一定位 plan。`prepared` 或 `uncertain` 的同一 plan 可以在当前 source HEAD、dirty state 或 metadata version 改变后使用相同 digest 对账或重试；apply 仍重新核验 Workspace identity、remote identity、branch、pending repository 和 remote refs。remote alias 可改名，但 identity 和 branch 不可改变。`published` journal 成功优先，repository cleanup warning 不使 apply 失败。
