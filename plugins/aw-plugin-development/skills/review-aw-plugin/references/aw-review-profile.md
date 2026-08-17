# AW project review profile

项目专有检查：

- `.agents-plugin/plugin.json` 与声明能力一致；
- source、renderer/config 和 final artifacts 可追溯；
- default 与会改变制品的 non-default profile 被区分；
- Codex/Claude 元数据按实际产品裁剪；
- user materialization 不冒充真实模型运行；
- historical report 与 current evidence 通过 commit、dirty state 和 package digest 区分；
- 源码 manifest version 与 production bundle 变化一致。

这些结论进入项目 gate，不复制通用 Skill 维度。
