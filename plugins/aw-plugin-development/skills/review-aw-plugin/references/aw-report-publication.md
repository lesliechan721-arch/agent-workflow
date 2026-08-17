# AW report publication

默认只返回报告或保存临时草稿。

- 正式报告发布与批次封存是一个原子动作，需要用户明确授权。
- 正式报告以 `reports/**/summary.json` 为事实源，不登记到 production README。
- 适配器负责项目目录和命令；通用 Reviewer 不知道报告保存位置。
- 设计 pass 与 release evidence provisional 分开表达。

`review:publish` 保留旧 `--scorecard` 输入，也接受新的结构化输入：

```bash
pnpm review:publish -- --plugin <name> --skill <owner-skill> \
  --batch-id <batch-id> --report <report.md> \
  --review-result <review-result.json> --aw-summary <aw-review-summary.json>
```

静态 repo Skill 只需要通用结果：

```bash
pnpm review:publish -- --skill <skill> --batch-id <batch-id> \
  --report <report.md> --review-result <review-result.json>
```

两种输入模式不能混用。结构化模式会保存通用 `ReviewResult`；AW 插件模式还保存 AW summary。内部 `scorecard.json` 是 `review-result-projection-v1` 投影，只服务现有批次摘要，不声明与旧 scorecard 输出合同兼容。
