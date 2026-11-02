# Windows Job 原生工具

此目录拥有唯一 Go 源、固定工具链和独立版本。`tool.json` 的版本与 CLI、Eval、Core 和 Catalog 无关。平台包目录中的 package.json 只是包模板，实际归档使用工具版本。

普通 `pnpm build`、`build:dev`、`build:ensure` 和三包打包不调用 Go，不下载 PE，不创建原生缓存。只有显式原生入口使用 Go。

```sh
pnpm native:windows-job:version -- 1.0.1
pnpm native:windows-job:build
pnpm native:windows-job:pack
pnpm native:windows-job:reproduce
```

安装 `tool.json` 中的精确 Go 版本。构建禁用自动 toolchain、代理、CGO、VCS 元数据及 build ID，并为构建缓存建立独立临时目录。两个 PE、固定构建 manifest、两个确定性 npm archive、文本 descriptor 和 candidate 都只写入忽略目录 `.native/windows-job/<version>/`。`pack` 还更新此目录下的文本 `windows-job.lock.json`。文本锁说明 archive 和 PE 的精确字节，不证明 registry 已存在该包。

在真实 Windows x64 和 arm64 主机上，用同一 candidate 和对应架构 Node、固定 Go 运行：

```sh
pnpm build
pnpm qualification:windows-job
```

资格入口检查当前源码摘要和当前 archive，使用 `source-candidate` resolver，在隔离缓存中取得当前架构工具。它运行 Eval/Plugin 两种 Job 闭环、Go 原生 ACL/文件/进程测试，以及插件真实文件占用和跨卷资格。它将当前候选摘要写入 `qualification-<arch>.json`。macOS/Linux 交叉编译不能生成 passing Windows 资格。

独立 `.github/workflows/windows-job.yml` 保存候选和两架构报告；手动 `publish` 输入默认为 false。发布需要 OIDC 平台包发布权限和 `npm-native` environment。发布命令只消费已经通过可复现检查和两架构资格的同一候选：

```sh
pnpm native:windows-job:release -- --publish
```

发布在首次 npm 写入前原子保存 `.release/native/windows-job/<version>/attempted.json`。Actions 先保存并上传 write intent，再开始发布。远端写入失败、结果不确定或部分成功后必须提升工具版本；没有同版本 repair，不撤回已发布的单个平台包。Actions 同时拒绝 publisher job 重跑和同版本的历史 publisher 尝试。候选、报告或 attempt 证据缺失时停止，用新版本恢复。

本地候选测试可用 `pnpm native:windows-job:prepare` 构建、打包并同步三个消费者的文本锁。消费者正式发布前，必须用 `aw native verify <descriptor> --all-variants` 验证全部精确平台包可从配置 registry 取得且字节匹配。CLI/Catalog 发布不会发布原生包；新工具未完整发布时，消费者发布验证必须失败。
