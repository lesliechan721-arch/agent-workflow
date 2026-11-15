# Execution and Safety

## Provider 调用估算

- trigger：cases × runs × variants；
- conversation：上述 provider attempts 的 2 倍（conversation + grader）；
- workflow：cases × runs × variants 个 Engine attempt；后代 turn 取决于真实委派；
- custom-process：调用数和副作用未知。

## 进程与 credential

内置 provider 可以访问模型网络并使用现有 credential 环境，但不读取或显示值。custom-process 是可信协作进程，不是任意程序 sandbox；任何执行都需要确认。

Engine 在输出目录和模型启动前执行权限、macOS Codex/keychain 与进程管理预检。默认 managed 模式要求整个 Codex 会话具备 Full Access 语义，且进程树检查可用；单次 `sandbox_permissions=require_escalated` 不改变会话权限。被拒绝后说明如何切换整个会话，不自动重试或绕过。

只有用户明确接受本次风险，才可传 `--allow-unmanaged-processes`。非受管模式只尽力终止直接 provider child，不保证后代进程清理；它不绕过 macOS 检查。managed 也不承诺宿主崩溃或强制结束后的完整清理。

macOS 上由 Engine 解析实际 Codex 可执行入口并检查 keychain search list；cmux shim/wrapper 或 `accountsKeychainExport` 会阻断执行。不要修改用户 keychain 来解除阻断，也不要改 executable 或环境绕过。只披露状态，不读取或显示 credential 值。

## 失败

- 不自动 retry；
- validator 失败是机器合同错误；
- doctor 只用于安装/升级、用户显式诊断或模型已启动后的 run 失败定位；普通成功路径和启动前明确拒绝不追加诊断链；
- doctor 不替代 Spec/Audit/Result，也不授权重试。
