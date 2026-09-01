# publish-aw-catalog

在用户清晰要求发布 Catalog，并明确给出 Workspace root、remote 和 branch 时使用。普通维护、build、验证、development activation 和只读 Review 不会触发远端写入。

本 Skill 先运行 `catalog publish plan`。plan 会读取远端 refs，并从已提交 source HEAD 执行插件 validator/build 和 Catalog build。它展示 Workspace identity、source HEAD、安全 remote identity、branch、parent、tag、snapshot digest、Catalog 展示信息和完整 `planDigest`。用户只授权该 `planDigest` 后，Skill 才运行 `catalog publish apply --expected-plan-digest ... --yes`。

用户拒绝或 plan 失败时没有 apply。`prepared` 或 `uncertain` 的同一 plan 可以用相同 digest 对账或重试；不同 plan、损坏的 pending state、ref 冲突或 immutable tag 占用要求提高 Catalog version。
