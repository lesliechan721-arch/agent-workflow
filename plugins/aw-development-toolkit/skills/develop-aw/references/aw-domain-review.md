# AW 领域检查依据

判断 AW 组件组合、依赖或平台差异时按范围读取。来源、snapshot 状态、实际包证据和修改归属使用 [来源与运行包](source-materialization.md)；本文件补充 AW 对象之间的检查依据，不自动启动专项 Reviewer。

## Plugin、组件与 profile

核对 manifest 中的组件 key、静态 source、动态 target、共享输入与所选 profile 是否对应。单 Skill 关注其必要来源；Plugin 范围还需检查容器声明能否支持这些组件，以及组件的配置与 scope 是否相容。

同一公开能力在各 surface 的权限、model-callable/manual-only 策略和必要环境应符合声明。涉及组件或配置采用 [组件方法](plugin-components.md)，平台字段、文件投影和能力要求采用 [平台投影](platform-projection.md)。

## 依赖与共享输入

沿实际消费者区分安装 dependency、build import、Skill runtime file import 和 artifact runtime import。按 [构建与共享](build-and-sharing.md) 核对每条边的 provider、消费者、消费阶段及 capability 传播；构建复用不自动证明安装依赖成立。

检查共享文件是否进入所选 Native/Portable surface，以及运行依赖是否在目标环境可用。导出声明采用 [Portable 分发](portable-skills.md)；原生组件的宿主能力不能直接外推到 Portable。

## Catalog 与公开能力

使用静态 inspection 和返回的 source/metadata 核对 identity、inventory、依赖图、version 及已有 snapshot。Catalog identity、组成或 snapshot 的结论不证明 leaf/profile 的内容质量；需要 leaf 证据时才补齐相应产物。

检查各公开入口的安装依赖是否支持其独立使用，以及 source、当前 snapshot 与已验证 final 的公开组件和调用策略是否对应。

版本、依赖或删除操作使用 [Catalog 维护](catalog-development.md)。只读评审中发现状态缺口，不隐式修改 Catalog 或激活开发源。
