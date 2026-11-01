# AW 与通用方法的集成用例

`project-default` profile 提供 `develop-aw` 及必要的通用能力。`integration-trigger` 检查普通或显式通用任务中的 AW 适用性；`review-materialization` 检查已有包、来源和准备范围；`review-diagnostic` 检查 CLI 不可用时的证据边界；`simplify-source` 检查可重建输入、权威修改位置、同条件产物和绑定。

被测对象均为 `develop-aw`。Reviewer/Simplifier 是参与者，仍负责质量判断与候选方法；本组主要评价 AW 适配是否提供正确事实、选择适当操作并保持权限边界，不以通用方法的独立质量指标评价 AW 技能。

使用 Selected Cases v1 / Manifest v1，正式格式由公开 parser 核验。`review-fixtures`、`simplify-fixtures` 与 `fixtures/deny-cli-bin` 是显式测试替身，不证明生产 renderer、canonical binding、用户真实安装或模型收益。它们拒绝未知操作，不作为实际发布证据。

用户专用能力需采用客户端实际支持的显式选择路径；prompt 中写出 `$review-agent-skill` 或 `$simplify-agent-skill` 本身不证明宏已注入。缺少真实调用观测时报告范围限制，不把它记为模型理解或手动边界通过。

当前状态为 NOT_RUN。运行前独立审核 Oracle、fixture 可达性及实际目标绑定，并取得模型预算与执行授权。suite/profile 选择由 [manifest.json](manifest.json) 定义；Audit 与 Result 按实际目标和输入重新核验。物化和工作区观测边界见 [物化案例说明](review-materialization-README.md)。
