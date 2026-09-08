# Public Surface Review

## Intent families

先按用户语言归并动作，例如 author、review、simplify、audit、run、publish，而不是按内部 target 目录归并。

## Public Skill Admission

每个入口回答：

- 用户会直接请求该结果吗？
- 其它 Skill 是否需要调用它？
- description 能否与相邻入口稳定区分？
- 它是用户结果还是内部对象分支？
- 权限或证据生命周期是否独立？
- manual-only 是否被错误当作依赖？
- facade 能否无损选择它？

同一动作仅因 plugin/catalog/reference 等对象不同而拆分时，优先 facade + references。

## Plugin boundary

独立插件需要至少一个理由：独立安装价值、运行依赖、安全/成本、分发受众或发布节奏。仅源码目录不同不足以拆插件。

## Common-path cost

在内容层两种负担原则上，记录本 portfolio 的公开 descriptions、用户入口选择、依赖深度、实际 Skill 调用和独立上下文阶段。比较人需要掌握的内部对象与 Agent 真正读入/导航的材料，不将两者混为一个分数。保留必要人工判断与授权；目标不是把所有入口自动化或把总数量降到最少。

## 不机械奖励拆分

按用户动作/对象区分是一种工具包设计启发，不是硬规范。只有减少的上下文、独立权限/证据价值超过新增发现、导航和维护成本时才拆。不能因为每个分支能起名字就创建 Skill；也不能因入口少就认定 facade 合理。公开调用不意味着调用次数越多越好。

Skill 调用和输出必要性使用共享规则；本文件只拥有整个公开能力面的权衡。检查共享标准是否放在正确领域层，不能因为所有 Skill 都受益，就把 Skill 机制下沉到所有 Agent-facing 文档。安装体积和一次会话的实际读入量分开。
