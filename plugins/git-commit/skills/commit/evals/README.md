# Git Commit 触发评测

这里的 20 个固定用例分成 train（12）和 validation（8），用于评测 Codex 是否在正确场景隐式加载 `commit` skill。

- 正例覆盖自然语言提交、已暂存内容、指定文件、英文请求和“提交并推送”中的提交步骤。
- 反例覆盖只拟写或评审 message、查看状态、暂存、推送已有提交、改写历史，以及非 Git 语义的 “commit”。
- 不根据 validation 结果反向修改 description；先在 train 上迭代，最后只用 validation 检查泛化。
- 显式 `$commit` 由 Codex 在模型运行前直接注入，不会产生隐式加载所需的 shell 读取事件，因此不放进隐式触发 corpus；常规插件测试改为验证 portable frontmatter 与真实 Codex bundle 元数据。

## 行为设计用例

`behavior-cases.json` 保存 8 条提交行为设计用例，覆盖非琐碎 body、琐碎提交、部分暂存、范围外已暂存内容、仓库 message 规范、提交后继续 push、进行中的 Git 操作和 hook 拒绝。

这些用例由 `pnpm plugin:test git-commit` 校验结构和核心合同，但不在 `evals/manifest.json` 中声明为模型 suite。当前中央 conversation runner 使用只读 workspace，不能创建真实 commit；因此这些用例不是目标客户端行为通过证据。要形成此类证据，需要单独提供隔离且可写的 Git 行为 runner，并继续通过 `pnpm plugin:eval` 运行。

## 运行真实触发评测

需要已登录且支持当前 app-server 协议的 Codex：

```bash
pnpm plugin:eval git-commit --skill commit --batch-name materialization --materialize-only
pnpm plugin:eval git-commit --skill commit --batch-name trigger-validation-debug --suite trigger --split validation --runs 1
```

无过滤参数时运行 manifest 声明的 release-required validation suite。需要检查 train 时仍通过中央入口：

```bash
pnpm plugin:eval git-commit --skill commit --batch-name trigger-train --suite trigger --split train --runs 3
```

中央 materializer 先经过真实 staging/bundle 路径生成 project-local Skill，native trigger driver 再把该最终 Skill 放进同时包含已暂存、未暂存和未跟踪内容的临时 Git 仓库。不存在源码 template 回退或可独立执行的插件 trigger runner。

临时进程使用独立的 `HOME`、`CODEX_HOME`、XDG 目录和 Git 配置，只复制认证文件，并保留必要的 API key、代理和证书环境变量。Codex 同时启用只读 sandbox、忽略用户配置和用户/项目 exec policy rules，并关闭 bundled/orchestrator skills。插件 fixture module 只负责构造 Git 状态和语义 snapshot；每次运行前后都会比对 Git refs、配置、tracked/untracked 内容和状态，一旦观察到成功读取目标 `SKILL.md` 就立即停止。

Codex 的系统、云端和设备托管配置层不能由这些参数统一关闭。runner 会在已知的系统 Codex 目录含有内容时拒绝运行，并在报告中明确记录其它托管层未被禁用；因此该评测用于触发质量回归，不应视为安全隔离边界。

默认每条运行 3 次，以 `0.5` 为分界：正例加载率必须高于分界，train 反例加载率必须低于分界；validation 反例要求零误触发。JSON 报告会记录 Codex 版本、模型来源、插件版本、skill/corpus SHA-256 和操作系统信息，便于复现。

Windows 上必须通过 `--codex-bin` 提供官方 launcher 选择的原生 `codex.exe` 绝对路径，避免 Node 直接启动 `.cmd` wrapper 的平台差异。

真实模型默认要求 Full Access 管理后代进程；无 Full Access 时会在启动前阻断。用户确认风险后可传 `--allow-unmanaged-processes`，但该模式不保证清理后代进程。中间产物固定在项目 `.tmp/agent-workflows/evals/`，持久报告写入 `plugins/git-commit/reports/commit/<batch-id>/`。

## 常规插件测试

```bash
pnpm plugin:test git-commit
```

常规插件测试不会调用模型。它会验证：

- trigger/behavior corpus、Git fixture、环境隔离和语义状态 snapshot；
- `pnpm plugin:test` 临时 bundle 中 Claude/Codex 的实际模板渲染结果；
- 部分暂存提交只记录 index 内容并保留未暂存 hunks；
- 普通 porcelain 状态不会明确标识已解决但尚未完成的 merge，而完整 `git status` 可以识别该状态。
