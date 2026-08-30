# Git Commit 触发评测

## 准备与运行

`aw skill eval prepare` 每次只准备 manifest 注册的一个 suite/profile。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare git-toolkit \
  --skill git-commit --suite trigger --profile project-default \
  --output /tmp/aw-eval-plans/git-commit-materialization --json
```

需要模型时，先按目标 suite/profile 生成新的 Plan，再对该目录的 `plan.json` 使用 `$run-aw-skill-evals`。该 Skill 先协调独立 `audit-agent-skill-evals` 上下文完成 preflight Audit，再取得本次模型成本、外部进程、凭据、网络和临时输出的明确授权；授权后由 runner 执行带 Audit 的命令，并在运行后完成 result-triage：

```bash
aw-skill-eval run /tmp/aw-eval-plans/<plan-dir>/plan.json --audit /tmp/aw-eval-plans/<plan-dir>/preflight-audit.json
```

上面的命令只表示 `$run-aw-skill-evals` 在 Audit 和授权通过后调用的 `aw-skill-eval run <plan.json> --audit <audit.json>`。没有 Audit 或 result-triage 的 bundle 只能作为诊断证据，不能用于 Review、修改 Skill 或发布结论。

这里的 20 个固定用例分成 train（12）和 validation（8），用于评测 Codex 是否在正确场景隐式加载 `git-commit` skill。

- 正例覆盖自然语言提交、已暂存内容、指定文件、英文请求和“提交并推送”中的提交步骤。
- 反例覆盖只拟写或评审 message、查看状态、暂存、推送已有提交、改写历史，以及非 Git 语义的 “commit”。
- 不根据 validation 结果反向修改 description；先在 train 上迭代，最后只用 validation 检查泛化。
- 显式 `$git-commit` 由 Codex 在模型运行前直接注入，不会产生隐式加载所需的 shell 读取事件，因此不放进隐式触发 corpus；常规插件测试改为验证 portable frontmatter 与真实 Codex bundle 元数据。

## 行为评测

`behavior-cases.json` 和 `run-commit-evals.mjs` 定义 8 条可写 provider 用例，覆盖非琐碎 body、琐碎提交、部分暂存、范围外已暂存内容、仓库 message 规范、提交后继续 push、进行中的 Git 操作和 hook 拒绝。每条声明用 `grader_check` 绑定 provider 产生的机械检查；声明缺少对应 grader 时，该 case 失败。Eval engine 默认对每个 case 和 configuration 运行 3 次。

provider 每次只处理 engine 给出的一个 case 和 configuration。它在独立临时仓库中运行一次 Codex，并机械检查 HEAD、refs、index、worktree、commit 内容、remote ref 和 hook 状态。Engine 负责 configuration/runs 循环、timeout、进程树和最终 EvalRunBundle。

## 准备触发与行为评测 Plan

```bash
aw skill eval prepare git-toolkit --skill git-commit --suite trigger --profile project-default --split validation --runs 1 --output /tmp/aw-eval-plans/git-commit-trigger-validation-debug --json
aw skill eval prepare git-toolkit --skill git-commit --suite behavior --profile project-default --case staged_only_with_unstaged_hunks --output /tmp/aw-eval-plans/git-commit-behavior-debug --json
```

该 manifest 的发布要求包含 trigger validation 和全部 behavior cases，应分别准备对应 Plan 并交给 `$run-aw-skill-evals`。检查 train：

```bash
aw skill eval prepare git-toolkit --skill git-commit --suite trigger --profile project-default --split train --runs 3 --output /tmp/aw-eval-plans/git-commit-trigger-train --json
```

trigger fixture 使用同时包含已暂存、未暂存和未跟踪内容的临时 Git 仓库。

插件 fixture module 只负责构造 Git 状态和语义 snapshot；每次运行前后都会比对 Git refs、配置、tracked/untracked 内容和状态，一旦观察到成功读取目标 `SKILL.md` 就立即停止。

默认每条运行 3 次，以 `0.5` 为分界：正例加载率必须高于分界，train 反例加载率必须低于分界；validation 反例要求零误触发。EvalRunBundle 会记录 Codex 版本、模型来源、插件版本、skill/corpus SHA-256 和操作系统信息，便于复现。

## 常规插件测试

```bash
pnpm plugin:test git
```

常规插件测试验证：

- trigger/behavior corpus、Git fixture、环境隔离和语义状态 snapshot；
- `pnpm plugin:test` 临时 bundle 中 Claude/Codex 的实际模板渲染结果；
- 部分暂存提交只记录 index 内容并保留未暂存 hunks；
- 普通 porcelain 状态不会明确标识已解决但尚未完成的 merge，而完整 `git status` 可以识别该状态。
