# Review Loop Eval

保留迁名前的 trigger、behavior 用例及 ID。invocation-boundary 检查被测能力是否加载，允许合法辅助能力；公开 Selected Cases 不提供首次入口字段。entry-behavior 的历史报告是合成输入，只检查对已给材料的处理。

adaptive-coverage-workflow 使用 Engine 的 prepare、setupPrompt、measurementStart 和独立 semantic grader，覆盖已知工作先修、测试修复后的旧证据适用性、A→C 累计差异、明确全新双轴重评及缺失基线。准备轮的真实审查不计为本轮修改，报告与版本由实际执行者形成。来源、独立性或实际读取不可确认时保留 unknown。

测试资源夹具有实际目录泄漏；独立 Node Oracle 检查资源清理与产品合同，允许删除临时根目录。累计差异夹具保留真实 A/B/C 内容，B→C 只有注释，A→C 含租户回归。它未建立实际 B 轮复用判断，不证明一次复用后的原点维护。

规范 adapter 位于 dev-build 的 Eval 目录。运行 `node plugins/dev-workflow/scripts/sync-workflow-evals.mjs --write` 更新 Eval-local 副本，`--check` 检查副本一致。副本不进入运行包。

准备当前工作流用例：

```bash
aw skill eval prepare dev-workflow dev-review-loop \
  --suite adaptive-coverage-workflow --profile project-default \
  --runs 1 --output .aw/evals/review-loop-coverage --json
```

准备和确定性测试不代表模型通过。模型执行使用 `run-aw-skill-evals` 的独立 Audit、成本授权及进程权限要求；既有 suite 的发布标记保持原值。
