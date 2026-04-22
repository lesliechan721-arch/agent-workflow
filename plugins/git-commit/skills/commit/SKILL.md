---
name: commit
description: 当用户要求提交当前改动、生成或执行 git commit 时，按 Conventional Commits 规范检查当前工作区变更，草拟中文 commit message，并直接完成一次 git 提交。
user-invocable: true
metadata:
  short-description: 可自动触发的 Conventional Commits 提交流程
---

# Commit

这个 skill 用来在用户提出提交诉求时，按 Conventional Commits 规范自动完成一次 git 提交。

按下面的顺序执行：

1. 运行 `git status` 和必要的 `git diff`，确认当前工作区有哪些变更。
2. 运行 `git log --oneline -n 10`，参考最近提交的风格和 scope 命名。
3. 分析本次变更并草拟 commit message，遵守这些规则：
   - 标题格式：`<type>(<scope>): <description>`
   - `description` 使用中文，直接说明改了什么
   - `type` 只能从 `feat`、`fix`、`docs`、`refactor`、`test`、`chore` 里选择
   - 只有涉及明确模块时才填写 `scope`，否则省略
   - 多处改动、动机不明显、或有行为变化时补充 body，重点说明为什么改
   - body 每行都以 `-` 开头；涉及多个模块时按模块分组
   - 有不兼容变更时，footer 必须包含 `BREAKING CHANGE: ...`
   - 有 issue 或 PR 关联时，在 footer 使用 `Closes #N` 或 `See #N`
4. 按文件路径精确执行 `git add` 和 `git commit`，不要把无关改动纳入提交。
5. 提交完成后运行 `git status`，确认工作区状态，并把结果反馈给用户。

边界要求：

- 完成分析后直接提交，除非用户明确要求确认。
- 不要擅自扩大暂存范围；默认按文件路径精确暂存本次提交涉及的文件。
- 不要使用 `git add -A`、`git add .` 这类会扩大范围的写法，除非用户明确要求。
- 如果变更里混有明显无关内容且无法安全区分，先停止并说明原因，不要冒然提交。
- 如果无法判断合适的 `type` 或 `scope`，先把判断依据说清楚，再给出候选 message。
