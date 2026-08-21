# 脚本和确定性资源

仅当目标包含脚本或重复实现确定性逻辑时读取本文档。

## 脚本职责

适合脚本的任务包括解析、转换、生成、计算、格式验证、静态一致性检查、重复批处理操作和可机械检查的断言。

不要让普通脚本通过文件、Git 或 shell 轮询来推断实时 Agent 状态、mailbox delivery、取消、并发、权限或 runtime 生命周期。

## Agent-facing 脚本检查

- 使用相对于 Skill 根的路径，并说明调用脚本的 branch；
- 声明 runtime 和依赖，保持接口非交互；
- 提供 `--help`、可操作的错误和有意义的退出码；
- 保持 stdout 稳定且结构化，将诊断写入 stderr；
- 限制输入、输出、timeout、路径遍历、覆盖和敏感数据；
- 对破坏性操作优先提供幂等性和 dry-run；
- 提供 fixture、测试或安全样例。

在判定接口缺陷前，读取 import、参数解析、副作用调用和 main dispatch。只有静态检查证明 help branch 会在副作用前退出后，才能运行 `--help`。环境故障属于 `unknown`，不能证明接口不存在。

## Reference 和 Agent-facing 文本

权威的 reference、pointer、active path、co-location 和渐进式披露审计由 `review-agent-content` 负责。本 Skill 只检查包专有的可达性并消费其 `ReferenceAuditResult`，不维护第二份 reference checklist。
