# Windows Job 原生工具

此目录拥有 Windows Job 的唯一 Go 源和固定 Go 工具链配置。两个 Windows 平台 npm 包属于 CLI 五包产品，使用本次 CLI 发布版本。`tool.json` 只保存协议和 Go 配置，不保存独立产品版本。

普通 `pnpm build`、`build:dev`、`build:ensure` 和普通测试不调用 Go，也不要求源码 EXE。显式原生候选和发布打包使用固定 Go 工具链：

```sh
pnpm native:windows-job:prepare
pnpm native:windows-job:reproduce
```

安装 `tool.json` 中的精确 Go 版本。构建禁用自动 toolchain、代理、CGO、VCS 元数据及 build ID，并为构建缓存建立独立临时目录。产物写入忽略目录 `.native/windows-job/<CLI version>/`：两架构 EXE、构建 `manifest.json`、两个确定性 npm tarball、`candidate.json` 和可复现报告。不会生成消费者文本锁。

发布脚本可导入 `pack.mjs`：

- `packWindowsJobCandidate({version?, repoRoot?, nativeRoot?})` 验证已有构建并打包。
- `buildWindowsJobCandidate(options)` 构建、打包并验证可复现结果。
- 两个函数返回 `{root, candidate, candidateDigest, manifest, tarballPaths}`；tarball 顺序为 x64、arm64。

版本缺省取 `packages/cli/package.json`。显式 CLI 候选版本可传给 `build.mjs --version <version> --out <directory>` 和 `pack.mjs --version <version> --out <directory>`；可复现验证使用 `reproduce.mjs --candidate <directory>`。

在真实 Windows x64 和 arm64 主机上，用同一候选、对应架构 Node 和固定 Go 运行：

```sh
pnpm build
pnpm qualification:windows-job -- --candidate <candidate-directory>
```

资格入口核验当前源码与 tarball，把本次平台包解包到临时依赖目录，并明确向资格 harness 注入该 helper。它运行 Eval/Plugin 两种 Job 闭环、Go 原生 ACL/文件/进程测试，以及插件真实文件占用和跨卷资格。报告 `qualification-<arch>.json` 绑定精确候选摘要；macOS/Linux 交叉编译不能取得 passing Windows 资格。fixture 只证明打包和接线。

`evidence.mjs` 的 `assertWindowsJobCandidateEvidence(selected)` 检查两架构真实资格与可复现报告，返回需保存的四个 JSON 文件路径。CLI prepared descriptor 和恢复包保存候选 tarball 与这些证据。平台包由 CLI 发布入口统一发布，不提供独立 Windows Job 发布、版本或 repair 入口。

Windows 测试 job 可以运行 `test-environment.mjs --candidate <directory> --context-file <path> --github-env`。此入口把本次候选解包到隔离临时目录，并为当前架构的 workspace 平台包生成 `dist/aw-windows-job.exe`。它从 Eval 的正常依赖上下文解析并核对该产物，再输出测试专用的 `AW_NATIVE_TOOL_CONTEXT`。测试 context 和 source 中的生产解析器因此使用同一候选；普通 build 不执行此准备。产品运行时始终从实际 Eval 安装位置解析同版本平台依赖。
