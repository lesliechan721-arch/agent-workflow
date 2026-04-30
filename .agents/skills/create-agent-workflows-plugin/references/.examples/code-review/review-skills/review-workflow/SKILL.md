---
name: review-workflow
description: 当用户要求执行完整代码审查工作流时，串联检查步骤并生成结构化报告。
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: 完整代码审查工作流
---

# Code Review

在 {{platformName}} 上执行结构化代码审查。

## 执行步骤

1. 检查 AW config 中的 `reviewMode` 和 `maxFilesPerReview`，按配置确定审查范围
2. 获取待审查的文件列表（`git diff --name-only` 或用户指定）
3. 对每个文件执行审查，检查：逻辑正确性、安全隐患、性能问题、可维护性
4. 按严重程度分类记录问题
5. 生成结构化审查报告

{{#if supportsCommands}}
用户也可以使用 `/review` 命令快速启动审查。
{{/if}}

## 边界

- 不要自动修改代码，只报告问题
- 遇到无法解析的文件格式时跳过并说明
- 不要在回复、日志或命令输出中展示 `reviewServiceApiKey`
- 单次审查超过 50 个文件时，先确认范围
