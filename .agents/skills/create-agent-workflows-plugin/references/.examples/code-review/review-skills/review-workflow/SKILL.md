---
name: review-workflow
description: 当用户要求代码审查时，按固定步骤检查改动并输出简要报告。
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: 完整代码审查工作流
---

# Code Review Workflow

在 {{platformName}} 上执行代码审查。这个源码 skill 展示实际工作流应放在 `skills/` 中；公共 `/review` 命令只是手动入口。

## 执行步骤

1. 确认审查范围：用户指定路径优先；没有指定时查看当前分支改动
2. 阅读 diff 和相关上下文
3. 按 `references/review-rules.md` 检查正确性、安全、性能和可维护性
4. 按严重程度输出问题、建议和测试缺口

{{#if supportsCommands}}
用户也可以使用 `/review` 命令快速启动这个工作流。
{{/if}}

## 输出格式

```markdown
## 审查摘要
- 范围：<审查范围>
- 结论：<通过 | 需要修改>

## 发现的问题
- [严重程度] <文件:行> <问题与建议>

## 建议补充
- <需要补充或运行的测试>
```

## 边界

- 不要自动修改代码，只报告问题
- 不要在回复、日志或命令输出中展示 `reviewServiceApiKey`
- 审查范围过大时先请用户确认
