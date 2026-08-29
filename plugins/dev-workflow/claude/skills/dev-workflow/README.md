# Dev Workflow

按保障等级和生命周期 gate 组织开发任务。它从最早未满足阶段继续，不把用户的“实现”措辞直接等同于 implementation-ready。

Shape 阶段只调用 `decision-shape`；该 Skill 的内部问答和 Prototype 组合不由本入口管理。

固定生命周期是 Shape → Spec → Spec Review → User Approval → Build → Code Review → Delivery。Fast / Standard / Assured 只决定需要经过哪些 gate 和保障强度，不直接决定当前 Skill。

只有用户可观察结果、范围与非目标、验证方式都清楚，且没有材料未决、体验证据需求或高风险时，任务才可以走 Fast。新功能请求没有 Shape、Spec 或明确验收时，会先进入 `decision-shape`。

其它专业 Skill 仍可被直接调用。路由时会简短说明当前保障、阶段、下一能力和依据。
