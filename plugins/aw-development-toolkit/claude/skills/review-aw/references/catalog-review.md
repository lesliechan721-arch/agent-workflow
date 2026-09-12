# Catalog Review

用 `aw review inspect <workspace-root> --view review --json` 取得相关 source 路径、Skill 视图和已有 snapshot 的精简状态；按 sources 指向的 manifest/metadata 审核 inventory 与依赖：

- current：valid 且 source identity 匹配；
- stale：snapshot 可验证但不能代表当前 source；
- absent：没有证据，不推断 build 通过；
- invalid：报告，不修复。

检查 identity、metadata、inventory、dependency graph、version 和 snapshot evidence。此只读取证阶段不运行插件代码、build、source mutation 或网络。

当前请求涉及完整 leaf 时，按本 Skill 的准备路径取得各插件所需 profile，再分别审核。Catalog identity/metadata 的只读设计审查与叶子产物覆盖分别报告。
