---
name: resolving-merge-conflicts
description: 当用户需要解决正在进行的 Git merge 或 rebase 冲突时使用。不要用于启动或中止 Git 操作，也不要用于普通提交。
---

# Resolving Merge Conflicts

1. 查看完整 `git status`、相关历史和冲突文件，确认当前是 merge 还是 rebase。

2. 查找每个冲突的原始依据。理解 base、ours、theirs 和相关提交分别要实现什么；rebase 时不要根据 ours/theirs 的名称猜测含义。能分别说明两侧意图后再解决；无法说明时停止并询问用户。

3. 逐个 hunk 解决冲突。可以兼容时保留两侧意图；不能兼容时按已有证据或用户决定选择，并说明取舍。不要发明新行为，不要批量选择 ours/theirs，也不要自行 abort、skip 或 reset。

4. 确认没有未合并路径或残留冲突标记，只暂存已解决的文件。发现并运行项目检查，修复本次解决引入的问题，不绕过 hooks。

5. 继续当前 merge 或 rebase。rebase 出现下一批冲突时重复以上步骤，直到操作完成；最后报告解决内容、检查结果和 Git 状态。
