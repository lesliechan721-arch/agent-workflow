# 外部委派

选定 workspace 或 bundle 后读取。使用当前 Skill 实际安装位置的 `scripts/subagent.mjs`；参数和操作通过该入口的 `--help` 核对。

## 准备与启动

1. 核对注册入口、当前 revision、任务访问范围、数据目的地和费用许可。配置可用与本次授权是不同条件。
2. 将完整自然语言任务保存到私有任务文件，选择实际需要的原始材料。workspace 可以在授权范围补读；bundle 只提供选定材料，并保留原路径和行号映射。仅有入口文件却需要遍历未知仓库时，先补足可达性。
3. 先用 preview 核对实际材料和执行设置，再按相同目标启动；材料或目的地改变时重查许可。执行入口从可信绑定取得角色指令，分别传递指令、任务和材料。

```text
node <guide-root>/scripts/subagent.mjs run
  --profile <已选key> --worker <已绑定key>
  --workspace <绝对目录> --prompt-file <私有任务文件>
  --expected-revision <当前值>
  [--model <明确的本次型号>] [--reasoning-effort <明确的本次强度>]
  [--file <工作区相对文件>]... [--access workspace-write]
  [--allow-material-transfer] [--allow-model-cost]
```

只有已有资料处理许可或费用许可时才传相应 `--allow-*` 参数。复用本次已有授权，不按调用次数重复确认。preview 采用同一入口并增加 `--preview`，不启动适配器或模型。

本次显式 model 与 reasoningEffort 分别优先于 profile 偏好；后端不支持明确要求时报告限制，不自动换型号、强度或服务重试。没有设置且允许后端默认的参数按接口省略。

默认只读；写入要求任务授权、角色上限、执行模式和适配器能力同时允许。严格权限隔离需要实际技术保障。遇到不支持的角色指令通道、明确参数或必要隔离时，返回能力缺口。

注册本插件附带的独立 Codex 候选适配器时，使用 `scripts/adapters/codex-v2.mjs`，目标 CLI 版本为 `0.160.1`。当前限只读。用户和项目的 execpolicy `.rules` 继续生效。自动加载项目 `AGENTS.md` 已关闭；任务须携带必要项目约束。Codex home 的用户指令仍可能加载。

该适配器不支持 resume、可确认的远端取消或技术强隔离；MCP、hooks、remote 或适配器不能安全处理的 inline/multiline TOML 配置、含转义的 TOML key 会在生成前拒绝。候选版本与支持声明不等于真实资格或模型可用性证据。

## 等待与收尾

保留宿主执行 handle 与 runner 的 run ID。宿主等待窗口、runner deadline 和服务超时分开处理；等待超时继续同一请求，运行事实未知时先恢复该 run，避免重复副作用和重复付费。

默认 run 在后台继续。在公共 Eval Engine 管理的调用中，supervisor 和适配器保留父进程组，运行受父执行范围的生命周期限制。父范围结束时可能停止仍活跃的任务；不能把跨 Eval 动作存续当作已支持能力。共享进程组只按已观察的后代及原 PID/start 跟踪本次停止范围，不将父进程或同组其它任务纳入。此观察不是技术强隔离，未确认的停止仍保留 unknown。

取消以实际进程树及必要远端停止证据为准，无法确认则保持 unknown。当前入口不支持 resume；查询和 collect 只取回原 run。补问或重新提供材料的新调用按新生成与原有预算处理，不能把状态不明的任务当作可重新提交。

正常退出、真实服务终态、非空最终结果和相容的 v2 程序回执都具备时，才报告执行完成。partial、空输出、仅 session ID、受理通知或无从确认的远端状态分别说明。自然语言中的受阻或证据不足仍是业务限制，不由 runner 据标题判通过。

保留本次需要的结果和诊断；清理范围仅限本次拥有且不再使用的运行文件。当前调用的恢复和取消保持原执行器、角色、材料及 revision，不随后续配置修改转向另一服务。
