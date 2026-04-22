# Commit

这个 skill 用来指导 agent 按 Conventional Commits 规范完成一次 git 提交。入口语义是“用户手动调用该 skill”，不是跨平台统一 slash command。

执行流程必须严格遵守下面的顺序：

1. 先运行 `git status` 和 `git diff`，确认当前工作区有哪些变更。
2. 再运行 `git log --oneline -n 10`，观察最近提交的风格和 scope 命名。
3. 分析本次变更，草拟 commit message，并遵守这些规则：
   - 标题格式：`<type>(<scope>): <description>`
   - `description` 使用中文，直接说明这次改动做了什么
   - `type` 只能从 `feat`、`fix`、`docs`、`refactor`、`test`、`chore` 里选择
   - 只有涉及明确模块时才填写 `scope`，否则省略
   - 多处改动、动机不明显、或者有行为变化时，必须补充 body，重点说明为什么改
   - body 每条变更都以 `-` 开头；如果涉及多个模块，按模块分组描述
   - 有不兼容变更时，footer 必须包含 `BREAKING CHANGE: ...`
   - 有 issue 或 PR 关联时，在 footer 使用 `Closes #N` 或 `See #N`
4. 在执行任何写操作前，把草拟好的 commit message 完整展示给用户，明确请求确认。
5. 只有在用户确认后，才能执行 `git add` 和 `git commit`。
6. 提交完成后运行 `git status`，确认工作区状态，并把结果反馈给用户。

额外要求：

- 不要跳过用户确认。
- 不要擅自扩大暂存范围；如果变更里混有明显无关内容，要先提醒用户。
- 如果无法判断合适的 `type` 或 `scope`，先把判断依据说清楚，再给出候选 message。
