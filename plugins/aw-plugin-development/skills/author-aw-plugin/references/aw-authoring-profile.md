# AW Authoring Profile

先确认插件根、工作区根、支持产品、允许修改文件、现有能力和调用策略。`.agents-plugin/plugin.json` 是插件源码真值；generated runtime、Catalog 和 cache 不由作者手改。

按用户目标选择最小能力：模型判断和多步骤流程用 Skill；常驻静态规则用 extensions；显式快捷入口用 slash command；外部工具连接用 MCP/App；配置驱动的平台输出用 dynamic artifact。不要预建未请求能力。

多组件或 manifest 能力变化时，使用本 Skill 的结构化 context 工具。`components[]` 必须完整，且每个组件有 source path、产品/scope 和验证入口。轻量 Skill 正文修改不需要重新构造全插件计划。

完成条件：源码声明与真实文件一致；能力没有重复 owner；README 描述用户可观察行为；运行目标工作区公开的 validate、status、build/test/materialization 入口；报告未验证项。独立 Review、模型 Eval 和发布不自动进入作者范围。
