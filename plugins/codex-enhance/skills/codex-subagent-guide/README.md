# Codex Subagent Guide

为已获授权的委派选择执行配置、传递上下文，并管理等待和续接。调用方可指定 profile、角色、模型和约束；执行者直接完成任务，当前负责人核对结果。

native 直接使用宿主当前可用工具，默认干净上下文。配置或角色更新后，宿主可能需要受支持的刷新或新会话。普通有界任务可直接使用本 Skill；只讨论是否委派或只需完成已分配工作时通常不需要。

workspace / bundle 外部执行采用前台调用。例如：

```bash
node scripts/subagent.mjs run \
  --profile generalTaskProfile \
  --instructions-file assets/task-instructions.md \
  --prompt-file <task.md>
```

profile 须选择已注册的外部执行器。[外部调用说明](references/external-delegation.md)会随生效配置列出执行器 key、模式和能力，普通调用无需先运行 preview。指令文件可使用本 Skill 的默认资源或本次自定义文件，其正文进入独立指令通道。workspace 默认当前目录；bundle 仅包含 `--file` 明确选择的文件。费用、材料外发和写入使用本次实际许可。

等待超时继续同一宿主 session 或原生 handle，不重新生成。前台外部调用不能脱离宿主，也不支持跨父会话恢复；终态缺失或远端停止不明时报告 unknown。调用后修改配置或输入文件不替换本次已读取的输入。

外部任务须明确携带必要项目约束。所需权限和技术隔离不受支持时会报告限制，不能用指令文字替代真实工具权限。保存配置须 apply 后才对新调用生效；安装资源缺失或损坏时通过正常 sync 或 reinstall 恢复。

执行方法见 [SKILL.md](SKILL.md)。
