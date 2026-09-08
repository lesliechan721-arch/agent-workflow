# Catalog Review

用 `aw review inspect <workspace-root> --json` 读取当前 inventory 并验证已有 snapshot：

- current：valid 且 source identity 匹配；
- stale：snapshot 可验证但不能代表当前 source；
- absent：没有证据，不推断 build 通过；
- invalid：报告，不修复。

检查 identity、metadata、inventory、dependency graph、version 和 snapshot evidence。不运行插件代码、build、source mutation 或网络。
