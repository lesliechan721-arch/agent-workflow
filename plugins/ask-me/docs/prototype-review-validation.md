# Prototype Review 调整验收

验收日期：2026-09-08。源码基线 `60aa8fad`，阶段 1–4 checkpoint 为 `d15284aa`、`2d6b2261`、`4fc72c4f`、`c61eb8fc`。环境为 macOS、Node.js 24.14.1、pnpm 10.33.0。

## 确定性与集成结果

| 验证 | 结果 |
| --- | --- |
| `pnpm build` | 通过，包含 TypeScript 编译与 manifest 生成检查 |
| `pnpm plugin:test ask-me` | Codex 52/52、Claude 52/52，无跳过（含整体 Review 回归） |
| `pnpm test:smoke:plugin-scripts` | 1/1 通过 |
| `pnpm test:smoke:ask-me-browser` | 实际物化插件，4/4 通过 |
| `aw plugin validate`、`aw plugin build`、`aw plugin status` | 通过；当前未升版本，存在预期的未发布变更提示 |
| 两份 `aw skill validate --codex-metadata required` | 通过 |
| 五份迁移 Eval 的项目 parser | 23 个 case 有效 |
| Markdown 相对引用、`git diff --check` | 通过 |

运行时测试覆盖无 waiter 提交后退出、独立到期、短 wait 超时不取消、同 revision 复用、跨两个 server 首个有效反馈、revision 失效、路径和物理身份边界、真实截止前提交检查、stop 终态确认与 3 秒强制关闭旧连接。打开测试覆盖重复和并发请求、显式 retry、连接等待、关闭过渡恢复与 launcher 超时退出。浏览器测试覆盖隔离脚本、标注与键盘、延长上限、取消、失联、到期和终态提交竞态。

AW 配置另用隔离 Catalog 和 AW_HOME 验证 default 30、user 45、project 75 的有效值；实际 `start` 读取项目 1 分钟配置后得到 60,000 ms 会话期限。未修改真实用户配置。

## macOS 桌面边界

本机默认浏览器实际打开临时 Review 页面，完成认证连接，重复 `open` 复用同一连接。认证测试客户端提交专用测试反馈后，服务自行退出；后续 `wait` 读取已保存反馈。该输入只验证协议，不表示用户作出了产品决定，也不证明真实用户点击了提交。

沙箱内的系统 opener 和 Chromium 首次启动受 macOS 桌面权限限制；相同验收命令经执行权限审核后通过。没有改变产品的隔离、Origin 或权限拒绝语义，没有关闭用户浏览器。

Windows/Linux opener 只有参数数组、环境资格与失败结果的确定性验证；真实桌面、WSL 桥接、原生用户预览及远程 URI 映射仍未验收。Headless Chromium 的交互通过不能替代这些环境证据。

## 模型 Eval

五个 suite：prototype-method 5、review-lifecycle 6、opening-policy 5、builder-workflow 4、prototype-evidence 3。计划每个 case 1 次，无 baseline。Oracle Audit 对应阶段 4 候选；method、lifecycle、opening、shape 的独立 Oracle Audit 通过。Builder 的初次 Audit 发现空产物、缺失文案比较和预写测量结果可被误判通过。已增加题目要求的内容检查，并把技术结果绑定到 Builder 的成功 stdout 重定向及后续无覆盖的执行顺序；另检查 Builder 首次完成之后的主代理只读核验与最终证据范围说明。旧失败 Audit 保留；最终修订版的独立 Audit 为 pass，公开 `audit validate --spec` 返回 `valid=true`。确定性评分只验证所声明的交付和执行合同，视觉质量仍由对应的 conversation Eval 判断。

规范 Runner 对 method suite 的一次执行在模型启动前被 Engine 阻断：`CODEX_PERMISSION_PROFILE=workspace` 不满足 Full Access 受管进程要求。没有执行模型，没有产生 EvalResult；其余 suite 未在同一已知阻断环境中重复尝试。未使用单次提权或 `--allow-unmanaged-processes` 绕过。模型行为验收仍是明确缺口；确定性测试和 Oracle Audit 不替代模型通过结论。

既有发布 required suite 保持不变，新三个探索性 suite 不成为发布门禁。本次验收不替代完整发布流程。

## 整体 Review 修复

整体 Review 复现并修复两个回执问题：`wait` 已收到取消或到期后，不再重新连接关闭中的服务而误报失联；页面已认证连接时，opener 后续失败不再覆盖 `connected`，其失败信息继续保留。前者仍优先读取已保存反馈，也不声称资源已关闭。

另根据系统 opener 的进程边界移除超时终止信号，仅解除 CLI 引用。确定性测试确认不发送终止信号，真实 Node 辅助进程测试确认调用者可以有界退出；这不替代 Linux 桌面实测。

另明确页面连接是历史就绪信号；用户关闭标签后可以用显式 `--retry` 重开同一会话。普通重复打开继续复用。整体 Review 后的运行时修复由定向合同测试验证，未重新运行模型 Eval。
