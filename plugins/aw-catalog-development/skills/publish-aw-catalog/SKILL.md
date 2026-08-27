---
name: publish-aw-catalog
description: >-
  仅当用户显式调用本 Skill，并明确要求把 AW Catalog 发布到其明确给出的 Git remote 和 branch 时使用。必须先运行 publication preflight、展示精确身份并取得该身份的再次授权；不自动选择目标，不自动发布，不重试失败的同一 Catalog 版本。
compatibility: 需要 Node.js 22+、当前 PATH 中提供 catalog status/publish 的 aw CLI，以及具有明确 Git remote 的合法 Catalog Workspace。
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: 经精确授权后发布 AW Catalog
---

# Publish AW Catalog

这是唯一拥有远端 Catalog publication 的 Skill。普通维护或“准备发布”不构成执行授权。

## 工作流

1. 要求用户明确给出 `<workspace-root>`、`<remote>` 和 `<branch>`。不得从 Git 默认值、当前 branch、官方约定或已有配置自动选择 remote/branch。运行 `aw --version`、`aw catalog status --help` 和 `aw catalog publish --help`。
2. 告知用户 preflight 会从已提交 source HEAD 执行每个插件的公开 validator 和 build code。随后运行：

   ```bash
   aw catalog status --workspace-root <workspace-root> \
     --preflight --remote <remote> --branch <branch> --json
   ```

3. Preflight 必须成功。直接从 CLI JSON 展示 `workspace.identity`、`git.sourceHead`、`catalog.version`，以及 `publication.remote`、`fetchUrl`、`pushUrl`、`branch`、`parent`、`tag`、`snapshotDigest`、`planId` 和 `descriptorDigest`。任一字段缺失时停止；不得猜测、重算或省略身份字段。
4. 请求用户明确授权这一个 exact identity。授权必须在本次成功 preflight 之后，并与展示的全部身份相同。旧授权、笼统的“发布最新版”或只授权 remote 不足以继续。
5. 只有精确授权后才运行：

   ```bash
   aw catalog publish --workspace-root <workspace-root> \
     --remote <remote> --branch <branch> \
     --expected-descriptor-digest <descriptorDigest> --yes --json
   ```

6. 核对 receipt 的 `workspaceIdentity`、`sourceHead`、`catalogVersion`、`remote`、`fetchUrl`、`pushUrl`、`branch`、`parent`、`tag`、`snapshotDigest`、`planId` 和 `descriptorDigest` 与授权身份，并使用当前公开的只读 Git/CLI 入口验证 remote branch 和 immutable tag。证据不一致时报告失败，不修改或删除 attempt。

## 失败边界

- 不自动 publish，不自动选择 remote/branch，不在授权前运行 publish。
- 不删除、改写或绕过 version attempt。
- publish 失败或结果不确定后，不重试同一 Catalog version。报告现有 receipt/错误，并把“由 Catalog Author 提升到新版本后重新 preflight”作为恢复入口。
- 不实现或复制 CLI publication、ledger、tag 或 recovery 算法。
