# Author AW Plugin 作者期评测

本目录由 `author-aw-plugin` 持有。`behavior-cases.json` 用 7 个复合请求检查 `AWAuthoringContext.components` 完整性、稳定 `aw plugin` 命令、Portable Agent Skills canonical reference、通用作者能力交接和 Author/Reviewer 边界。

```bash
aw skill eval prepare aw-plugin-development author-aw-plugin \
  --suite behavior --profile project-default --output ./author-aw-plugin-spec --json
```

`aw skill eval prepare` 按 suite/profile/case 选择生成 `EvalSpec v1`。执行前验证 Spec，并复用与 target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。Runner 执行 `aw-skill-eval run <spec> --audit <audit>`，生成 `EvalResult v2`，再用 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>` 验证。

clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。triage 不是 Release Check 的机器输入。发布检查范围只从当前 `evals/manifest.json` 的 `requiredForRelease` 和 `releaseSplits` 派生。
