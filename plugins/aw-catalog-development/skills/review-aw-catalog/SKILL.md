---
name: review-aw-catalog
description: >-
  当用户要严格只读评审一个 AW Catalog Workspace 的 identity、metadata、plugin inventory、dependency graph、版本一致性、已有 snapshot 投影或发布配置与证据时使用。它不修改、不 build、不 publish，也不评审单插件内部质量、Skill prompt 或跨插件业务 workflow。
compatibility: 需要 Node.js 22+、可用的 aw CLI，以及 aw-plugin-development。
user-invocable: true
metadata:
  short-description: 只读评审 AW Catalog composition 与现有证据
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

1. 先确定本次 context target：依次使用用户明确的 Workspace root、从 canonical `<root>/plugins/<name>` target 推导的 root、或上游 handoff 的 resolved root；只有任务明确指向 current Workspace 时才不传 root。首次运行 `aw catalog context [--workspace-root <target-root>] --json`。receipt 的 `workspace.root` 必须与 target 或 handoff path 一致，不一致时停止；只在 root 缺失或歧义时询问。合法 marker 使 `workspace.found` 为 true；此时只使用 receipt 给出的绝对 root，并读取 Workspace 规则、metadata 和 manifests。`workspace.health` 为 `degraded` 时仍在该 root 完成可得的只读检查，并把非阻断 `workspace-content` issue 作为 finding。只有 blocking 的 workspace marker issue 才阻止定位；`development-source` 或无关 publication issue 不阻止通用 Catalog Review。
2. 运行 `aw catalog status --workspace-root <workspace.root> --json`，只消费静态 status。把 snapshot 的 `absent`、`current`、`stale` 或 `invalid` state 及其 JSON evidence 写入结论；不以缺少 build 证据推断通过。
3. 若现有 snapshot 是 Review 范围的一部分，只有公开 `aw catalog validate --help` 明确该命令只读时，才可运行 `aw catalog validate <snapshot.path> --json`。这只验证已存在的 snapshot，不 build 或刷新它。
4. 读取 `references/catalog-review.md`。核对 Workspace identity、metadata、plugin inventory、typed manifest dependency graph、Catalog/plugin exact version consistency、已有 snapshot projection、ledger/attempt evidence 和 publication target。Build determinism 只能依据已有可验证证据；没有证据时标为 unknown。
5. 若 composition finding 需要单插件内部证据，委托 `review-aw-plugin` 只读评审该插件。只消费其摘要，不重复报告相同 finding。Skill prompt 质量、单插件内部设计和 Release Check 由下层 Reviewer 拥有。
6. 输出 Catalog composition findings、证据、影响、owner、unknown 和停止条件。不得把多个插件的业务行为包装成 Catalog finding；这类请求使用 `review-aw-workflow`。

## 边界

- 不修改任何 source、metadata、snapshot、ledger、attempt 或配置。
- 不运行 plugin test/build、catalog build、`catalog status --preflight`、publish 或其它 mutation；不运行会执行插件代码的 preflight。
- 不评审 Skill prompt、单插件内部质量或跨插件业务 workflow。
