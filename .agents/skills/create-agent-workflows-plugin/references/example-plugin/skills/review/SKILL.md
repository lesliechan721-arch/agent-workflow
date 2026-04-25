---
name: review
description: 当用户要求审查代码、检查代码质量或生成审查报告时，执行完整的代码审查工作流。
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: 自动化代码审查工作流
---

# Code Review

在 {{platformName}} 上执行结构化代码审查。

## 执行步骤

1. 获取待审查的文件列表（`git diff --name-only` 或用户指定）
2. 对每个文件执行审查，检查：逻辑正确性、安全隐患、性能问题、可维护性
3. 按严重程度分类记录问题
4. 生成结构化审查报告

{{#if supportsCommands}}
用户也可以使用 `/review` 命令快速启动审查。
{{/if}}

## 边界

- 不要自动修改代码，只报告问题
- 遇到无法解析的文件格式时跳过并说明
- 单次审查超过 50 个文件时，先确认范围
