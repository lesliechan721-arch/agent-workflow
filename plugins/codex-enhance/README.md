# Codex Enhance

为 Codex 提供大范围只读证据探索和已授权子代理任务编排。

## 什么时候使用

- 需要从大型、陌生或边界不明的代码、文档、日志、网页或用户材料中筛选证据。
- 子代理委派已经获得授权，需要选择合适的任务类型、模型参数、上下文和等待方式。

不适用于少量已知文件的定向读取，也不用于自行授予子代理权限。

## 包含的 Skills

| Skill | 用途 | 调用方式 |
| --- | --- | --- |
| `codex-explore` | 在大范围材料中执行只读证据探索 | 自动或 `$codex-explore` |
| `codex-subagent-guide` | 管理已经获准的通用子代理委派 | 自动或 `$codex-subagent-guide` |

插件还提供 quick、standard、deep、custom 探索角色，以及简单、通用、复杂、计划与审核任务角色。

## 快速开始

```bash
aw install codex-enhance -p codex -s user
```

示例请求：

- “在这个陌生 monorepo 中查清认证配置从入口到运行时的完整路径，并给出文件证据。”
- “子代理委派已经允许，帮我为实现、审核和简单验证选择合适的角色。”

## 平台与安装范围

只支持 Codex。user scope 和 project scope 都可用。

## 配置

可以在 AW 仪表盘的插件配置页修改模型、推理强度和首次等待窗口，也可以使用 CLI：

```bash
aw config set codex-enhance standardModel gpt-5.6-luna -s user
aw config set codex-enhance standardReasoningEffort high -s user
aw config set codex-enhance minimumInitialWaitMinutes 10 -s user
```

## 权限和边界

- `codex-explore` 只有在 Gate 通过时才启动只读探索子代理；最终判断、建议和写操作留在主代理。
- `codex-subagent-guide` 只管理已获授权的委派，不判断或扩大授权。
- 实际可访问的文件、网络和工具仍受当前 Codex 会话权限限制。
