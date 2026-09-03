---
name: review-aw-catalog
description: >-
  当用户要严格只读审核 AW Catalog Workspace 的 identity、metadata、plugin inventory、dependency graph、版本一致性和已有 snapshot evidence 时使用。它不修改、不 build、不访问网络、不 publish，也不评审单插件内部质量、Skill prompt 或跨插件业务 workflow。
compatibility: 需要 Node.js 22+、可用的 aw CLI，以及 aw-plugin-development。
user-invocable: true
metadata:
  short-description: 只读评审 AW Catalog composition 与 snapshot evidence
---

# Review AW Catalog

严格保持只读。Catalog composition finding 与单插件内部 finding 是不同责任。

## Runtime gate

在首次 AW 命令前，从平台提供的本 Skill 实际根取得 `<skill-root>`：使用 Skill locator 或当前加载的 `SKILL.md` 所在根，绝不从 cwd 猜测。随后运行：

```bash
aw self check --from <skill-root> --json
```

找不到 `aw` 或 `aw self check` 命令时立即停止，并精确报告 `missing: aw` 或 `missing: aw self check`。若 JSON 的 `ok` 为 `false`，立即停止并逐项报告 `missingCapabilities`；不添加 `--require`、不维护 Skill 内 capability 列表，也不固定 executable。

## 工作流

1. 用户明确给出 Workspace root 时传 `--workspace-root <root>`。用户给出 canonical `<root>/plugins/<name>` target 时推导并保持该 root。其它请求让静态 status 从 cwd 自动发现最近的合法 Workspace。只有输入和自动发现都不能唯一确定 root 时才询问；不得发明 root、identity 或 receipt。
2. 运行 `aw catalog status [--workspace-root <root>] --json`。这是唯一必需的 Catalog 检查命令。读取 Workspace、metadata、inventory、dependency graph、Git fact 和 snapshot evidence。
3. 按 status receipt 精确解释 snapshot：
   - `current`：`valid=true` 且 `sourceIdentityMatches=true`，可作为当前 source 的现有投影证据；
   - `stale`：snapshot 自身可验证，但 `sourceIdentityMatches=false`，不能代表当前 source；
   - `absent`：没有已有 snapshot，不能推断 build 或 projection 通过；
   - `invalid`：已有 snapshot 未通过 complete validation，报告为 invalid，不修复。
4. 当 Review 范围需要检查已存在 snapshot 时，可运行 `aw catalog validate <status.snapshot.path> --json`；`absent` 时不运行。该命令只验证现有 snapshot，不能把 `stale` 升级为 `current`，也不能证明 determinism。
5. 读取 `references/catalog-review.md`，形成 Catalog composition findings。只有调用方已提供可验证的既有 `review-aw-plugin` 摘要时，才消费单插件内部证据；摘要必须绑定同一 Workspace root，以及 status inventory 中相同名称和版本的 canonical 插件。Plugin Reviewer 保留该 finding 的 owner；Catalog Reviewer 只说明它对 Catalog composition 的影响，不启动、重复或扩展 Plugin Review。摘要缺失、绑定不完整或不匹配时，把 canonical 插件路径和 `review-aw-plugin` 写为独立后续 Review target，并停止该插件内部审查范围；跨插件业务 handoff 使用 `review-aw-workflow`。
6. 输出 findings、status/validate evidence、影响、owner、unknown 和停止条件。缺少两次受控 build 或等价既有 digest evidence 时，把 determinism 标为 unknown。

## 边界

- 不修改 source、metadata、snapshot、publication state 或配置。
- 不运行 plugin validate/test/build、catalog build、catalog dev/source mutation、publish plan/apply 或其它 mutation。
- 不执行插件代码，不 fetch，不访问网络。
- 不在当前 Catalog Review 启动、委托、重复或扩展 `review-aw-plugin`，也不运行 `aw plugin validate` 来建立或更新 Plugin Review 摘要。
- 不评审 Skill prompt、单插件内部质量或跨插件业务 workflow。
