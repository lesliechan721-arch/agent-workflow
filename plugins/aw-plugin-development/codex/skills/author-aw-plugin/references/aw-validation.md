# AW 单插件验证与版本

只在单 Plugin Source 的验证、构建、plugin version、materialization 或 Eval 分支读取。当前 PATH 的 AW CLI/Core 是机器真值；先完成本 Skill 的 `aw self check`，每次再按需运行对应 `--help`。不要猜测 flag，也不要使用 `npx`、私有脚本或旧参数。

所有 `<workspace-root>` 都是已存在且合法的 Catalog Workspace 根。`<plugin-root>` 是其 canonical `plugins/<name>` 目录。

按需使用公开 `aw plugin validate <plugin-root> --workspace-root <workspace-root>`、`aw plugin test <plugin-root> --workspace-root <workspace-root>`、`aw plugin build <plugin-root> --workspace-root <workspace-root>` 和 `aw plugin status <name> --workspace-root <workspace-root>`。字段问题先检查 `aw plugin capabilities --json` 的实际领域，再按需查询一个领域。`status` 不传 `--base` 时不要求 Git；只有显式基线比较才传明确 Git ref。

修改完成后先运行 `aw plugin requirements <plugin-root> --workspace-root <workspace-root> --json`，核对 declared、derived、detected、effective 和 observations；再 validate。只有动态 AW 调用无法自动发现时，才通过 `--add <capability>` 写入已知 capability。只有需要单插件 materialized bundle 时才 build，并验证 CLI 返回的输出。日常开发是否改变 plugin `version` 由目标 workspace 的规则和当前 `aw plugin status` 证据决定；本 reference 不计算最低 AW version，也不缓存 Catalog floor、ledger、tag 或 publisher recovery 规则。

## 删除分支

只有 `author-aw-catalog` 已明确交接删除任务并传入 `<plugin-name>` 时才删除。Workspace root 来自 context receipt。没有 handoff 时停止，并要求调用 `author-aw-catalog`。先运行 `aw plugin remove --help`，再只用帮助公开参数执行：

```bash
aw plugin remove <plugin-name> --workspace-root <workspace-root> --yes --json
```

不要直接删除目录，不使用或猜测 `--force`，不修改 Catalog metadata，也不 commit、build 或 publish。成功后把结构化 JSON receipt 交回 Catalog Author；删除的插件不再运行 validate、test、build 或 status。Catalog Author 负责重新读取 inventory/依赖并验证其余插件。

Catalog Workspace 初始化、marketplace-source metadata、inventory、依赖聚合、Catalog version、Catalog build/validate/status 和 publication 不属于本 Skill。把它们交回 `author-aw-catalog` 或显式 `publish-aw-catalog`，不要从 Plugin Author 反向委托并形成依赖循环。

Author 的完成条件不依赖独立 Review 或模型 Eval。用户明确要求 Eval 资产时交给对应设计能力；真实模型执行保持单独授权和独立证据。
