# Composition Fitness Audit

## 组合轴

| 轴 | 问题 |
| --- | --- |
| Independent intents | 一个 Skill 是否包含可被用户独立请求的多个结果？ |
| Permission modes | 一个 Skill 是否混合只读、写入、高成本执行或发布权限？ |
| Evidence lifecycles | 作者、Oracle、运行证据和独立裁决是否被同一 Skill 同时拥有？ |
| Environment profiles | 通用 Skill 是否混入单一项目、客户端或 runtime 适配细节？ |
| Context phases | 是否有某个 branch 需要独立上下文，且应由相邻 Skill 承接？ |
| Stable handoffs | 拆分后是否可以用短、必要且稳定的输入输出通信？ |
| Dependency direction | 可复用 standalone/leaf 是否反向依赖 caller 或 orchestrator 拥有的目录、生命周期、阶段、状态名或后续能力？ |
| Output consumer boundary | 固定输出字段是否有 parser、持久 artifact、独立 actor 或明确的人类决策用途？ |

## Verdict

- `coherent`：一个独立用户意图，权限和证据生命周期一致。
- `composite-proportionate`：多个不能独立触发的紧密 branch，共享大部分上下文。
- `overloaded`：多个独立意图或权限、证据、profile 不对称。
- `orchestrator-needed`：应拆成多个 Skill，由薄入口只管理顺序、授权和最小 handoff。

## 强拆分或过度工程化信号

- 创建或修改与独立 Review 混合。
- Eval case 设计与 Oracle 审核或运行混合。
- 通用规则与项目 build、materialization 或 publish 混合。
- 长时间执行或状态管理与结果裁决混合。
- 多个 branch 可独立触发且典型请求只需要其中一个。

## 停止规则

若一个 Skill 含多个可独立触发的用户结果、权限或证据生命周期，先给最小职责拆分；不要通过增加更多分支和门禁维持单体。

Author 在写正文前完成判定。需要 orchestrator 时，入口只拥有顺序、授权和最小 handoff；可重算事实不形成持久模型合同。
