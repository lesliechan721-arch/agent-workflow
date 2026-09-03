# Git Commit 触发评测

## 准备与运行

`aw skill eval prepare` 每次按 manifest 注册的一个 suite/profile 和可选 case/split 选择生成 `EvalSpec v1`。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare git-toolkit \
  git-commit --suite trigger --profile project-default \
  --output /tmp/aw-eval-specs/git-commit-materialization --json
```

需要模型时，先验证 Spec。复用与 current、可选 previous-version target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。取得本次成本与副作用授权后，Runner 执行：

```bash
aw-skill-eval run /tmp/aw-eval-specs/<spec-dir>/spec.json --audit /tmp/aw-eval-specs/<spec-dir>/audit.json
```

该命令生成 `EvalResult v2`。随后运行 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>`。clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才由全新上下文做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。triage 不是 Release Check 的机器输入。发布检查范围只从当前 `evals/manifest.json` 的 `requiredForRelease` 和 `releaseSplits` 派生。

这里的 20 个固定用例分成 train（12）和 validation（8），用于评测 Codex 是否在正确场景隐式加载 `git-commit` skill。

- 正例覆盖自然语言提交、已暂存内容、指定文件、英文请求和“提交并推送”中的提交步骤。
- 反例覆盖只拟写或评审 message、查看状态、暂存、推送已有提交、改写历史，以及非 Git 语义的 “commit”。
- 不根据 validation 结果反向修改 description；先在 train 上迭代，最后只用 validation 检查泛化。
- 显式 `$git-commit` 由 Codex 在模型运行前直接注入，不会产生隐式加载所需的 shell 读取事件，因此不放进隐式触发 corpus；常规插件测试改为验证 portable frontmatter 与真实 Codex bundle 元数据。

## 行为评测

`behavior-cases.json` 和 `run-commit-evals.mjs` 定义 8 条可写 provider 用例，覆盖非琐碎 body、琐碎提交、部分暂存、范围外已暂存内容、仓库 message 规范、提交后继续 push、进行中的 Git 操作和 hook 拒绝。每条声明用 `grader_check` 绑定 provider 产生的机械检查；声明缺少对应 grader 时，该 case 失败。Eval engine 默认对每个 case 运行 3 次。

provider 每次只处理 engine 给出的一个 case、variant 和 attempt。它在独立临时仓库中运行一次 Codex，并机械检查 HEAD、refs、index、worktree、commit 内容、remote ref 和 hook 状态。Engine 负责 variant/attempt 循环、timeout、进程树和最终 EvalResult。

## 准备触发与行为评测 Spec

```bash
aw skill eval prepare git-toolkit git-commit --suite trigger --profile project-default --split validation --runs 1 --output /tmp/aw-eval-specs/git-commit-trigger-validation-debug --json
aw skill eval prepare git-toolkit git-commit --suite behavior --profile project-default --case staged_only_with_unstaged_hunks --output /tmp/aw-eval-specs/git-commit-behavior-debug --json
```

每个所选 suite/profile 应分别准备对应 Spec 并交给 `$run-aw-skill-evals`。检查 train：

```bash
aw skill eval prepare git-toolkit git-commit --suite trigger --profile project-default --split train --runs 3 --output /tmp/aw-eval-specs/git-commit-trigger-train --json
```

trigger fixture 使用同时包含已暂存、未暂存和未跟踪内容的临时 Git 仓库。

插件 fixture module 只负责构造 Git 状态和语义 snapshot；每次运行前后都会比对 Git refs、配置、tracked/untracked 内容和状态，一旦观察到成功读取目标 `SKILL.md` 就立即停止。

默认每条运行 3 次，以 `0.5` 为分界：正例加载率必须高于分界，train 反例加载率必须低于分界；validation 反例要求零误触发。EvalResult 保存每次运行的状态、usage、grade 和输出目录，便于复现。

## 常规插件测试

```bash
pnpm plugin:test git
```

常规插件测试验证：

- trigger/behavior corpus、Git fixture、环境隔离和语义状态 snapshot；
- `pnpm plugin:test` 临时 bundle 中 Claude/Codex 的实际模板渲染结果；
- 部分暂存提交只记录 index 内容并保留未暂存 hunks；
- 普通 porcelain 状态不会明确标识已解决但尚未完成的 merge，而完整 `git status` 可以识别该状态。
