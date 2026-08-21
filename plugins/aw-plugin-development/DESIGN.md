# AW adapter 设计

## 为何使用两个 Skill

`author-aw-plugin` 与 `review-aw-plugin` 保持分离，因为它们具有独立的用户意图、不同的权限、不同的证据生命周期，以及有意设置的 clean-context 边界。单一 `aw-plugin` Skill 会再次产生过去的职责过载。

## 三层依赖

- `agent-content-toolkit` 负责编写 Agent-facing 文本，以及只读内容和 reference 评审。
- `agent-skill-toolkit` 负责编写和评审通用 Agent Skill，以及设计和审核 Eval。
- 本插件负责 AW manifest、source/final 映射、构建、materialization、工作区 Eval runtime 和报告发布适配。

依赖方向严格向上：通用 toolkit 不会指定或依赖本 adapter 插件。两个 adapter 都会检查所需的下层 Skill，缺少任一能力时停止；它们不携带备用量表。

## 可移植工作区边界

AW 插件根由自身的 `.agents-plugin/plugin.json` 标识，而不是由固定 monorepo 路径标识。目标工作区可以把插件放在 `plugins/`、`packages/`、`tools/` 或其它显式根目录中。工作区专有的构建和发布命令从该工作区发现；可复用的作者策略保留在本插件 bundle 中。已安装的 CLI 通过 `--plugin-root` 接收该根目录；该路径相对于 `--repo-root` 解析，并限制在同一 Git 工作区内。只有 CLI `--all` 版本 gate 保留标准 `plugins/` 扫描。

## 隔离阶段

以下阶段在非平凡时使用 fresh context：

- 通用 Skill 编写；
- Eval 设计；
- Eval Oracle preflight；
- reference/content 审计；
- source 和 materialized final 评审；
- Eval 结果归因。

当前 harness 或 delegation Skill 选择具体的子代理机制。阶段输出必须是 schema-valid artifact，不能只是父上下文中的文字摘要。产物存在不等于阶段完成：final Skill tree 存在不表示它已通过评审。
