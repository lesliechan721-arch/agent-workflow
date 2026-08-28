---
name: review-aw-catalog
description: >-
  当用户要严格只读评审一个 AW Catalog Workspace 的 identity、metadata、plugin inventory、dependency graph、版本一致性、已有 snapshot 投影或发布配置与证据时使用。它不修改、不 build、不 publish，也不评审单插件内部质量、Skill prompt 或跨插件业务 workflow。
compatibility: 需要 Node.js 22+、当前 PATH 中提供静态 catalog status 的 aw CLI，以及 aw-plugin-development。
user-invocable: true
metadata:
  short-description: 只读评审 AW Catalog composition 与现有证据
---

# Review AW Catalog

严格保持只读。Catalog composition finding 与单插件内部 finding 是不同责任。

## 工作流

1. 明确调用方给出的 `<workspace-root>`、Review 范围和排除项。读取 workspace 规则、`.aw-workspace.json`、`plugins/marketplace-source.json` 和 plugin manifests。
2. 运行当前 PATH 的 `aw catalog status --workspace-root <workspace-root> --json`，只消费静态状态。不得传 `--preflight`，不得运行 plugin build/test、catalog build/validate/publish，也不得创建或刷新生成物。
3. 读取 `references/catalog-review.md`。核对 Workspace identity、metadata、plugin inventory、typed manifest dependency graph、Catalog/plugin exact version consistency、现有 snapshot 的生成投影、已有 ledger/attempt evidence 和 publication remote/branch 配置。Build determinism 只能依据已有可验证证据；没有证据时标为 unknown，不能运行 build 补证。
4. 若一个 composition finding 需要单插件内部证据，委托 `review-aw-plugin` 只读评审该插件。只消费其摘要，不重复报告相同 finding。Skill prompt 质量、单插件内部设计和 Release Check 由下层 Reviewer 拥有。
5. 输出 Catalog composition findings、证据、影响、owner、unknown 和停止条件。不得把多个插件的业务行为包装成 Catalog finding；这类请求使用 `review-aw-workflow`。

## 边界

- 不修改任何 source、metadata、snapshot、ledger、attempt 或配置。
- 不执行 build、publish 或任何会运行插件代码的 preflight。
- 不评审 Skill prompt、单插件内部质量或跨插件业务 workflow。
