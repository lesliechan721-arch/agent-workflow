# Codex Advisor

为技术判断取得有界第二意见，并核验会改变行动的重要建议。适合已明确安排的咨询，或已有任务中的重要判断卡点。

内建配置按难度分为 general、advanced 和 expert，默认使用 gpt-6-astra high、xhigh 和 max。自定义配置按数组顺序优先匹配；未匹配时按难度选档。选中的执行配置交给 Guide 直接调度。

准备原始目标、约束、实际观察和关键材料。取得只读意见后，核对建议的依据，区分采用、不采用和仍需补证的部分；有新证据或具体追问时再追加咨询。

例如：“对这个取消方案取得第二意见，重点检查已提交输入会不会重复执行，并说明需要什么证据。”

方法见 [SKILL.md](SKILL.md)，顾问角色说明见 [顾问指令](assets/advisor-instructions.md)。委派采用 `codex-subagent-guide` 的约定。
