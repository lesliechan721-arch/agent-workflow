# 插件测试

从仓库根目录运行。使用项目规定的 Node.js 和 pnpm 版本，先运行 `pnpm build`，并将已构建的 `aw` CLI 放入 PATH。正式入口按 `.agents-plugin/plugin.json` 的 `scripts.tests.node` 清单准备安装产物与隔离测试环境：

```sh
pnpm plugin:test codex-enhance --test-concurrency 1
```

这个入口可在 macOS、Linux 和 Windows 原生 runner 上复用。平台专属用例在其他系统上明确跳过；跳过不算该平台已验证。测试使用本地 fake backend，不调用真实模型。

| 范围 | 测试入口 | 平台 |
| --- | --- | --- |
| v5 协议、消息边界、分配、关闭和工具资源 | `subagent-protocol-v5.test.mjs`、`subagent-bridge-v5.test.mjs` | 三系统 |
| 父命令、生命周期、输出、消费、导出、TTL 和无默认期限 | `subagent-runtime.test.mjs` | 三系统；根目录无覆盖发布包含 Windows 专属断言 |
| 私有权限、链接拒绝、参数保真、所属进程与孤儿清理 | `subagent-platform.test.mjs` | 三系统 |
| 包管理器 shim、Job 环境、隔离 home 与系统 API | `subagent-platform.test.mjs` | Windows |
| 共享进程组保护、停止后保留调用者 | `subagent-platform.test.mjs` | macOS、Linux |
| 内建适配器、文件选择、资源闭包及确定性 Eval 消费者 | manifest 中其余测试入口 | 按各用例的平台条件执行 |

## Windows 文件占用与跨卷资格

`subagent-windows-file-boundaries.mjs` 是长期保留的显式原生资格入口。它需要 Windows 和两个不同的真实固定卷，不加入普通插件测试的默认链：

```sh
node plugins/codex-enhance/scripts/subagent-windows-file-boundaries.mjs
```

覆盖真实 `FileShare.None` 占用时原子更新失败、原值保留与解锁恢复，以及跨卷的 start/send/wait/result/export、中文与 CRLF 保真、主动停止和所属进程清理。运行目录或 `%SystemRoot%/Temp` 中至少一处必须与系统临时目录位于不同卷。脚本检查原生卷身份；没有所需卷时失败，不用另一个目录冒充跨卷。

发布 CI 的 Windows 资格步骤可直接调用此入口。成功须有 `qualification.complete` 且 `pass: true`；非 Windows 的 `notApplicable` 不构成成功证据。

## 真实长时资格

默认超时、期限和 TTL 边界使用模拟时间。需要重新验证真实后台存活时，三系统均可显式运行保留在 `subagent-runtime.test.mjs` 内的长时用例。

macOS/Linux：

```sh
AW_SUBAGENT_LONG_RUN_MS=1805000 node --test --test-name-pattern='long-running default run' plugins/codex-enhance/scripts/subagent-runtime.test.mjs
```

Windows PowerShell：

```powershell
$env:AW_SUBAGENT_LONG_RUN_MS = '1805000'
try {
  node --test --test-name-pattern='long-running default run' plugins/codex-enhance/scripts/subagent-runtime.test.mjs
} finally {
  Remove-Item Env:AW_SUBAGENT_LONG_RUN_MS
}
```

这项资格实际等待超过 30 分钟，普通反馈不启用。只有相关生命周期或平台实现变化需要新原生证据时才重跑。

PR/main 和发布候选共用 `.github/workflows/plugin-tests.yml`。Linux x64、macOS arm64 运行全部插件；Windows x64 通过 `--test-shard 1/3`、`2/3`、`3/3` 按测试文件分片，每片串行，全部成功才通过。Windows 第一片还执行文件占用与跨卷资格。分片不缩短单个用例的原生耗时，也不启用真实 30 分钟等待。

自动 beta 只复用相同 main SHA 已成功的全部平台与分片；未取得可复用证据的发布候选会重新执行这套流程。原生资格仅证明实际运行的 OS/CPU，不外推其他架构或真实模型。
