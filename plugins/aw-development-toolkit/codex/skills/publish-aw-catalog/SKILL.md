---
name: publish-aw-catalog
description: >-
  仅当用户显式调用本宏并要求发布一个 AW Catalog 时使用。由 CLI 解析 Workspace、Git remote 和 branch，生成 publication plan、展示稳定身份并取得该 planDigest 的一次授权，再 apply。普通开发、验证、Review 或隐式自然语言发布请求不自动加载。
compatibility: 需要 Node.js 22+、PATH 中可用的 aw CLI 和合法 AW Catalog Workspace。
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: 手动授权并发布 AW Catalog
---

# Publish AW Catalog

## 工作流

1. 从本 Skill 实际 root 运行 `aw self check --from <skill-root> --json`，失败即停止。
2. 保留用户已指定的 Workspace root、remote 和 branch；缺省项交给 CLI 解析，不要求用户重复提供。当前默认是最近合法 Workspace、`origin` 或唯一 remote，以及 `catalog` 分支；默认分支不是当前 Git branch。只有 CLI 无法唯一解析或解析目标与用户意图冲突时才澄清。
3. 运行 `aw catalog publish plan --help`，用用户已给参数生成 JSON plan；未指定项省略。说明 plan 会读取远端 refs，并从已提交 source HEAD 执行插件 validator/build 和 Catalog build。plan 失败时停止，不请求授权。
4. 从同一 receipt 展示 workspaceRoot、workspaceIdentity、sourceHead、catalogVersion、channel、pluginCount、remote、安全的 fetchUrl/pushUrl、remote identity digest、branch、parent、tag、expectedCommit、snapshotDigest、state 和完整 planDigest。字段缺失时停止，不猜测或重算。
5. 只请求一次针对该完整 planDigest 和 canonical `{descriptor, expectedCommit}` 的授权。用户拒绝即停止。
6. 授权后将 plan 解析出的 root、remote、branch 和完整 planDigest 显式传给 `aw catalog publish apply`，使用 `--expected-plan-digest <planDigest> --yes --json`，不重新依赖缺省解析。核对 apply receipt 的 identity、sourceHead、remote digest、branch、expectedCommit、snapshotDigest 和 planDigest。
7. prepared/uncertain 可用同一 digest 对账或重试；identity、branch、remote、pending repository 或 immutable tag 冲突时停止并按 CLI 指令处理。
8. published journal 与已核验 remote refs 优先证明成功；cleanup warning 单独报告，不自行删除 residue。

不复制 CLI journal、Git ref、tag 或恢复算法，只消费当前 receipt。
