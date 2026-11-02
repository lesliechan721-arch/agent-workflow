# 插件测试

从仓库根目录运行。使用项目规定的 Node.js 和 pnpm 版本，先运行 `pnpm build`，并将已构建的 `aw` CLI 放入 PATH。正式入口按 `.agents-plugin/plugin.json` 的 `scripts.tests.node` 清单准备安装产物与隔离测试环境：

```sh
pnpm plugin:test codex-enhance --test-concurrency 1
```

macOS/Linux 的普通测试使用默认 `fixture` 模式，不取得 Windows 制品，也不要求 Go。Windows 普通 fixture 测试须用 `--native-mode fixture --native-fixture-context <context.json>` 显式提供 ready fixture 上下文；用例只替换原生进程边界，真实 Windows 测试会跳过。fixture 上下文不提供原生支持证据。

真实 Windows 测试由 AW runner 按本插件的 `node` consumer binding 解析工具。使用已预置隔离缓存时运行：

```sh
pnpm plugin:test codex-enhance --native-mode cache-only --native-cache <cache-dir> --test-concurrency 1
```

显式联网集成使用 `--native-mode network`。工具源码已变化时，使用本次候选的 `--native-mode source-candidate --native-archive <archive.tgz>`，不下载旧版本。全部模式都只使用 runner 注入的原生上下文，不搜索 PATH、平台 package 或源码 PE。平台专属用例在其他系统上明确跳过；跳过不算该平台已验证。测试使用本地 fake backend，不调用真实模型。

| 范围 | 测试入口 | 平台 |
| --- | --- | --- |
| v5 协议、消息边界、分配、关闭和工具资源 | `subagent-protocol-v5.test.mjs`、`subagent-bridge-v5.test.mjs` | 三系统 |
| 消息数量、输出预算、消费失败和参数组合 | `subagent-runtime-logic.test.mjs` | 三系统；真实模块与临时状态，Windows 原生调用使用受控替身 |
| 共享 Adapter 停止触发和截止时间 | `subagent-adapter-common.test.mjs` | 三系统；真实 JSONL 连接与受控时间 |
| 父命令安装闭环、通信、管道失败、worker 竞态、TTL 和清理 | `subagent-integration-communication.test.mjs`、`subagent-integration-results.test.mjs`、`subagent-integration-recovery.test.mjs` | 三系统；根目录无覆盖发布包含 Windows 专属断言 |
| 初始化观察窗口、能力补报与启动失败后的固定结果 | `subagent-integration-initialization.test.mjs` | 三系统 |
| 诊断脱敏、输出预算及完整导出 | `subagent-integration-reports.test.mjs` | 三系统 |
| Antigravity 通信状态与真实文件桥接 | `antigravity-adapter.test.mjs` | 三系统；状态分支使用真实内存通道，代表用例使用真实文件扫描与投递 |
| 私有权限、链接拒绝、参数保真、所属进程与孤儿清理 | `subagent-platform.test.mjs` | 三系统 |
| 包管理器 shim、Job 环境、隔离 home 与系统 API | `subagent-platform.test.mjs` | Windows |
| 共享进程组保护、停止后保留调用者 | `subagent-platform.test.mjs` | macOS、Linux |
| 内建适配器的输入、协议、停止与安装资源闭包 | `adapters-integration-inputs.test.mjs`、`adapters-integration-protocol.test.mjs`、`adapters-integration-control.test.mjs` | 三系统 |
| 文件选择及确定性 Eval 消费者 | manifest 中其余测试入口 | 按各用例的平台条件执行 |

## Windows 文件占用与跨卷资格

`subagent-windows-file-boundaries.mjs` 是长期保留的显式原生资格入口。它需要 Windows 和两个不同的真实固定卷，不加入普通插件测试的默认链：

```sh
node <prepared-plugin>/scripts/subagent-windows-file-boundaries.mjs
```

使用 AW 已构建的临时插件，继承资格 runner 按当前候选准备的 `AW_NATIVE_TOOL_CONTEXT` 和 `AW_NATIVE_RESOLVER_MODE=cache-only`。不从源码目录直接启动，也不在该脚本中下载工具。

覆盖真实 `FileShare.None` 占用时原子更新失败、原值保留与解锁恢复，以及跨卷的 start/send/wait/result/export、中文与 CRLF 保真、主动停止和所属进程清理。运行目录或 `%SystemRoot%/Temp` 中至少一处必须与系统临时目录位于不同卷。脚本检查原生卷身份；没有所需卷时失败，不用另一个目录冒充跨卷。

发布 CI 的 Windows 资格步骤可直接调用此入口。成功须有 `qualification.complete` 且 `pass: true`；非 Windows 的 `notApplicable` 不构成成功证据。

## 真实长时资格

默认超时、期限和 TTL 边界使用模拟时间。需要重新验证真实后台存活时，三系统均可显式运行保留在 `subagent-integration-recovery.test.mjs` 内的长时用例。

macOS/Linux：

```sh
AW_SUBAGENT_LONG_RUN_MS=1805000 node --test --test-name-pattern='long-running default run' <prepared-plugin>/scripts/subagent-integration-recovery.test.mjs
```

Windows PowerShell：

```powershell
$env:AW_SUBAGENT_LONG_RUN_MS = '1805000'
try {
  node --test --test-name-pattern='long-running default run' <prepared-plugin>/scripts/subagent-integration-recovery.test.mjs
} finally {
  Remove-Item Env:AW_SUBAGENT_LONG_RUN_MS
}
```

这项资格实际等待超过 30 分钟，普通反馈不启用。只有相关生命周期或平台实现变化需要新原生证据时才重跑。

PR/main 和发布候选共用 `.github/actions/plugin-tests` 复合 action。Linux x64、macOS arm64 运行全部插件；Windows x64 显式使用本次源码候选，通过 `--test-shard 1/3`、`2/3`、`3/3` 按测试文件分片，每片串行，全部成功才通过。Adapter 原生集成测试分为四个文件，Runtime 原生集成测试按通信、初始化、恢复、会话恢复、恢复输出、报告和结果分为七个文件。普通 Windows fixture 模式的跳过不代替这些原生用例。Node 按文件路径排序后轮流分配，新增或重命名文件时需检查三片的耗时分布；一个文件内的用例不会拆到多片。各 Windows 分片都启用原生调用诊断。第一片保留文件占用与跨卷资格。分片不缩短单个用例的原生耗时，也不启用真实 30 分钟等待。

自动 beta 只复用相同 main SHA 已成功的全部平台与分片；未取得可复用证据的发布候选会重新执行这套流程。原生资格仅证明实际运行的 OS/CPU，不外推其他架构或真实模型。
