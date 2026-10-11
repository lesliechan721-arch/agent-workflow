# Codex Subagent Guide

为已获授权的委派选择执行配置、传递上下文并等待结果。调用方可指定 profile、角色、模型和约束；执行者直接完成任务，当前负责人核对结果。

适用于需要实际委派的有界任务。只讨论是否委派，或执行者只需完成已经分配的工作时，不要使用本 Skill。已有完整调度与生命周期策略时，直接沿用，不要加载或使用本 Skill。

native 直接使用宿主可用工具与角色，默认干净上下文。外部模式可以使用内建 Codex、Claude Code、Oracle 或自定义适配器。配置或角色更新后，宿主可能需要刷新或新会话。

外部短任务可以直接传入提示词。在任务目录执行，并把示例中的 Guide 路径换为实际安装路径：

```bash
node /absolute/installed/guide/scripts/subagent.mjs run \
  --profile generalTaskProfile \
  --prompt '检查指定模块的错误处理，说明依据；不要修改项目。'
```

profile 需要选择已配置外部执行器。长任务可用 --prompt - 从 stdin 输入；--instructions-file 可选，不传时不会自动补入角色指令。已有通用角色可复用 [task-instructions.md](assets/task-instructions.md)。

workspace 不接受 --file，关注路径写进任务；bundle 使用 --file 按固定的 AW 文件选择协议 v1 选择文件、目录或 glob，各适配器承担同一规则的实现责任。preview 只展示未解析选择式，不检查匹配文件或冻结后续内容。

结果包含调用状态和完整回答，当前负责人仍须核对业务完成情况。等待超时继续同一 session，不重复生成；终态或远端停止不明时报告 UNKNOWN。前台调用不保证脱离宿主或跨会话恢复。

外部调用可能使用网络、认证和模型额度。项目写入、材料外发及必要临时分析写入都使用本次实际许可。模式、文件选择和只读指令不提供技术隔离保证。保存设置须 apply 后才对新调用生效；资源缺失或损坏可通过正常 sync/reinstall 恢复。

执行方法见 [SKILL.md](SKILL.md) 和 [外部调用说明](references/external-delegation.md)。
