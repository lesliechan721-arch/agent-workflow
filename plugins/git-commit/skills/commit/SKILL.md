---
name: commit
description: 当用户要求提交当前改动、生成或执行 git commit 时，先核对工作区范围，再按约定式提交规范生成中文 commit message 并完成提交。
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

这个 skill 用来处理用户的提交请求：先确认变更范围，再按约定式提交规范完成一次 Git 提交。

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
2. 分析本次变更并草拟 commit message，遵守这些规则：
   - 标题格式：`<type>(<scope>): <description>`
   - `description` 使用中文，简明说明本次提交改了什么
   - `type` 只能从 `feat`、`fix`、`docs`、`refactor`、`test`、`chore` 里选择
   - 只有确实有模块边界时才填写 `scope`，否则省略
   - 改动较多、动机不明显或包含行为变化时补充 body，重点说明为什么改
   - body 每行都以 `-` 开头；涉及多个模块时按模块分组
   - 有不兼容变更时，footer 使用 `BREAKING CHANGE: ...`
   - 有关联 issue 或 PR 时，footer 使用 `Closes #N` 或 `See #N`
3. 按文件路径精确执行 `git add` 和 `git commit`，不要把无关改动纳入提交。
4. 提交完成后运行 `git status`，确认工作区状态，并把提交结果反馈给用户。

边界要求：

- 完成分析后直接提交，除非用户明确要求先确认。
- 不要扩大暂存范围；默认只暂存本次提交涉及的具体文件。
- 不要使用 `git add -A`、`git add .` 这类会扩大范围的写法，除非用户明确要求。
- 不要默认查看提交历史；本 skill 已固定提交格式，只有用户明确要求对齐近期历史时才查看历史。
- 如果变更里混有明显无关内容且无法安全区分，先暂停并说明原因，不要贸然提交。
- 如果无法判断合适的 `type` 或 `scope`，先把判断依据说清楚，再给出候选 message。
