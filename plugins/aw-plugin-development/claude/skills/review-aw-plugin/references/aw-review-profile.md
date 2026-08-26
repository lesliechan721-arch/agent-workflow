# AW 项目评审 profile

项目专有检查：

- workspace 根由调用方显式提供；所有 `aw plugin validate` 调用使用 `--workspace-root`，不依赖 Git 或当前目录；
- target 发现器先完成公开 plugin validate；失败时不读取 manifest 派生的 source/final collection；
- 插件根、`.agents-plugin`、source/final Skill collection 根必须是普通目录，不跟随 symlink；
- manifest 未声明 `skills` 时保留插件级 composition gate，并把 leaf inventory 记录为空；

- `.agents-plugin/plugin.json` 与声明能力一致；
- source、renderer/config 和 final artifacts 可追溯；
- default 与会改变制品的 non-default profile 被区分；
- Codex/Claude 元数据按实际产品裁剪；
- user materialization 不冒充真实模型运行；
- historical report 与 current evidence 通过 commit、dirty state 和 package digest 区分；
- 源码 manifest version 与 production bundle 变化一致。

这些结论进入项目 gate，不复制通用 Skill 维度。
