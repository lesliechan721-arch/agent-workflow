# Git Commit 触发评测

这里的 20 个固定用例分成 train（12）和 validation（8），用于评测 Codex 是否在正确场景隐式加载 `git-commit` skill。

- 正例覆盖自然语言提交、已暂存内容、指定文件、英文请求和“提交并推送”中的提交步骤。
- 反例覆盖只拟写或评审 message、查看状态、暂存、推送已有提交、改写历史，以及非 Git 语义的 “commit”。
- 不根据 validation 结果反向修改 description；先在 train 上迭代，最后只用 validation 检查泛化。
- 显式 `$git-commit` 由 Codex 在模型运行前直接注入，不会产生隐式加载所需的 shell 读取事件，因此不放进隐式触发 corpus；常规插件测试改为验证 portable frontmatter 与真实 Codex bundle 元数据。

## 行为评测

`behavior-cases.json` 和 `run-commit-evals.mjs` 定义 8 条可写 command 用例，覆盖非琐碎 body、琐碎提交、部分暂存、范围外已暂存内容、仓库 message 规范、提交后继续 push、进行中的 Git 操作和 hook 拒绝。每条声明用 `grader_check` 绑定 runner 产生的机械检查；声明缺少对应 grader 时，该 case 失败。

runner 在独立临时仓库中运行 current 与 no-Skill baseline，并机械检查 HEAD、refs、index、worktree、commit 内容、remote ref 和 hook 状态。只有需要创建 commit 的内层 Codex 进程能写该临时仓库的 Git metadata。

## 运行真实触发评测

```bash
pnpm plugin:eval git --skill git-commit --batch-name materialization --materialize-only
pnpm plugin:eval git --skill git-commit --batch-name trigger-validation-debug --suite trigger --split validation --runs 1
pnpm plugin:eval git --skill git-commit --batch-name behavior-debug --suite behavior --case staged_only_with_unstaged_hunks
pnpm plugin:eval git --skill git-commit --batch-name release
```

该 manifest 的 release targets 包含 trigger validation 和全部 behavior cases。检查 train：

```bash
pnpm plugin:eval git --skill git-commit --batch-name trigger-train --suite trigger --split train --runs 3
```

trigger fixture 使用同时包含已暂存、未暂存和未跟踪内容的临时 Git 仓库。

插件 fixture module 只负责构造 Git 状态和语义 snapshot；每次运行前后都会比对 Git refs、配置、tracked/untracked 内容和状态，一旦观察到成功读取目标 `SKILL.md` 就立即停止。

默认每条运行 3 次，以 `0.5` 为分界：正例加载率必须高于分界，train 反例加载率必须低于分界；validation 反例要求零误触发。JSON 报告会记录 Codex 版本、模型来源、插件版本、skill/corpus SHA-256 和操作系统信息，便于复现。

## 常规插件测试

```bash
pnpm plugin:test git
```

常规插件测试验证：

- trigger/behavior corpus、Git fixture、环境隔离和语义状态 snapshot；
- `pnpm plugin:test` 临时 bundle 中 Claude/Codex 的实际模板渲染结果；
- 部分暂存提交只记录 index 内容并保留未暂存 hunks；
- 普通 porcelain 状态不会明确标识已解决但尚未完成的 merge，而完整 `git status` 可以识别该状态。
