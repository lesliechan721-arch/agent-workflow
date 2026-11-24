# Spawn Subagent

本 Skill 用于**实际委派**：选定原生或外部执行器与配置、准备隔离任务上下文、等待与续接，并亲自核验结果。核心方法见 [SKILL.md](SKILL.md)。

按决策阶段与配置按需读取资料（未配置外部执行器且无自定义档位时，渲染产物会自动省略无关参考）：

- 需要按任务难度选档、按厂商/平台/模型偏好匹配、筛选异构执行器或运行 `inspect` 自省选型时，读取 [选型与自省](references/executor-selection.md)。
- 选定非 `native` 外部执行器后，读取 [外部执行协议](references/external-execution.md)：`start`/`wait`/`result`/`stop`、共用回执格式、三态 `--instructions-file` 与预算边界。
- 需要向运行中外部代理发消息（`communication=true`）、恢复已结束任务（`resume=true`），或收到过程消息与投递缺口时，读取 [通讯与恢复](references/communication.md)。
- [任务指令](assets/task-instructions.md) 为中性默认角色正文，供无专属角色时的原生委派与省略 `--instructions-file` 的外部委派共用。
