# Plugin Source 开发与验证

先固定用户明确的 Workspace/Plugin 路径；从 canonical `<root>/plugins/<name>` 或公开 CLI 确认归属，不从任意 cwd 猜目标。歧义停在发现阶段。未初始化 Workspace 只在用户请求时运行公开 catalog init；普通 plugin 修改不隐式初始化别处。

创建插件用 `aw plugin init`，不要预建空目录。字段、组件面与参数从当前 `aw plugin capabilities --json` 及公开帮助读取。只改 source truth，不直接改 generated runtime、snapshot、ledger 或 digest。Plugin version 按项目发版约定维护源码 manifest 的稳定版本；Catalog version 使用公开 `aw catalog version`，两者分开。

Plugin 内 Skill 创建或常规变更使用 `author-agent-skill`，只传用户目标、允许路径和验收条件；明确要求简化时读取 `skill-simplification.md`，由 `simplify-agent-skill` 负责候选对照。Agent 文本使用 `agent-content`。

requirements 的 declared/derived/detected/effective 由 CLI 计算；动态能力无法静态发现时才补声明。具体组件涉及 hooks、MCP、renderer、preApply 等时读取 `references/plugin-components.md`。

变更后执行当前 CLI 对应单插件 validate/test/build，按影响验证反向依赖及 Catalog 聚合；用户仅请求局部改动且不用聚合产物时，报告聚合检查未执行，不假装已完成。版本和发布元数据是 source，远端 publish 永远不是本 Skill 的默认步骤。

动态/多 profile Skill 应构建后验证实际 platform×scope final，分别保留可编辑源与产物路径。需要为质量评审单独取得运行包时，使用公开 `aw review prepare --help` 指定本次目标、profile 和隔离输出；实际可用参数以帮助为准。交付返回的 final 与来源绑定，依赖、引用和调用 metadata 在该 final 检查。准备能力或所需配置不可用时，说明已完成的源码检查及未验证产物。
