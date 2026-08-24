# review-agent-workflow

只读评审一个有明确用户结果、入口和参与组件的跨 Skill 工作流。它负责端到端 common path、状态 owner、失败传播、最小架构和 leaf 修改的 blast radius。显式整仓 Agent 能力或多个未界定 Agent 组件的 Review 会进入 Scope Admission，但只输出 workflow partitions 和 `partial`/`rejected`，不输出全局 pass。单 Skill Review 仍由单 Skill Reviewer 负责；AW manifest、单 AW 插件和跨 AW 插件 Review 分别交给 AW Reviewer。
