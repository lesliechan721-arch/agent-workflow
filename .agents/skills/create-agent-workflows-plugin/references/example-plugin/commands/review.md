---
description: 对当前分支的改动执行代码审查
allowed-tools:
  - Bash
  - Read
argument-hint: "[file-path]"
---

执行代码审查。如果指定了 $ARGUMENTS，只审查指定文件；否则审查当前分支所有改动。

1. 使用 `git diff --name-only` 获取改动文件列表
2. 逐文件审查
3. 输出审查报告
