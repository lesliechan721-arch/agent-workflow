# Plugin Component Branches

字段和可用 surface 始终来自 `aw plugin capabilities --json`、对应 `--surface` 与命令 `--help`。本文件只记录 owner 和验证原则。

## Extension / hooks / permissions / agents

- manifest 声明真实 capability；权限取最小集合；
- 只修改 source，不手改平台生成文件；
- hooks 的触发、输入和副作用必须有 deterministic test；
- Agent/role 内容使用 `agent-content`，固定模型配置不得与调用方显式要求静默冲突。

## Slash command

- 命令是明确用户入口；参数和副作用在命令文档中前置；
- manual-only 与 model-callable 属性按目标客户端实际支持设置；
- 生成的 Claude/Codex 命令必须由 materialization 测试验证。

## MCP / App

- server、command、env、auth 和 network 要求由 manifest/CLI 合同拥有；
- 不把凭据值写入 Skill、日志或物化产物；
- 启动、健康和清理使用实际 runtime/CLI，不用 prose 模拟状态。

## Config / helper

- schema、preset 和作用域由 AW 配置合同拥有；
- Agent 内容只记录非显然选择和项目约定；
- helper 输出必须是确定性、可测试且最小的 runtime dependency。
- 已安装配置 reader 由 AW 在最终 Skill 中注入；从真实调用位置读取本产物的生效值，不读取最新 store。声明与兼容要求从当前 capability 查询取得；不要自建保留文件或内容一致性门禁。

## Dynamic artifact / runtime imports

- 实现 renderer 时读取 `references/aw-artifact-renderer.md`，保留请求 ID、配置隔离、敏感值和 portable surface 的边界；
- renderer 只消费声明的 source 和 runtime imports；用 context 的 `artifactSources` 读取当前 surface/scope 的 Skill 静态资源，不猜测 bundle 私有路径，不扩大请求配置或输出；
- platform×scope final 必须 materialize 后验证；
- artifact 的 Skill 内容仍使用 `author-agent-skill`/`agent-content`，不要在 renderer 中复制第二套标准。

## preApply

- 当前合同是 `scripts.preApply`；实现时读取 `references/aw-pre-apply.md`；
- 用于环境校验或安装外部系统工具，在目标 preflight 后、任何 cleanup 或 AW-owned 写入前执行；
- 脚本必须幂等，失败阻止该 target 的写入；外部动作不承诺回滚，恢复由 CLI 合同拥有。

## README

- 只写用户可观察能力、安装/使用、权限和限制；
- 不复制 manifest 字段全集或内部生成算法。
