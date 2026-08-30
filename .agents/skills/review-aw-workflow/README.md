# review-aw-workflow

只读评审一个有明确用户结果、入口和参与插件的跨 AW 插件工作流。它先从自身实际 Skill 根检查 AW requirements，再从 `aw catalog context --json` receipt 取得 Workspace，然后生成分类型 AW inventory。它使用通用 workflow Reviewer 判断端到端职责、handoff、状态 owner、失败传播和最小架构。单个 Plugin Source 路由 `review-aw-plugin`。Workflow 不等于 Catalog composition；Workspace identity、metadata、plugin inventory、Catalog version、snapshot 和 publication evidence 使用 `review-aw-catalog`。显式整仓 AW Agent 能力或多个未界定组件的 Review 只做 Scope Admission 和 workflow partitions；scope 未准入时只输出 `partial`/`rejected`，不输出全局 pass。
