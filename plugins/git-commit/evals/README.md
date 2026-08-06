# Git Commit 触发评测

这里的 20 个固定用例分成 train（12）和 validation（8），用于评测 Codex 是否在正确场景隐式加载 `commit` skill。

- 正例覆盖自然语言提交、已暂存内容、指定文件、英文请求和“提交并推送”中的提交步骤。
- 反例覆盖只拟写或评审 message、查看状态、暂存、推送已有提交、改写历史，以及非 Git 语义的 “commit”。
- 不根据 validation 结果反向修改 description；先在 train 上迭代，最后只用 validation 检查泛化。
- 显式 `$commit` 由 Codex 在模型运行前直接注入，不会产生本 runner 使用的 shell 读取事件，因此不放进隐式触发 corpus；常规插件测试改为验证 portable frontmatter 与真实 Codex bundle 元数据。

## 运行真实触发评测

需要已登录且支持 `codex exec --json` 的 Codex：

```bash
node plugins/git-commit/evals/run-trigger-evals.mjs \
  --split train \
  --runs 3 \
  --output /tmp/git-commit-train.json

node plugins/git-commit/evals/run-trigger-evals.mjs \
  --split validation \
  --runs 3 \
  --output /tmp/git-commit-validation.json
```

runner 评测的是 Codex 的 project-local skill discovery：它会创建一个同时包含已暂存、未暂存和未跟踪内容的临时 Git 仓库，并把当前源码渲染成 Codex 项目 skill。这个评测面不等同于完整 AW 安装链路；生产 bundle 的模板渲染由 `pnpm plugin:test git-commit` 和 build smoke 另行验证。

临时进程使用独立的 `HOME`、`CODEX_HOME`、XDG 目录和 Git 配置，只从原 `CODEX_HOME` 复制 `auth.json`，并保留必要的 API key、代理和证书环境变量。Codex 同时启用只读 sandbox、忽略用户配置和用户/项目 exec policy rules，并关闭 bundled/orchestrator skills。每次运行前后都会比对 Git refs、配置、tracked/untracked 内容和状态；一旦观察到成功读取目标 `SKILL.md` 就立即停止。

Codex 的系统、云端和设备托管配置层不能由这些参数统一关闭。runner 会在已知的系统 Codex 目录含有内容时拒绝运行，并在报告中明确记录其它托管层未被禁用；因此该评测用于触发质量回归，不应视为安全隔离边界。

默认每条运行 3 次，以 `0.5` 为分界：正例加载率必须高于分界，train 反例加载率必须低于分界；validation 反例要求零误触发。JSON 报告会记录 Codex 版本、模型来源、插件版本、skill/corpus SHA-256 和操作系统信息，便于复现。

Windows 上必须通过 `--codex-bin` 提供官方 launcher 选择的原生 `codex.exe` 绝对路径，避免 Node 直接启动 `.cmd` wrapper 的平台差异。

## 常规插件测试

```bash
pnpm plugin:test git-commit
```

常规插件测试不会调用模型。它会验证：

- eval corpus、参数解析、成功终态事件识别、环境隔离和临时 skill staging；
- `pnpm plugin:test` 临时 bundle 中 Claude/Codex 的实际模板渲染结果；
- 部分暂存提交只记录 index 内容并保留未暂存 hunks；
- 普通 porcelain 状态不会明确标识已解决但尚未完成的 merge，而完整 `git status` 可以识别该状态。
