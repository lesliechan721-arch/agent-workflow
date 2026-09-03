# Eval 审核器行为评测

`behavior-cases.json` 是作者期的结构与设计证据。它定义 fail-closed、digest binding 和结果归因场景，但当前没有真实模型执行证据，也不得据此声称行为已通过。

通过公开 prepare 命令按 suite/profile/case 选择准备 `EvalSpec v1`；需要执行时交给 Runner：

```bash
aw skill eval prepare agent-skill-toolkit audit-agent-skill-evals --suite behavior --profile project-default --output ./audit-spec --json
```

执行前验证 Spec，并复用与 target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。Runner 执行 `aw-skill-eval run <spec> --audit <audit>`，生成 `EvalResult v2`，再用 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>` 验证。

clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。triage 不是 Release Check 的机器输入。发布检查范围只从当前 `evals/manifest.json` 的 `requiredForRelease` 和 `releaseSplits` 派生。
