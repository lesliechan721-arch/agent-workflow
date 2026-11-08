# Codex Enhance

在 Codex 中组织只读技术第二意见和大范围事实调查。当前任务负责人采用 Skill 方法，执行者直接完成有界任务。

## 安装

```bash
aw target set codex
aw plugin install codex-enhance --scope user
```

安装同时满足同 source 的 `agent-subagent` 依赖。项目启用复用个人层配置，不产生独立项目执行配置。

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| codex-advisor | 已安排技术第二意见，或重要判断卡点会影响行动。 |
| codex-explore | 需要在大范围或陌生资料中查找并核验事实。 |

```text
使用 codex-advisor，对当前兼容方案取得第二意见，并核验重要建议。
```

```text
使用 codex-explore，调查这个陌生仓库中的配置读取路径，给出可核验的文件定位。
```

Advisor 和 Explore 通过依赖插件的 `spawn-subagent` 委派。已有完整调度与生命周期方法时直接沿用。普通定位、局部修改和可直接验证的事实不需要 Advisor，少量已知文件的定向读取不需要 Explore。

## 配置与边界

专用 profiles 在本插件配置，默认 native 模型及推理强度保留：Advisor 的 general/advanced/expert 为 gpt-6-astra high/xhigh/max；Explore 的 quick/standard/deep 为 gpt-6-luna medium/high/xhigh。专用 native profile 必须提供模型与推理强度。自定义数组默认空，按顺序使用首个匹配项。

外部 executor 候选来自同 source 的 `agent-subagent.subagentCommands`。先在依赖插件中保存注册表，再选择相应 key。仅保存不更新安装资源；apply、sync 或 reinstall 后生效。不存在的 key 会使配置无效，不回退 native 或更换执行器。

咨询和调查保持只读，不修改被审或被查项目。native 角色只限制通过同一专用 Skill 重复委派同一任务，仍允许实际任务授权的其他有界协作。外部服务可能读取材料、访问网络、使用宿主认证并产生费用，须符合任务授权。有限材料只能支持相应范围的结论。

切换到新依赖插件前先结束旧 Guide 任务并保存所需结果。旧通用配置不自动复制，外部 key 须在 `agent-subagent` 注册表重新建立；不提供旧入口或旧任务续接。
