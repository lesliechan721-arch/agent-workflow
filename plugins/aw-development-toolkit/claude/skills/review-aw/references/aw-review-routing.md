# AW Review Routing

从用户路径、已有 verified root 或公开 CLI 固定一个 Workspace。目标支持 Plugin root、其 manifest、单个源 Skill root、SKILL.md，以及明确的动态 Skill source/target 选择；有歧义时先确定对象。

单个源 Skill 的依赖和构建声明由所属 Plugin 解释，评审范围仍只覆盖所选 Skill 及必要共享输入。用户已给可消费的 final 且只要求包质量时，可直接使用通用 Reviewer；需要核对其是否代表当前 AW 源码时再做来源核验。

| 用户问题 | 范围与所需视图 |
| --- | --- |
| 当前源码设计、文字或组织 | source-design；只根据可见内容下结论 |
| 最终 Skill 包是否完整、平台行为是否正确 | 对应平台/scope/config 的 final；缺少时进入准备 |
| manifest、组件和依赖关系 | plugin；source 与相关 final 分别提供 |
| Workspace identity、inventory、已有 snapshot | catalog |
| 多插件完成一个用户结果 | 有界 workflow |
| 公开入口与安装/依赖颗粒度 | portfolio |

Profile 采用用户选择或当前项目明确目标；多个候选环境未确定时澄清一次。已有某个 profile 的成功不覆盖另一个。目标超出本次范围时只列出边界和未覆盖部分。
