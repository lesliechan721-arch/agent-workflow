# AW 原生工具合同 v1

原生工具是 AW 托管的运行制品。插件声明能力、文本锁和消费者，AW 在启动消费者前选择当前平台制品，获取、校验并注入本地路径。v1 的生产格式只支持 Windows PE；源码、Skill、Catalog、CLI、Eval 和 Core 普通包不包含 PE。

## 作者声明

Plugin Manifest v3 的 `nativeTools` 要求 `aw.native-tools.v1`。从当前工具查询字段和限制：

```sh
aw plugin capabilities --surface native-tools --json
```

`definitions` 中每项包含插件内唯一 `key`、版本化 `protocol` 和 `./` 开头的插件内 descriptor 路径。`consumers` 只支持 `managed-command-set` 和 `plugin-test`；key 分别引用已声明 set 和 `node` 测试 runner。每个工具绑定显式声明 `platforms: ["win32"]` 与 `policy`。`required` 失败时不启动消费者；`preferred` 必须有 `fallback` 标识，并通过相同 protocol 的双 backend 合同测试。Job containment、ACL 或安全停止缺少等价实现时使用 required。

可选 `reader` 指定插件内生成文件，默认 `./.aw/native-tool-reader.mjs`。作者构建从 `AW_PLUGIN_NATIVE_READER` 取得 AW 生成的 reader，打包后通过 `readNativeTool(key, protocol)` 读取当前运行结果。reader 不下载、不解释 cache，不接受业务参数中的工具路径。Skill 使用托管命令引用，不直接运行需要工具的脚本。Hook、MCP 和任意文件路径不是 v1 受控消费者。

descriptor schema 1 固定 `tool.id/version/protocol` 和一到两个 `variants`。每个 variant 固定 `platform`、`arch`、`transport`、`file` 和 `limits`。npm transport 固定 package、精确 version、`sha512-` archive integrity 及唯一 entry。file 固定 SHA-256、大小、`pe` 格式和 machine（x64 为 `0x8664`，arm64 为 `0xaa64`）。不接受 URL、dist-tag、range、credential 或未知字段。工具或 protocol 实现 bytes 改变时发布新版本；不兼容协议使用新 protocol ID。

archive 必须是受限 npm tarball。只提取锁定的 EXE，绝不执行 package script 或包内代码。拒绝链接、设备、路径逃逸、重复目标、错误大小、摘要或 machine。每份 descriptor 可以收紧全局预算：archive 16 MiB、展开 32 MiB、64 entries、网络 30 秒。最终字段、默认值和错误码由 Core 和共享 parser 定义。

## 构建、发布和第三方 Workspace

`aw plugin validate/build/test`、Catalog build 和 Skill materialization 默认离线处理文本锁、binding 和 reader，不取得真实 PE。普通测试显式使用 fixture 或 cache-only；真实原生集成选择 network，原生工具源码资格选择 source-candidate。fixture 只证明声明、准备和协议接线，不证明 Windows ACL、Job 或取消行为。

Windows 上，动态 Skill renderer 仍要求 AW 自身的 Job helper 已在 cache 中。作者物化只读 cache；缺少 helper 时，在启动 renderer 前停止，并给出 `aw native prefetch` 或 `aw native import` 恢复命令。静态内容不要求 helper。用户显式准备 helper 后，可以离线重试物化。

第三方作者只需要已安装的兼容 AW：

```sh
aw plugin validate plugins/example --workspace-root /workspace --json
aw plugin build plugins/example --workspace-root /workspace --json
aw plugin test plugins/example --workspace-root /workspace --json
aw native verify /workspace/plugins/example/native-tools/job.lock.json --all-variants --json
```

发布前对全部引用的锁运行 verify。它在临时隔离 cache 中从受控 registry 验证所有 variant，不执行制品。普通 build 不做远端存在性检查。第三方不需要本 monorepo、Go、全局 Eval 或官方发布脚本。只消费已经发布的原生版本；Windows Job 自身的源码构建和双架构资格由该工具生产者负责。

CLI 产品只发布 Eval、Core 和 CLI。Windows Job 独立发布 x64、arm64 平台 archive 和 descriptor。两个 variant 都可取得且匹配后，消费者才更新文本锁。原生平台包部分成功不撤回；失败或结果不确定后提升工具版本。CLI 的显式 repair 不扩展到原生工具同版本续发。Catalog-only 和未改锁的 CLI 发布不写原生 npm 包。

## 安装审阅和运行

新增、删除或改变完整 native 声明闭包均进入现有 Review 和 Receipt，包括 source/plugin、工具/protocol、精确 package/version、descriptor digest、消费者、平台、policy 和 fallback。没有第二套 native 批准流程。

已安装 producer 保存完整闭包及文本文件并核验内容。运行只读该 evidence；Catalog source sync 不改旧命令。用户确认并成功更新 producer 后，后续调用才使用新闭包。producer 更新失败时保留完整旧产物，或撤下不完整绑定，不能混用。更新、重装或删除 producer 前结束或停止活跃任务。

配置应用或重放不能代替 native 变化确认。独立命令包的当前声明与已安装闭包不同时，配置刷新保留旧 producer 并报告部分失败；先通过现有 sync 或 package sync 审阅并确认变化，再重试配置应用。已保存的配置仍保留。仅撤销一个 scope 的原生插件注册时，仍存在的共享静态 Skill producer 保持可用，不计作闭包删除。

宿主先拒绝可判断的命令、binding 和环境错误，再准备所需工具；required 成功后才启动插件、读取任务或产生业务副作用。`start/send/wait/result/stop` 使用同一准备规则。缺少缓存且断网时，stop 也可能失败；先离线导入再重试。

`AW_NATIVE_TOOL_CONTEXT` 保存 schema 1 和本次声明 key 的 ready/unavailable 结果。`AW_NATIVE_*` 是受保护内部前缀，命令 env/envFrom 不得覆盖，Windows 按大小写不敏感处理。宿主清理继承的旧上下文，再按自己的 producer 解析。后台只使用父侧结果或有效 cache，不联网。preferred backend 在消费者启动时固定，操作失败不在活跃任务中静默切换。

## 缓存和恢复

默认 cache 为 `<AW_HOME>/native-artifacts/v1`，按平台、架构和文件 SHA-256 寻址。相同 bytes 可共享，source/plugin/key/descriptor digest 仍各自核验；共享 cache 不建立跨来源授权。Eval API 调用者显式注入隔离 cache root，standalone 使用 `--native-cache-root`。

不适用当前平台的 binding 完全跳过，不创建 cache。命中时只核对本地文件；断网可运行。缓存只接受普通目录和文件，并在使用前重验摘要和 PE machine。独占 staging 完整校验后无覆盖发布；并发可重复下载，不增加全局锁、ledger、引用计数或自动 GC。owned 损坏候选可重建；foreign 或不安全节点保留并报告。卸载插件不删除共享 cache。

空 cache 可直接预取或离线导入，准备不调用待取得 helper，也不持 AW_HOME 强配置写锁：

```sh
aw native prefetch /path/job.lock.json --json
aw native import /path/job.lock.json --archive /media/job-win32-x64.tgz --json
```

两者默认当前平台和架构，可用 `--platform`、`--arch` 及 `--cache-root` 显式选择。import 不读 registry 配置、不联网，只准备已校验 bytes，不授予插件运行权限。缺 variant、下载失败、摘要错误或路径不安全时，required 停止，preferred 使用已声明等价后端。不能使用 PATH、同名 EXE、全局 node_modules、源码 PE 或旧插件副本恢复。

## Registry 配置

宿主环境 `AW_NATIVE_REGISTRY_CONFIG` 提供 JSON 配置：`url` 是默认 registry，`scopes` 按 npm scope 选择 registry，`headers` 只发给默认 registry，`registryHeaders` 按精确 registry URL 配置凭据，`proxy` 配置代理。没有显式配置时使用公共 npm registry。URL 不含 userinfo，descriptor 不保存 registry 或 credential。不同 registry 不共享认证头。

凭据只留在宿主运行配置，不写 descriptor、snapshot、cache metadata、receipt 或诊断。离线 import 不需要配置。锁身份查询和后台清理不会为了取得 helper 而联网；查询失败保守保留 unknown/instance，不接管活跃锁。
