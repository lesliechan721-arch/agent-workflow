# Oracle 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v5](protocol.md) 和 [运行生命周期](runtime.md)。

Oracle 固定 bundle，使用公开 CLI 的 prompt、wait、私有输出和原始重复 --file 入口；API/browser 来自配置，不自动换引擎。effort 仅映射真实支持的引擎。Oracle 通讯开启时报告 unsupported，关闭时报告 disabled；custom bundle 也只能报告这两种状态。Oracle 对每个原始选择式传一个 --file，不预先展开、去重、拆逗号或调用 helper，不构建 AW 材料投影。原生选择必须符合 v1；已知不符合时在提交前拒绝。

文件选择规则及原生平台限制见 [文件选择与公共解析器](file-selection.md#文件选择与公共解析器)。
