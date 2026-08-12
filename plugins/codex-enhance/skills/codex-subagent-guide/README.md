# codex-subagent-guide

在委派权限已明确后，为通用 Codex 子代理任务选择 role、模型参数、上下文 fork、等待和清理规则。

主要指令见 `SKILL.md`。动态配置由插件 renderer 写入最终 Skill。模型 eval 合同见 `evals/`。

## 最近验证

- 最近 eval：`20260811T172058Z-release-review-c91aa8de`，结果 `incomplete`，release `incomplete`，覆盖 `8/8`；该批次在合并前的 `codex-subagent-guide` 插件身份下生成。
- 完整 eval 批次报告：`plugins/codex-enhance/reports/codex-subagent-guide/20260811T172058Z-release-review-c91aa8de/report.md`；历史运行来自 `c695509e7a69fbb4686a7aaa94a784447731d02a`、`ea65adf117e822826a27b97e303a4150b96fea34` 和 `71c443dca70d4702bb98da39c86a1fc6288b80d7`。
- 最近 review：`release`，加权分 `90.4`，coverage `100%`，confidence `high`，release `pass`。
- 完整 review 报告：`plugins/codex-enhance/reports/codex-subagent-guide/20260811T172058Z-release-review-c91aa8de/reviews/release/20260811T172058Z-c91aa8de/report.md` @ `71c443dca70d4702bb98da39c86a1fc6288b80d7`。
