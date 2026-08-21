# AW 报告发布

默认只返回报告或保存临时草稿。

- 正式报告发布与批次封存是一个原子动作，需要用户明确授权。
- 适配器负责项目报告目录和命令；通用 Reviewer 不知道保存位置。
- 设计 pass 与 release evidence provisional 分开表达。
- Review publication 不修改 Skill README、plugin README 或源码 manifest。

```bash
pnpm review:publish -- --plugin <name> --skill <owner-skill> \
  --batch-id <batch-id> --report <report.md> \
  --review-result <review-result.json> --review-bundle <target-bundle.json> \
  --aw-summary <aw-review-summary.json> --target-plan <target-plan.json> \
  --review-evidence <other-id> <other-result.json> <other-bundle.json>
```

结构化模式先验证主 ReviewInputBundle、每个附加 review evidence 和 AWReviewTargetPlan，再保存通用 `ReviewResult`、AW summary 与 target plan。内部 `scorecard.json` 是兼容投影，不声明与旧 scorecard 合同完全等价。

用户要求把报告登记到 Skill README 时，Reviewer 只输出 registration request：

```json
{
  "action": "register-review-report",
  "plugin": "<name>",
  "skill": "<owner-skill>",
  "batchId": "<batch-id>",
  "reportPath": "<published-report>",
  "suggestedVersionChange": "patch"
}
```

由 `author-aw-plugin` 或项目 release 工具在独立写授权下更新 README、提高 manifest version 并重跑作者门禁。
