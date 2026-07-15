---
name: commit
description: 当用户要求提交一下、提交代码、提交文档、提交当前改动或已暂存内容时触发；按中文约定式提交规范完成 Git 提交。只要求拟写或评审 commit message、查看状态或解释改动时不要触发。
user-invocable: true
metadata:
  short-description: 中文约定式 Git 提交
{{#if claudeCommandOutputFill}}
allowed-tools:
  - Bash(git status *)
  - Bash(git diff *)
shell: bash
{{/if}}
---

# Commit

目标：创建一次只包含用户所要求改动的中文约定式 Git 提交，同时保持范围外的工作区和暂存区状态不变。

授权边界：自动触发只负责加载本 skill。只有用户明确要求实际创建提交时，才可改变暂存区或创建 commit；范围明确后直接完成，除非用户要求先确认。

成功意味着实际 commit 的内容和最终 message 均与提交前核对结果一致，并向用户报告提交结果和剩余工作区状态。无法安全完成时，保持现有状态并报告阻塞原因。

{{#if claudeCommandOutputFill}}
## 当前 Git 快照

以下内容由 Claude Code 在加载 skill 时自动注入。优先用它判断提交范围；信息不足时，再补充必要的 Git 查看命令。

当前状态：

```!
git status --short
```

未暂存 diff 统计：

```!
git diff --stat
```

未暂存 diff：

```!
git diff --
```

已暂存 diff 统计：

```!
git diff --cached --stat
```

已暂存 diff：

```!
git diff --cached --
```

{{/if}}
执行要求：

1. 根据用户请求和 Git 证据确定本次提交的准确范围。
   - 用户只要求提交已暂存内容时，不要再扩大暂存范围。
   - 纳入未跟踪文件前先检查其内容。
   - 暂存区已有范围外改动时，不要取消暂存或一并提交；暂停并说明冲突。
   - 部分暂存或同一文件混有范围外 hunks 时，保持现有边界。只有用户明确要求纳入相关文件的全部改动时才继续。
   - 不要默认查看提交历史；只有用户要求对齐近期历史时才查看。
2. 按以下项目规范生成 commit message：
   - 标题使用 `<type>: <description>` 或 `<type>(<scope>): <description>`；`description` 使用中文。
   - `type` 从 `feat`、`fix`、`docs`、`refactor`、`test`、`chore` 中按主要变更结果选择，不做关键词映射。
   - 只有存在清晰模块边界时才使用 `scope`，不确定时省略。
   - 改动较多、动机不明显或包含行为变化时补充 body，重点说明为什么；列举多项内容时使用 `-`。
   - 不兼容变更使用 `BREAKING CHANGE: ...`；已知关联项使用 `Closes #N` 或 `See #N`。
   - 如果改动目的彼此无关，无法由一次提交准确表达，暂停并说明范围冲突。
3. 创建提交前核对完整候选内容；没有内容或仍含范围外改动时停止。只创建一次 commit，不使用会扩大范围的广泛暂存，也不绕过 hooks 或自动 amend/reset 来强行完成。
4. 提交失败后先判断当前状态是否改变。只有错误明确属于瞬时故障、未创建 commit 且候选内容未变时，才原样重试一次；否则停止并报告。
5. 提交成功后验证实际内容和最终 message 与候选结果一致。发现差异时不要自动改写历史，直接报告；一致时反馈 hash、subject 和剩余改动摘要。
