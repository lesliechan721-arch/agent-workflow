# Invocation 与 description

先决定调用意图，再写 description：

- `model`：模型依据用户意图自动选择；
- `manual`：用户或上层工作流显式调用；
- client-specific：仅在目标客户端确有独立调用语义时使用。

区分三个文本：

- 插件或包说明：解释整体产品能力；
- Skill discovery description：只描述用户何时需要该 Skill；
- UI short description：简短展示，不承担触发边界。

description 以用户意图和交付结果开头，覆盖现实正例和高价值 near-miss。不要堆内部步骤、工具参数或正文身份。修改 description 时同步检查相邻 Skill 竞争和 trigger cases。
