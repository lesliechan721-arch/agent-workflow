# AW preApply

实现安装前环境校验或外部系统工具安装时使用。先查询 `aw plugin capabilities --json` 中的实际支持与字段；当前入口是 `scripts.preApply`，不是 postApply。AW 插件依赖用 manifest `dependencies`，Node 依赖在 build-time bundle 中解决。

脚本以 plugin root 为 cwd，用 Node 执行，从 stdin 读取当前 `PreApplyContextV1`。只使用其 plugin、target 和有效 config；context 不提供平台 home、store path、artifact 内容或私有运行状态。不要据此猜测现场路径。

- CLI 在执行前完成 TUI Review 确认，或消费直接命令的明确授权；脚本不另建确认协议。
- 每个 target 在一次命令中最多执行一次，脚本须幂等并等待自己启动的子进程结束。
- 它在目标只读 preflight 后、任何 stale cleanup 或 AW-owned 写入前执行。非零退出、超时或启动失败会阻止该 target 的 cleanup 和写入；其它 target 可继续。
- 它参与 install、sync、reinstall 和 `config ... --apply`；不在 cleanup、uninstall、status 或 Review preparation 中运行。
- AW 不回滚成功的外部动作。失败输出须脱敏，保留通过 sync 或 reinstall 重试的恢复方式。

时限和覆盖参数从当前公开帮助取得；未知脚本先审查。测试使用隔离目录和受控外部工具，不读取或修改用户真实安装。
