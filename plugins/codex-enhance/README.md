# Codex Enhance

补充 Codex harness 的只读证据探索和通用子代理编排能力。

> 该插件仅支持 Codex。

## 安装

```bash
aw install codex-enhance -p codex
```

## 包含的 Skill

| Skill                                                  | 什么时候使用                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| [`codex-explore`](skills/codex-explore/)               | 代码、文档、日志或网络资料范围很大，需要隔离只读探索并汇总证据     |
| [`codex-subagent-guide`](skills/codex-subagent-guide/) | 需要实际使用通用子代理，且没有专用 Skill 负责该次调度              |

## `codex-explore`

探索必须使用 `codex-explore` 角色，该角色不可用时不委派。Skill 内按 `quick`、`standard` 和 `deep`
选择模型与推理强度；无法明确分档时使用 `standard` 偏好。显式模型要求也使用同一角色。

探索子代理负责收集和整理证据，不负责最终质量判断，也不执行产品写操作。

## `codex-subagent-guide`

该 Skill 使用显式指定的角色，否则使用 `codex-subagent`。它不决定是否应该委派，也不授予委派权限。在当前任务需要使用子代理、且没有专用 Skill 负责该次调度时，它补齐 role、model、context
fork、续接、响应式等待和条件清理策略；当前请求或上游工作流已有的有效要求保持不变。

同一交付的补充、指定修复核对或中断恢复可续接原代理，并先核对有效进度。新交付或独立全面重审使用干净代理，不把旧结论当作检查范围上限。

## 配置

```bash
aw config list codex-enhance -s user
aw config set codex-enhance standardProfile -s user --value-json '{"model":"gpt-5.6-terra","reasoningEffort":"high"}'
```

配置界面按 `codex-explore` 和 `codex-subagent-guide`
分组。保留 `quickProfile`、`standardProfile`、`deepProfile`、`simpleTaskProfile`、`generalTaskProfile`、`complexTaskProfile` 和 `advancedTaskProfile` 七个选型偏好。每个 profile 必须一次提供完整的 `model` 与 `reasoningEffort`，不合并单个属性。两个 Skill 的首次响应式等待均为至少 10 分钟，不提供等待配置项；用户明确指定单次窗口时优先遵守，并服从当前工具范围。响应式等待可在结果或用户消息到达时提前返回。

两个 Skill 仍共享同一个 canonical Codex native 插件；renderer 将 user scope 的偏好写入各自正文，两个角色只保留行为指令，不固定模型或推理强度。当前项目可以单独启用插件，但这些配置键现在只支持 user scope，不再支持 project profile 覆盖。高难档仍默认使用 `gpt-6-astra / xhigh`。

模型和推理级别分别按“显式要求 > 表格配置偏好 > 环境默认”选择，未指定或明确不可用时使用下一优先级；发生回退时说明。表格中的用户配置覆盖插件内置值；环境默认由当前子代理运行环境决定，不保证与父代理相同。

已有可见安装时，只保存个人默认会让现有 native 插件和 AW extension 保持不变。当前没有可见安装时，只保存设置，不产生 render drift。使用 `--apply --yes` 或之后运行同步，可重新生成相关输出，同时保留已有的 user 和 project activation。

旧 store 和配置不会自动迁移或删除。原有 user profile 可继续使用；原有 project profile 需要按需改设为 user profile，不会写入共享 Skill。旧的八个角色不再注册，外部指令中的旧角色名也需要更新。同步未能清理的 AW-owned 旧输出，可通过 cleanup 后重新安装恢复；无效配置层使用显式 config reset 恢复。

## 典型用法

```text
用只读探索查清支付回调可能失败的路径，给出证据和未确认项，不修改代码。
```

```text
这个任务已经允许使用子代理。帮我选择合适的角色并管理等待与清理。
```

## 维护者

插件通过 renderer 生成最终 Codex Skill 和 Agent roles。确定性测试：

```bash
pnpm plugin:test codex-enhance
```

现有 `evals/` 用例和 Oracle 保留旧版基线；其中多角色路由、fixture 与 grader 尚需适配并独立审核，不能用旧结果证明新选型策略的行为等价。

真实 Codex CLI/App 的 project activation、trust 和加载行为由独立 qualification 验证。fake manager 测试只证明 AW 的生成、配置和迁移流程。macOS Codex App 与 Windows Codex 的真实 UI 行为如果没有在对应系统运行，仍是 qualification gap。
