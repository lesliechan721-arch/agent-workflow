# aw-skill-eval-runner

为 AW Agent Skill Eval 提供默认的准备、独立审核、执行和结果验证入口。安装后可直接请求 `run-aw-skill-evals` 处理已有 EvalSpec，或从 plugin/Skill 选择开始。

## 安装

```bash
aw install aw-skill-eval-runner -p both
```

安装会同时解析 `agent-skill-toolkit` 依赖。运行需要当前 `aw` 和 `aw-skill-eval` 可执行文件。

## 典型用法

```text
使用 $run-aw-skill-evals 执行这个 spec.json；先复用同目录 Audit，并显示预计模型调用数和输出位置。
为 plugin-a 的 skill-a 准备 validation cases 并验证，但这次不要执行模型。
```

## 用户可见边界

- 执行前只从已验证 Spec/cases 显示 cases、runs、baseline、预计真实调用数、provider 进程类别、可能使用现有 credential 环境、模型网络和输出路径。
- 明确请求且不超过 10 次内置模型调用时直接执行；超过 10 次或 custom process 会再次确认。
- 默认 run 要求 Full Access 和进程树检查可用。单次提权不等于 Full Access；只有用户明确接受后，本次调用才可使用 `--allow-unmanaged-processes`，且该模式不保证清理后代进程。
- macOS 的所有真实 run 都先解析所选 Codex 可执行入口并检查用户 keychain search list；检测到 cmux shim/wrapper 或 `accountsKeychainExport` 时停止，且不会修改 keychain。
- Audit 精确绑定 provider、workspace、current/previous target、case digest 和 selected cases；`runs` 或 `timeoutMs` 改变不影响复用。旧版字符串 `workspace` v1 Spec 必须重新 prepare 和 Audit。
- clean success 直接返回包含进程管理证据的已验证 EvalResult v2；只有异常、混合、回归或将修改 Skill 时才做独立 result-triage。
- 普通成功路径不运行环境 doctor；只有安装或版本升级、用户明确请求诊断或模型已启动后的执行失败时才进入高级诊断。doctor 会报告 permission profile、keychain 状态及 managed/unmanaged 可用性。
- 插件不设计 Eval、不修改 Skill，也不作 Quality Review 或发布决定。
