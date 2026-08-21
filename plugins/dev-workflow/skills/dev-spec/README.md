# Dev Spec

把已经形成的材料决定整理成可跨会话、可交接和可审查的开发规格，也可以根据 Spec Review 修订现有 Spec。

Spec 保存用户行为、范围、公共契约、数据、安全、风险和验收；局部文件、算法、测试组织和任务顺序留给实现者。

没有指定路径或仓库约定时，默认写入 `docs/dev/<task-slug>/spec.md`。完成后运行 `dev-review-spec`；Review blocked 时修订后再次运行。
