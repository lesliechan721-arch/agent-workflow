# Author Agent Skill

创建或修改 Agent Skill 包，包括正文、description、调用属性、references、scripts、assets 和 Eval 用例。

例如：“把这个流程做成一个可调用 Skill，并为主要场景设计用例。”它先处理受影响的设计问题，再写入授权范围，执行相称的确定性检查，返回修改和未验证项。局部修词可以直接处理，不要求设计 JSON 或完整评审。

它可以设计 Eval，但作者自检不等于独立 Oracle 审核；不会自动运行模型或发布。只读质量评审使用 `review-agent-skill`。
