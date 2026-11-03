# AW 原生工具合同 v2

原生工具由当前运行的 AW 或 Eval 提供。插件声明需要的宿主协议和消费者；宿主在启动消费者前，从自身已安装依赖解析适用平台的工具，并注入本地路径。当前支持 `aw.windows-job.v1`。Windows Job 的两个平台包与 Eval、Core、CLI 使用同一 CLI 产品版本。

## 作者声明

Plugin Manifest v3 的 `nativeTools` 要求 `aw.native-tools.v2`。从当前工具查询字段和限制：

```sh
aw plugin capabilities --surface native-tools --json
```

`definitions` 每项只包含插件内唯一的 `key` 和版本化 `protocol`：

```json
{
  "definitions": [
    { "key": "windows-job", "protocol": "aw.windows-job.v1" }
  ]
}
```

`consumers` 只支持 `managed-command-set` 和 `plugin-test`；key 分别引用已声明 set 和 `node` 测试 runner。每个工具绑定显式声明 `platforms: ["win32"]` 与 `policy`，不适用当前平台的 binding 跳过。`required` 不声明 fallback，失败时不启动消费者；`preferred` 必须有 `fallback` 标识，并通过相同 protocol 的双 backend 合同测试。Job containment、ACL 或安全停止缺少等价实现时使用 required。宿主不支持的协议报 `nativeProtocolUnsupported`。

可选 `reader` 指定插件内生成文件，默认 `./.aw/native-tool-reader.mjs`。作者构建从 `AW_PLUGIN_NATIVE_READER` 取得 AW 生成的 reader；运行脚本通过 `readNativeTool(key, protocol)` 读取当前结果。ready 结果为 `{ state: "ready", protocol, executable }`；preferred 不可用结果为 `{ state: "unavailable", protocol, code }`。reader 不取得工具，不接受业务参数中的工具路径。Skill 使用托管命令引用。Hook、MCP 和任意文件路径不是受控消费者。

插件保存协议需求与消费者绑定，不保存平台包版本、descriptor、archive integrity、EXE 摘要、大小或 machine，也不复制 EXE。工具实现随宿主更新；不兼容实现使用新的 protocol ID。

## 构建与第三方 Workspace

`aw plugin validate/build`、Catalog build 和静态 Skill materialization 处理声明、binding 和 reader，不取得真实 EXE，不要求 Go。Windows 上执行动态 renderer 或真实插件测试时，使用当前 CLI 的配套 helper；缺依赖时在启动前停止。fixture 只证明声明、准备和协议接线，不能证明 Windows ACL、Job 或取消行为。

第三方作者只需要已安装的兼容 AW：

```sh
aw plugin validate plugins/example --workspace-root /workspace --json
aw plugin build plugins/example --workspace-root /workspace --json
aw plugin test plugins/example --workspace-root /workspace --json
```

作者通过 capability 和 validator 检查宿主需求。消费受支持协议不要求本 monorepo、Go、全局 Eval 或官方发布脚本。

## 安装审阅与运行

新增、删除或改变 native 声明闭包均进入现有 Review 和 Receipt，包括 source/plugin、工具 key、protocol、消费者、平台、policy 和 fallback。闭包只保存 `reader`、`definitions` 和 `consumers`。没有第二套 native 批准流程。

已安装 producer 保存并核验声明闭包。Catalog source sync 不改旧命令；用户确认并成功更新 producer 后，后续调用才使用新声明。producer 更新失败时保留完整旧产物，或撤下不完整绑定。更新、重装或删除 producer 前结束或停止活跃任务。

配置应用或重放不能代替 native 声明变化确认。独立命令包的当前声明与已安装闭包不同时，配置刷新保留旧 producer 并报告部分失败；先通过现有 sync 或 package sync 审阅并确认变化，再重试配置应用。已保存配置仍保留。仅撤销一个 scope 的原生插件注册时，仍存在的共享静态 Skill producer 保持可用，不计作闭包删除。仅升级 CLI 的配套工具不会改变插件声明，不要求插件重装、重新发布或单独 Review。

宿主先拒绝可判断的命令、binding、协议和环境错误，再解析所需工具；required 成功后才启动消费者、读取任务或产生业务副作用。`start/send/wait/result/stop` 使用同一准备规则。preferred backend 在消费者启动时固定，操作失败不在活跃任务中静默切换。

`AW_NATIVE_TOOL_CONTEXT` 保存 schema 1 和本次声明 key 的 ready/unavailable 结果。`AW_NATIVE_*` 是受保护内部前缀，命令 env/envFrom 不得覆盖，Windows 按大小写不敏感处理。宿主清理继承的旧上下文，再按自己的 producer 解析。

## 包解析与恢复

Eval 的 `prepareWindowsJobHelper(options = {})` 和 `resolveWindowsJobHelperPath(options = {})` 从 Eval 包自身的依赖上下文，通过 `import.meta.resolve` 解析适用平台包；CLI 复用该能力。options 可指定 platform 和 arch，默认使用当前平台与架构。它们不假定依赖位于顶层 `node_modules`，也不读取 `NODE_PATH`。两个不同位置安装的 CLI 各用自己的依赖。

Eval 精确引用与自身同版本的两个 Windows 平台 `optionalDependencies`。包管理器按平台和 CPU 安装适用包；macOS/Linux 不安装 Windows 包。三个通用 npm 包、Skill 和 Catalog 不包含 EXE。正常安装不编译 Go，也不通过 postinstall 下载或复制 EXE。运行时只检查协议输入、依赖平台和文件是否存在，不重复校验固定 archive/file 摘要或 PE machine。

Windows 的 optional dependency 缺失时，主包安装可能仍成功。只有需要 helper 的操作才报 `nativePackageUnavailable`，并在启动消费者前停止；恢复方式是重新安装当前 CLI 或 Eval，并包含 optional dependencies。不支持的平台或架构报 `nativePlatformUnsupported`。普通查询和不需要工具的操作继续可用。已安装工具运行时不访问 registry，也不搜索 PATH、全局包、仓库 EXE 或旧 AW cache。

离线安装使用包管理器缓存或预先准备的同版本完整 npm 依赖包。AW 不提供原生下载、预取、离线 import、原生 registry 配置或 native cache。旧 AW native cache 不读取、不迁移，也不主动遍历删除。插件与平台产物清理继续保留 foreign 和 shared 内容。

## CLI 产品发布

CLI 产品包含同版本的五个包：

| 包 | 内容与依赖 |
| --- | --- |
| `@lesliechan721/aw-windows-job-win32-x64` | x64 EXE；顶层 `os: ["win32"]`、`cpu: ["x64"]` |
| `@lesliechan721/aw-windows-job-win32-arm64` | arm64 EXE；顶层 `os: ["win32"]`、`cpu: ["arm64"]` |
| `@lesliechan721/agent-skill-eval` | 同版本平台可选依赖与工具解析能力 |
| `@lesliechan721/aw-plugin-core` | 平台无关的作者及 Catalog 合同 |
| `@lesliechan721/aw` | 同版本 Eval 与 Core；复用 Eval 工具解析 |

原生源码、工具链或平台包生产逻辑变化属于 CLI 产品变化。发布准备构建两架构平台包，再打包 Eval、Core、CLI；pack 后依赖必须是精确 registry 版本，不保留 workspace 或本机文件引用。显式原生构建、真实 Windows x64/arm64 资格及候选 smoke 使用本次构建产物。普通开发 build/test 不要求 Go 或真实 EXE。

发布顺序为两个平台包 → Eval → Core → CLI → 五包 registry 可见性校验 → CLI 完成 tag。可见性校验在总时限内重新读取 metadata 和归档，重新验证缓存；重试只读取，不重复 publish。整组与证据进入现有 prepared descriptor、attempt 和 Actions 恢复包。任一包发布失败或结果不确定后，普通恢复提升 CLI 版本并重新准备整组；显式 CLI repair 只补发原 descriptor 和 attempt 中确认缺失的包。没有独立的 Windows Job 发布或 repair。

官方 Catalog-only 发布在准备时按 beta/latest 选定已完成的同渠道 CLI，并固定完整五包。正式渠道必须是无 prerelease 的 stable；缺少可用版本时先发布对应渠道 CLI。同批 CLI/Catalog 使用本次五包 artifact，在本地解析所有自有包依赖；Catalog 远端写入等待 CLI 整组发布及完成 tag。Catalog-only 不编译 Go、不发布 npm。工具选择和恢复详见[架构说明](architecture.md#release-flow)与 [README 发版流程](../README.md#本仓库维护与官方发版)。

Catalog contentDigest、构建摘要、owner marker 和发布 artifact 摘要继续用于内容身份、恢复与清理归属；它们不是 Windows 工具锁。
