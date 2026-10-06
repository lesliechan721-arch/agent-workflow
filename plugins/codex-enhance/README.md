# Codex Enhance

在 Codex 中组织通用委派、技术第二意见和大范围事实调查。当前任务负责人使用协调 Skill，实际执行者直接完成有界任务。

## 安装

```bash
aw install codex-enhance -p codex
```

仅支持 Codex 宿主。项目启用复用用户级共享 Skill 配置；它不会产生独立的项目执行器配置。

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| `codex-subagent-guide` | 任务已允许委派，需要选择执行配置、传递上下文、等待或恢复 |
| `codex-advisor` | 明确需要技术第二意见，或重要取舍出现有依据的判断卡点 |
| `codex-explore` | 需要在大范围或陌生资料中查找并核验事实 |

Advisor 和 Explore 通过 Guide 执行各自的委派。普通有界任务可以直接使用 Guide；少量已知文件的定向读取通常直接完成。

## 典型用法

```text
使用 codex-subagent-guide，把这项已授权的有界实现交给一个执行者。
```

```text
使用 codex-advisor，对当前兼容方案取得只读第二意见，并核验会改变行动的建议。
```

```text
使用 codex-explore，调查这个陌生仓库中的配置读取路径，给出可核验的文件定位。
```

## 配置与执行

保留四个通用 profile 和三个探索 profile。`advisorProfile` 是独立配置；默认模型候选为 `gpt-6-astra` / `high`，其实际可用性以当前执行环境为准。每个 profile 使用 `native` 或 `subagentCommands` 中的稳定 key。执行器表默认空，因此默认配置不会启动外部服务。

`advisorPolicy` 默认为 `conservative`，同一父任务最多两次咨询；`manual` 只采用明确安排的咨询，`off` 需用户重新启用。策略不提供委派、费用或资料外发许可。

保存后的配置须 apply 才供新调用使用。staging 或校验失败保留原投影；平台写入开始后可能部分成功。配置、角色或运行资源版本不一致时，新调用拒绝执行，可通过 sync 或 reinstall 恢复。

原生执行需要当前宿主实际加载角色版本的可验证依据。仅有安装文件或插件名称不足以证明已加载。未验证的宿主刷新行为和外部适配器能力保持不支持或未验证状态。

附带的独立 Codex 适配器以 CLI `0.160.1` 为候选，只允许只读任务。用户和项目的 execpolicy `.rules` 继续生效。自动加载项目 `AGENTS.md` 已关闭；任务须携带必要项目约束。Codex home 的用户指令仍可能加载。

它目前不支持精确会话续接、可确认的远端取消或技术强隔离；MCP、hooks、remote 和不能安全处理的 inline/multiline TOML 配置、含转义的 TOML key 会被拒绝。真实环境资格仍需独立验证。

## 边界

- 通用任务默认只读，写入取任务授权与实际工具权限的交集。
- Advisor 和 Explore 的执行者只读，不能再委派；建议和候选 patch 不等于已实施。
- 外部执行器是受信任的本地程序，可能使用网络和产生模型费用。配置程序与本次资料许可分别成立。
- workspace 提供允许的访问起点；bundle 只提供选定的当前材料。只读指令不单独证明技术隔离。
- 等待或查询原任务不发起第二次生成；运行状态不明时保留原任务，不能自动换服务重试。
