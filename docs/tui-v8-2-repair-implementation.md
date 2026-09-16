# TUI v8.2 修复实施与验证

需求依据：[修复 Spec](tui-v8-2-repair-spec.md)。原始实现基线：`7cc2136d`。本次修改在当前工作区交付，不包含提交或发布。

当前状态：F01–F08 已实现；最终全量验证通过，两份独立审查均未发现范围内未关闭的 P0–P2 问题。

## 修改与追踪

| 评审项 | 实现位置与结果 |
| --- | --- |
| F01 | `utils/plugin-intent-state.ts` 提供声明观察状态；`commands/status-v6.ts` 将同次观察交给 `tui/controller-runtime.ts`，删除提醒的第二次读取。`tui/controller.ts` 与首页保留项目问题，健康入口仍可使用。 |
| F02 | `tui/controller.ts` 将复查绑定到结果生命周期和操作记录；合并重复请求，离页或会话结束后取消并丢弃响应；有效复查更新原记录，保留诊断和执行事实。 |
| F03 | `portable/skills-cli.ts` 将外部清单投影到本次目标；公开 receipt 的 schema 不变。请求 Agent 必须与观测记录可靠绑定，不能仅信任 `--agent` 参数。结果独立显示使用范围；没有 receipt 的 blocked 结果从已授权 intent 取得范围和 Agent 模式，不生成验证事实。 |
| F04 | `tui/console-app-v4.tsx` 以最终 Skill×Agent 行集合计算单组合分页，使用 `attemptedTargets` 保留精确重试边界；成功与部分结果共用技术布局，按实际固定内容为焦点动作预留空间。完整字段入口逐页显示长 Skill、Agent、状态及摘要，返回恢复原阅读动作。 |
| F05 | 项目提醒和帮助等弹窗复用安全退出路径，默认“稍后处理”和既有守卫保持。 |
| F06 | 补齐技术详情、来源引用、依赖阻止移除页及依赖引用详情的基本键和可聚焦翻页动作，使键盘与显示条目集合一致；技术分页保留所选引用身份。 |
| F07 | Skills 候选与固定操作栏分离焦点；继续和选择工具固定可达，工具不会选中隐藏项。 |
| F08 | 来源和存储普通页面使用用户说明；内部字段保留在技术详情；受影响菜单使用稳定动作标识并移除末尾省略号。 |

以上源码路径位于 `packages/cli/src/`。

F03 的外部依据是 Skills CLI v1.5.23 的 [JSON 列表输出](https://github.com/vercel-labs/skills/blob/v1.5.23/src/list.ts) 和 [安装目录扫描](https://github.com/vercel-labs/skills/blob/v1.5.23/src/installer.ts)。上游返回显示名，指定 Agent 的查询仍可能包含其他目录的记录。实现仅使用有依据的常规名称规范化；无法可靠绑定时报告 unknown，不猜测别名，也不生成直接重试目标。

## 最终验证

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 完整 TUI 交互文件 | Console + Portable，472 项通过 | `.tmp/tui-v8-2-repair/round3-ui.log` |
| 完整依赖图测试文件 | 16 项通过，保留所有引用与完整身份断言 | `.tmp/tui-v8-2-repair/round3-dependency.log` |
| `pnpm build` | 最终正式构建退出 0 | `.tmp/tui-v8-2-repair/build.log` |
| `pnpm test:unit` | 退出 0；3,014 项通过、2 项既有跳过，包含 CLI filesystem 2,446 项及 process-lifecycle 173 项 | `.tmp/tui-v8-2-repair/unit.log` |
| `pnpm test:integration` | 退出 0；502 项 integration 和 3 项 process-lifecycle 通过 | `.tmp/tui-v8-2-repair/integration.log` |
| 双尺寸生产 PTY | 28/28 场景通过；全部退出 0，无场景错误；生产构建摘要一致 | `.tmp/tui-v8-2-repair-pty/evidence/` |
| 完整双轴独立审查 | 完整 F01–F08 与关联回归未发现未关闭的 P0–P2 问题 | `.tmp/tui-v8-2-repair/review-final.md` |
| `git diff --check` | 通过 | 最终工作区 diff 检查 |

初次在默认沙箱运行关联测试时，断言通过，但测试包装器无法核验进程归属，退出 1；允许本地进程检查后完整重跑通过。没有绕过包装器或关闭清理核验。

## 审查与终端证据

按原定预算完成三轮有界修复。每轮之后均安排新上下文，对完整 F01–F08 与关联回归做需求/设计和工程/项目标准双轴审查。修复包括普通文案与小屏布局、成功技术结果与范围、依赖基本键分页，以及长结果字段的完整阅读。测试适配保留业务验收，修正提醒等待、批量结果采样和引用阅读路径。

早期失败日志、审查摘要及 PTY 帧保存在 `.tmp/tui-v8-2-repair/`，详细索引为 `work.md`。曾有一次 unit/integration 并行运行导致单个集成用例超时；后续顺序执行，未修改超时或包装器。最终验证只采用最终冻结源码对应的证据。

真实 PTY 使用 60×18、80×24，覆盖 100/200 Skills 固定栏、结果及技术分页、范围/恢复/焦点、退出守卫、来源与存储、依赖阻止页、非末项长引用和真实窗口缩放。新增长结果场景逐字符重建两个同前缀 64 字符 Skill、128 字符 Agent 和 71 字符 SHA-256，检查状态与返回焦点。运行命令、构建摘要、输入序列和完整终端帧记录在 evidence 的 `REPORT.md`、`summary.json` 与场景目录中。

最终终端记录时间为 `2026-09-16T22:36:36+0800`。记录器曾对跨读取块的 ANSI 序列处理不完整，修正并重录后，28 个场景通过；完整帧未发现控制码污染。该修正仅涉及临时记录器，生产构建未变化。常规长度的长 Skill 由 mounted Ink 测试持续覆盖，64 字符合法上限由真实 PTY 精确验证。

## 验证边界

测试使用隔离 home、项目和受控外部工具。PTY 使用真实 Ink 与当前生产构建；合成依赖不构成真实第三方安装证明。未执行联网安装、真实用户平台写入、发布或全部 156 个设计场景逐页截图。其他操作系统的真实终端行为未在本次机器上证明。

详细日志和终端产物在 `.tmp/`，跨工作区交接需要一并提供。
