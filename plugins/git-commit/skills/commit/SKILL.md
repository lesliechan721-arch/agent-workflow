---
name: commit
description: 当用户明确要求实际创建一次 Git commit 时必须使用，包括“提交一下”、提交当前改动、已暂存内容或指定文件，以及“提交并推送”中的提交步骤；核对范围后创建约定式提交。仅要求拟写或评审 commit message、查看状态、解释改动、暂存文件、推送已有提交，或单独执行 merge/amend/rebase/cherry-pick/revert/tag 等历史操作时不要使用。
user-invocable: true
metadata:
  short-description: 核对变更范围、仓库规范与提交边界后创建可追溯的约定式 Git 提交
{{#if claudeCommandOutputFill}}
allowed-tools: "Bash(git status *) Bash(git diff *)"
shell: bash
{{/if}}
---

# Commit

目标：创建一次只包含用户所要求改动的约定式 Git 提交，同时保持范围外的工作区和暂存区状态不变。优先遵守仓库已有提交规范；没有明确规范时使用中文描述和本 skill 的默认约定。

授权边界：自动触发只负责加载本 skill。只有用户明确要求实际创建提交时，才可改变暂存区或创建 commit；范围明确后直接完成，除非用户要求先确认。

成功意味着实际 commit 的内容和最终 message 均与提交前核对结果一致，并向用户报告提交结果和剩余工作区状态。无法安全完成时，保持现有状态并报告阻塞原因。

{{#if claudeCommandOutputFill}}
## 当前 Git 快照

以下轻量概览由 Claude Code 在加载 skill 时自动注入，只用于初步判断范围。确定候选范围后，仍须按需查看对应完整 diff。

当前状态：

```!
git status --porcelain=v1 --untracked-files=all
```

未暂存 diff 统计：

```!
git diff --no-ext-diff --no-textconv --stat
```

已暂存 diff 统计：

```!
git diff --cached --no-ext-diff --no-textconv --stat
```

{{/if}}
执行要求：

1. 建立 Git 状态基线。
   - 确认当前目录属于 Git worktree，并运行完整的 `git status` 判断是否存在 merge、rebase、cherry-pick、revert 或未解决冲突。
   - 如果存在进行中的 Git 操作，除非用户明确要求继续该操作，否则保持状态不变并报告阻塞。
   - 区分已暂存、未暂存和未跟踪内容；使用 diff 时加上 `--no-ext-diff --no-textconv`，避免运行外部 diff 或 textconv helper。
2. 根据用户请求和 Git 证据确定本次提交的准确范围。
   - 用户只要求提交已暂存内容时，不要再扩大暂存范围。
   - 同一文件同时存在已暂存和未暂存 hunks 时，可以只提交已暂存部分；除非用户明确要求，不得把未暂存 hunks 扩入候选。
   - 纳入未跟踪文件前先检查其内容。
   - 暂存区已有范围外改动时，不要取消暂存或一并提交；暂停并说明冲突。
   - 需要纳入未暂存内容时，只对确认全部属于本次范围的路径执行 `git add -- <paths>`；不要使用 `git add .`、`git add -A` 或其它会扩大范围的广泛暂存。
   - 同一文件的未暂存内容混有范围外 hunks 时，只有用户明确要求纳入该文件全部改动才可暂存，否则停止。
   - 不要默认查看提交历史；只有用户要求对齐近期历史时才查看。
3. 生成 commit message。
   - 优先遵守仓库通过 AGENTS.md、CONTRIBUTING、commitlint 配置或用户指令明确提供的提交规范。
   - 仓库没有明确规范时，标题使用 `<type>: <description>` 或 `<type>(<scope>): <description>`；`description` 使用中文。
   - 默认 `type` 从 `feat`、`fix`、`docs`、`refactor`、`test`、`chore` 中按主要变更结果选择，不做关键词映射。
   - 只有存在清晰模块边界时才使用 `scope`，不确定时省略。
   - 改动较多、动机不明显或包含行为变化时补充 body，重点说明为什么；列举多项内容时使用 `-`。
   - 标题、body 和 footer 之间各保留一个空行。
   - 不兼容变更使用 `BREAKING CHANGE: ...`；已知关联项使用 `Closes #N` 或 `See #N`。
   - 如果改动目的彼此无关，无法由一次提交准确表达，暂停并说明范围冲突。
4. 创建提交前核对完整候选内容。
   - 查看最终的 `git diff --cached --no-ext-diff --no-textconv --stat` 和 `git diff --cached --no-ext-diff --no-textconv --`。
   - 使用 `git commit --dry-run` 再确认将提交的路径。
   - 没有候选内容、存在未解决冲突或候选仍含范围外改动时停止。
5. 只创建一次 commit；不绕过 hooks，不自动 amend/reset，也不使用会扩大范围的广泛暂存。
6. 提交失败后先判断当前状态是否改变。只有错误明确属于瞬时故障、未创建 commit 且候选内容未变时，才原样重试一次；否则停止并报告。
7. 提交成功后验证新 `HEAD` 的实际内容和最终 message 与候选结果一致。发现差异时不要自动改写历史，直接报告；一致时反馈 hash、subject 和剩余改动摘要。
