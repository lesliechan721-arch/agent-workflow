# 原生工具

为托管命令或 Node 插件测试声明宿主工具协议，或处理工具依赖缺失时读取。完成主 Skill 的兼容性检查后，查询 `aw plugin capabilities --surface native-tools --json`；字段、限制和错误由当前 CLI/Core 提供。

## 声明与构建

使用 `aw.native-tools.v2`。`nativeTools.definitions` 每项只声明插件内唯一的 key 和 protocol；当前宿主提供 `aw.windows-job.v1`。consumers 引用已存在的 managed command set 或 `node` 测试 runner。binding 显式限定 `platforms: ["win32"]` 和 required/preferred；preferred 必须给出 fallback，并用相同 protocol 的双 backend 合同测试证明等价。Job containment、ACL 和安全停止没有等价实现时使用 required。

插件只保存协议需求与消费者绑定。构建通过 `AW_PLUGIN_NATIVE_READER` 取得 AW 生成的 reader；运行脚本用 `readNativeTool(key, protocol)` 读取本次结果。ready 只提供 state、protocol 和 executable。需要工具的业务脚本从托管命令进入，Skill 正文引用该命令。Hook、MCP 和任意脚本路径不属于受控消费者。

validate、build 和静态 materialization 不取得 EXE，不要求 Go。Windows 动态 renderer 和真实插件测试使用当前 CLI 已安装的配套 helper。fixture 通过只证明接线，不能作为 Windows ACL、Job 和后代清理的证据。

## 运行与恢复

安装审阅包含协议、消费者、平台、policy 和 fallback；声明闭包只包含 reader、definitions 和 consumers。source sync 刷新 Catalog；成功确认并更新 producer 后，新调用使用新声明。升级 CLI 配套工具不改变插件声明，无须重新发布插件或单独 Review。更新或移除 producer 前结束或停止活跃任务。

宿主在业务操作前解析 required 工具，失败则停止；preferred 才可使用已声明等价后端。不支持的协议直接报错。活跃任务不静默更换 backend。

Windows Job 随当前 CLI 的 Eval 依赖安装，单独安装 Eval 也可使用；宿主从该 Eval 的依赖上下文解析适用平台包，不要求顶层 node_modules。需要工具时发现 optional dependency 缺失，重新安装当前 CLI/Eval，并包含 optional dependencies。正常运行不访问 registry；离线安装使用包管理器缓存或同版本完整 npm 依赖包。

插件不保存工具版本、descriptor 或 EXE 摘要，不复制 EXE，也不自行查询 npm、下载、预取或导入工具。不通过 PATH、全局包、仓库 EXE 或旧 AW cache 恢复。第三方作者只需兼容 AW，无须本 monorepo、Go、全局 Eval 或官方发布脚本。
