# Native 资格证据归档

可重复运行的无认证托管资格入口、候选来源及覆盖限制见 [CI 无认证 Native 客户端资格](../../../docs/maintainers/ci.md#6-无认证-native-客户端资格)。下文是固定历史证据及其原始采集限制，不是新入口的完整资格结论。

[native-skills-2026-11-10.json](native-skills-2026-11-10.json) 保存一次真实客户端观察的必要摘录。范围为 macOS 26.3.1、arm64 上的 Codex CLI `0.167.0` 和 Pi CLI `1.5.0`，只覆盖 Skills 的宿主发现、原生生命周期及 user/project scope 隔离。

归档保留 fixture manifest、精确版本输出、环境、关键原生命令、RPC 场景和来源报告 SHA-256。`sourceIndex` 可定位原报告数组中的记录。JSON 输出只解析格式空白；RPC 数组只保留本次 fixture Skill，Pi state 只保留四个运行状态字段。真实 home、可执行文件绝对路径和 native stderr 均未归档；`<TEMP_ROOT>` 表示已清理的隔离运行根。入口文件 SHA-256 只标识该入口文件，不代表完整客户端分发目录。

这些包是本次自有最小原生 fixture。它们不是 AW adapter 端到端安装产物。证据不覆盖模型行为、Skill 调用控制、MCP、Hooks、Instructions、Agents、其他客户端版本、Desktop 或其他 OS/架构。Codex 的 project false 会覆盖 user true；更新记录使用 remove/add 刷新，不代表存在 `plugin update` 命令。

本文件是固定证据，不是安装账本，也不加入默认测试、构建或发布链。原始报告和本机临时探针保留在对应开发工作项中。临时探针绑定本机入口，不能直接作为通用 runner。重新取证时，必须显式提供已安装的精确版本 binary，使用独立临时 HOME、Agent/XDG/AW 根和 workspace，保持无凭据、无 prompt、无模型请求；不得下载客户端或连接已有/远程 server。不能通过替换版本号复用旧 `0.151.0` suite 的资格结论。
