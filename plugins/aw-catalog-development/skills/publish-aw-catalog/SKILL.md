---
name: publish-aw-catalog
description: >-
  当用户清晰要求发布某个 AW Catalog（包括“发布当前 Catalog”）时使用。先运行 publication preflight、展示 CLI 解析的精确身份并取得仅本次授权；普通修改、build、验证或只读 Review 不使用。
compatibility: 需要 Node.js 22+、可用的 aw CLI，以及合法 Catalog Workspace。
user-invocable: true
metadata:
  short-description: 经精确授权后发布 AW Catalog
---

# Publish AW Catalog

这是唯一拥有远端 Catalog publication 的 Skill。普通维护或“准备发布”不构成执行授权。

## Runtime gate

在首次 AW 命令前，从平台提供的本 Skill 实际根取得 `<skill-root>`：使用 Skill locator 或当前加载的 `SKILL.md` 所在根，绝不从 cwd 猜测。随后运行：

```bash
aw self check --from <skill-root> --json
```

找不到 `aw` 或 `aw self check` 命令时立即停止，并精确报告 `missing: aw` 或 `missing: aw self check`。若 JSON 的 `ok` 为 `false`，立即停止并逐项报告 `missingCapabilities`；不添加 `--require`、不维护 Skill 内 capability 列表，也不固定 executable。

## 工作流

1. 运行 `aw catalog context --json`。用户已明确给出的 root、remote 或 branch 必须分别作为 `--workspace-root <user.root>`、`--remote <user.remote>` 或 `--branch <user.branch>` 传入这一次 context。只使用 CLI JSON 的 `workspace.root`、`publication.remote` 和 `publication.branch`。合法 marker 使 `workspace.found` 为 true；`workspace.health` 为 `degraded` 时仍保留 CLI 定位的 root，但后续 preflight 必须证明可发布。
2. Blocking workspace marker issue 立即停止。Workspace 找不到、remote unavailable、publication ambiguous，或存在 blocking publication issue 时，不进入 preflight；询问缺少或无效的选择。取得选择后必须运行新的 context：

   ```bash
   aw catalog context --workspace-root <selected.workspaceRoot> \
     --remote <selected.remote> --branch <selected.branch> --json
   ```

   丢弃先前 context receipt，只消费这个新 receipt 的 resolved root、remote 和 branch；新 receipt 仍有 blocking issue 时停止，不能复用旧值或进入 preflight。`workspace-content` 和 `development-source` 的非阻断 issue 不替代 preflight，也不改变 publication target。仍不从当前 Git branch 或本 Skill 推断目标。
3. 告知用户 preflight 会从已提交 source HEAD 执行每个插件的公开 validator 和 build code。清晰的“发布当前 Catalog”请求可进入这一步，但不授权远端写。无歧义后运行：

   ```bash
   aw catalog status --workspace-root <context.workspace.root> \
     --remote <context.publication.remote> \
     --branch <context.publication.branch> --preflight --json
   ```

4. Preflight 必须成功。在请求授权前，直接从同一个 JSON receipt 展示以下全部字段：最终绝对 `workspace.root`、`workspace.identity`、`git.sourceHead`、`catalog.version`、`publication.remote`、安全的 `publication.fetchUrl`、安全的 `publication.pushUrl`、`publication.branch`、`publication.parent`、`publication.tag`、`publication.snapshotDigest`、`publication.planId` 和完整 `publication.descriptorDigest`。任一字段缺失时停止；不得猜测、重算或省略。
5. 展示全部字段后，请求用户精确授权这一次完整 `publication.descriptorDigest`。其它展示字段是该 descriptor 的人类可读上下文，不是独立授权 token。旧授权、笼统的“发布最新版”或只授权 remote 不足以继续。
6. 只有精确授权后才运行：

   ```bash
   aw catalog publish --workspace-root <preflight.workspace.root> \
     --remote <preflight.publication.remote> \
     --branch <preflight.publication.branch> \
     --expected-descriptor-digest <preflight.publication.descriptorDigest> \
     --yes --json
   ```

7. 核对 publish receipt 的 `workspaceRoot`、`remote`、`branch` 和 `descriptorDigest` 与 preflight 及已授权 digest；保留 receipt 的其它 CLI 证据。drift 或不一致时报告失败，不修改或删除 attempt。

## 失败边界

- 不自动 publish，不在授权前运行 publish。
- 不删除、改写或绕过 version attempt。
- 拒绝、preflight 失败、drift 或结果不确定时，报告现有 receipt/错误并停止。Catalog 不重试或 repair 同一 version；后续发布必须由 Catalog Author 选择新版本并重新 preflight。
- 不实现或复制 CLI publication、ledger、tag 或 recovery 算法。
