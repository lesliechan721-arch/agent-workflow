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

这个 skill 只处理用户明确要求实际执行的提交请求：先确认工作区和暂存区边界，再按约定式提交规范完成一次 Git 提交。

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
执行流程：

{{gitInspectionStep}}
2. 根据用户请求确定本次提交范围：
   - 用户明确要求只提交已暂存内容时，不要运行 `git add`，以当前暂存区为候选提交范围。
   - 需要暂存工作区改动时，只选择本次提交涉及的具体文件；未跟踪文件也要先检查内容，不能只根据文件名判断。
   - 暂存区已有本次范围外的改动时，暂停并说明冲突，不要擅自取消暂存，也不要把它们一起提交。
   - 文件已部分暂存时，不要用 `git add` 改变其暂存边界，除非用户明确要求提交该文件的全部改动。
3. 分析本次变更并草拟 commit message，遵守这些规则：
   - 标题格式：无 scope 时使用 `<type>: <description>`，有 scope 时使用 `<type>(<scope>): <description>`
   - `description` 使用中文，简明说明本次提交改了什么
   - `type` 只能从 `feat`、`fix`、`docs`、`refactor`、`test`、`chore` 里选择
   - 只有确实有模块边界时才填写 `scope`，否则省略
   - 改动较多、动机不明显或包含行为变化时补充 body，重点说明为什么改
   - body 需要列举多项内容时使用 `-`；涉及多个模块时按模块组织
   - 有不兼容变更时，footer 使用 `BREAKING CHANGE: ...`
   - 有关联 issue 或 PR 时，footer 使用 `Closes #N` 或 `See #N`
4. 仅在需要暂存工作区改动时，使用 `git add -- <path>...` 精确暂存选定文件；不要扩大范围。
5. 提交前重新运行 `git diff --cached --stat` 和 `git diff --cached --`，确认暂存区只包含本次提交内容。没有已暂存改动，或仍混有范围外内容时，不要执行提交。
6. 暂存区核对无误后执行一次 `git commit`。提交完成后运行 `git status`，确认工作区状态，并把提交结果反馈给用户。

边界要求：

- 完成分析后直接提交，除非用户明确要求先确认。
- 自动触发只负责加载本 skill；只有用户明确要求实际创建提交时，才视为授权执行 `git commit`。
- 不要扩大暂存范围，也不要改动用户已有的无关暂存状态。
- 不要使用 `git add -A`、`git add .` 这类会扩大范围的写法，除非用户明确要求。
- 不要默认查看提交历史；本 skill 已固定提交格式，只有用户明确要求对齐近期历史时才查看历史。
- 如果变更里混有明显无关内容且无法安全区分，先暂停并说明原因，不要贸然提交。
- 如果无法判断合适的 `type` 或 `scope`，先把判断依据说清楚，再给出候选 message。
