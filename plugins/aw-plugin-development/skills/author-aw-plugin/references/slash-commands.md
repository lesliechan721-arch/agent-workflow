# Slash Command 作者策略

字段合同读取 [CLI 生成的能力视图](slash-command-capabilities.generated.md)。公共 slash command 是显式快捷入口；复杂、可复用且需要模型判断的流程放在 Skill 中，command 只负责启动它。

一份源码只生成支持产品的产物。Claude-only 参数或命令填充必须通过平台模板隔离，不能残留到 Codex。Codex generated Skill 固定 manual-only。资源只引用 command `assets/` 下的真实文件。
