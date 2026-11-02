# 原生工具

为托管命令或 Node 插件测试声明原生工具、处理首次准备失败、或发布引用工具的消费者时读取。先完成主 Skill 的兼容性检查，再查询当前 `aw plugin capabilities --surface native-tools --json` 和 `aw native --help`；字段、限制和错误由当前 CLI/Core 提供。

## 声明和构建

生产者提供已经发布的精确工具版本和文本 descriptor。插件在 `nativeTools` 声明 key、protocol、锁文件，以及已存在的 managed command set 或 `node` 测试消费者。binding 显式限定适用平台和 required/preferred；preferred 必须给出 portable fallback，并用相同 protocol 的双 backend 合同测试证明等价。Job containment、ACL 和安全停止没有等价实现时使用 required。

插件只保存文本锁，使用 AW 生成的 reader 读取本次路径。构建通过 `AW_PLUGIN_NATIVE_READER` 取得生成文件；不读取 AW 的安装位置，不复制 EXE，不从 PATH 或 node_modules 猜测 helper。需要工具的业务脚本从托管命令进入，Skill 正文引用该命令。v1 不把原生要求绑定到 Hook、MCP 或任意脚本路径。

validate/build/materialization 的原生制品处理保持离线。Windows 动态 renderer 要求 AW 自身的 Job helper 已在 cache 中；缺少时停止，并提示显式预取或离线导入后重试。普通测试显式选择 fixture 或 cache-only；真实集成选择 network，工具生产资格选择 source-candidate。源码已变更时，资格测试使用本次候选。fixture 通过不能作为 Windows ACL、Job 和后代清理的证据。

## 运行和恢复

安装审阅包含工具、精确来源、descriptor digest、消费者、平台、policy 和 fallback。source sync 只刷新 Catalog；成功确认并更新 producer 后，新调用才使用新闭包。更新或移除 producer 前先结束或停止活跃任务。

宿主在消费者业务操作前准备 required 工具，失败就停止；preferred 才可使用已声明等价后端。所有需要工具的前台命令采用同一规则，所以 stop 在冷 cache 断网时也可能失败。后台只继承已解析结果或读取有效 cache，不触发联网；活跃任务不静默换 backend。

使用通用管理入口恢复，参数从当前 help 取得：

```sh
aw native prefetch /path/tool.lock.json --json
aw native import /path/tool.lock.json --archive /media/current-platform.tgz --json
```

import 完全离线，只准备校验后的 bytes，不授予插件运行权限。缓存损坏可重建；foreign 或不安全节点保留并报告。不要通过旧插件副本、源码 EXE 或任意下载地址恢复。

## 发布消费者

发布前用 `aw native verify <descriptor> --all-variants --json` 逐份验证文本锁的所有平台引用。普通 build 不验证 registry 存在性。工具 bytes 改变先由工具生产者独立发布新版本，再更新消费者锁；CLI 或 Catalog 不顺带发布工具。第三方消费者无需本 monorepo、Go、全局 Eval 或官方发布脚本。

registry、scope、认证和 proxy 属于 AW 宿主配置，不写入 descriptor 或 Catalog。配置格式从当前入口合同取得；错误与回执不得回显 credential。原生获取的限制只适用于这套基础设施，命令自己的业务网络操作按其业务合同执行。
