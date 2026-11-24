# 外部适配器文档

本目录面向插件维护者和自定义适配器作者，维护注册配置、Adapter v6、后端实现、命令输出及运行生命周期的长期合同。普通技能调用使用 [执行器选型](../references/executor-selection.md)、[外部执行](../references/external-execution.md) 和 [通信](../references/communication.md)，不需要读取本目录。

| 文档 | 读取场景 |
| --- | --- |
| [配置与接入](configuration.md) | 查找源码入口，维护执行器配置、权限模式、任务输入和环境。 |
| [Adapter v6 协议](protocol.md) | 实现或修改 start/ready/session/message/delivery/closing/result、初始化和通讯桥接。 |
| [运行生命周期与平台支持](runtime.md) | 维护命令输出、恢复、观察与消费、停止、用户目录、可配置保留与异步清理、macOS/Linux/Windows 及安装闭包；核对验证要求。 |
| [Codex](codex.md) | 维护 app-server、CLI 来源、profile 阶段路由、黑名单、路径与 hooks 信任。 |
| [Claude Code](claude-code.md) | 维护持续会话、MCP 通讯及工具权限检查。 |
| [Antigravity](antigravity.md) | 维护 stream-json、命令通讯、精确权限和多轮输入确认。 |

公共协议与平台约束对所有适配器生效；后端文档补充各自差异。实际后端、调用工具和原生操作系统的支持范围须分别取得运行证据，不能以协议声明代替。
