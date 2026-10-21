# Git Commit 评测

## 准备与运行

`aw skill eval prepare` 每次按 manifest 注册的一个 suite/profile 和可选 case/split 选择生成 `EvalSpec v1`。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare git-toolkit \
  git-commit --suite trigger --profile project-default \
  --output /tmp/aw-eval-specs/git-commit-materialization --json
```

需要模型时，先验证 Spec。复用与 current、可选 previous-version target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。取得本次成本与副作用授权后，Runner 执行：

```bash
aw-skill-eval run /tmp/aw-eval-specs/<spec-dir>/spec.json --audit /tmp/aw-eval-specs/<spec-dir>/audit.json
```

该命令生成 `EvalResult v2`。随后运行 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>`。clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才由全新上下文做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。

`git-commit` 仅由用户显式调用。`trigger-cases.json` 保留 4 条 validation 反例，覆盖普通提交、已暂存提交、提交并推送和只拟写 message；它们都不应隐式加载此技能。无需再优化自然语言提交请求的召回率。

显式 `$git-commit` 由 Codex 在模型运行前注入，不用 shell 读取事件判断是否加载。行为用例使用显式入口；`without-skill` 对照只移除调用前缀，保留实际任务和同一 fixture。平台产物测试核对 Codex 的 `allow_implicit_invocation: false` 和 Claude 的 `disable-model-invocation: true`、`user-invocable: true`。

## 行为评测

`behavior-cases.json` 和 `run-commit-evals.mjs` 定义 8 条可写 provider 用例，覆盖非琐碎 body、琐碎提交、部分暂存、范围外已暂存内容、仓库 message 规范与明确门禁、提交后继续 push、进行中的 Git 操作和 hook 拒绝。

每条断言用 `grader_check` 绑定判定项：`script` 检查 Git 状态、提交范围、格式、remote ref 和 hook；`model` 判断说明是否忠实于实际 diff、报告是否准确，以及是否超出提交验证职责。语义判断接受等价措辞和只记录新版本号，不以关键词或固定句式代替事实。

每个 behavior attempt 启动一次被测 Codex，再在没有被测 Skill 的新目录启动一次只读 Codex 评分。评分输入包含实际提交 diff、message、前后 Git snapshot、命令记录和最终答复；两次调用共享 Engine 的 attempt deadline，usage 汇总为本次费用。评分失败、缺项、重复项或 unknown 均不能通过，不自动重试。准备 Audit 和批准运行时，应计入这两次模型调用。

`provider-evidence.json` 保存机械检查、逐项语义结论与依据；`codex-events.jsonl` 和 `semantic-grader-events.jsonl` 分别保存执行与评分轨迹。确定性测试中的 fake judge 只证明协议、隔离和失败传播，不能证明真实语义评分质量。真实模型运行仍需正式 Audit 和成本授权。

## 准备触发与行为评测 Spec

```bash
aw skill eval prepare git-toolkit git-commit --suite trigger --profile project-default --split validation --runs 1 --output /tmp/aw-eval-specs/git-commit-trigger-validation-debug --json
aw skill eval prepare git-toolkit git-commit --suite behavior --profile project-default --case staged_only_with_unstaged_hunks --output /tmp/aw-eval-specs/git-commit-behavior-debug --json
```

每个所选 suite/profile 应分别准备对应 Spec 并交给 `$run-aw-skill-evals`。

trigger fixture 使用同时包含已暂存、未暂存和未跟踪内容的临时 Git 仓库。

插件 fixture module 只负责构造 Git 状态和语义 snapshot；每次运行前后都会比对 Git refs、配置、tracked/untracked 内容和状态，一旦观察到成功读取目标 `SKILL.md` 就立即停止。

默认每条运行 3 次；本 suite 的 validation 反例要求零误触发。EvalResult 保存每次运行的状态、usage、grade 和输出目录，便于复现。

## 常规插件测试

```bash
pnpm plugin:test git-toolkit
```

常规插件测试验证：

- 手动调用策略、trigger/behavior corpus、Git fixture 和环境隔离；
- 独立评分输入、输出、usage、脱敏及不完整评分的失败传播；
- `pnpm plugin:test` 临时 bundle 中 Claude/Codex 的实际模板渲染结果；
- 部分暂存提交只记录 index 内容并保留未暂存 hunks；
- 普通 porcelain 状态不会明确标识已解决但尚未完成的 merge，而完整 `git status` 可以识别该状态。
