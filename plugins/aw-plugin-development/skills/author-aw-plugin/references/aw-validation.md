# AW 单插件验证与版本

只在单 Plugin Source 的验证、构建、plugin version、materialization 或 Eval 分支读取。当前 PATH 的 AW CLI/Core 是机器真值；每次先运行对应 `--help`，不要猜测 flag，也不要使用 `npx`、仓库私有脚本或旧参数。

所有 `<workspace-root>` 都是已存在且合法的 Catalog Workspace 根。`<plugin-root>` 是其 canonical `plugins/<name>` 目录。

按需使用公开 `aw plugin validate <plugin-root> --workspace-root <workspace-root>`、`aw plugin test <plugin-root> --workspace-root <workspace-root>`、`aw plugin build <plugin-root> --workspace-root <workspace-root>` 和 `aw plugin status <name> --workspace-root <workspace-root>`。机械字段问题使用 `aw plugin capabilities --surface <surface> --json`。`status` 不传 `--base` 时不要求 Git；只有显式基线比较才传明确 Git ref。

先 validate 和 test。只有需要单插件 materialized bundle 时才 build，并验证 CLI 返回的输出。日常开发是否改变 plugin `version` 由目标 workspace 的规则和当前 `aw plugin status` 证据决定；本 reference 不缓存 Catalog floor、ledger、tag 或 publisher recovery 规则。

Catalog Workspace 初始化、marketplace-source metadata、inventory、依赖聚合、Catalog version、Catalog build/validate/status 和 publication 不属于本 Skill。把它们交回 `author-aw-catalog` 或显式 `publish-aw-catalog`，不要从 Plugin Author 反向委托并形成依赖循环。

Author 的完成条件不依赖独立 Review 或模型 Eval。用户明确要求 Eval 资产时交给对应设计能力；真实模型执行保持单独授权和独立证据。
