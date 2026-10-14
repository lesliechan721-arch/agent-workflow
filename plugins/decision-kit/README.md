# Decision Kit

先看清需求全貌，再通过问答、可体验原型和领域知识维护，为重要决定建立准确的共享理解，减少遗漏和反复确认。

Decision Kit 先调查可查事实，保留原始要求和开放问题，再按任务范围选择主题对齐、独立访谈、最低成本原型或知识维护。

## 安装

```bash
aw install decision-kit -p both
```

安装会同时满足 `human-content` 依赖，为复杂材料提供 `explain-for-review`。普通短问题仍直接说明，不强制制作阅读页。

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`decision-shape`](skills/decision-shape/) | 检查需求整体覆盖，组织问答、原型与知识维护，交付当前共识及剩余缺口 |
| [`decision-grill`](skills/decision-grill/) | 需要通过有依据的问答确认材料选择，一问或多轮均可 |
| [`decision-prototype`](skills/decision-prototype/) | 用早期候选、操作演示或实验校准布局、行为、状态关系及可行性 |
| [`project-context`](skills/project-context/) | 澄清领域概念与关系，及时维护已确认词义和重要决定的理由 |

四个 Skill 都可以直接调用。`decision-shape` 负责整体需求覆盖、方法选择与对齐完成判断，协调问答、原型和知识维护，并按需使用 `explain-for-review` 呈现已有复杂材料。方向变化时只重新打开受影响的决定；范围内尚未展开的主题不会被当成已经排除。三个叶子能力可独立完成本职工作，不反向依赖 Shape。完整开发设计可使用 dev-workflow 插件的 `dev-design`，由它衔接对齐、规格和审查。

`decision-prototype` 按主要不确定性选择逻辑演示、界面候选或技术实验，再选择反馈方式，不必等文字讨论失败。Review Shell 负责呈现证据和收集输入。Shape 保留当前答案、接受范围、成立条件、必要风险和证据指针；Context 将确需长期保留且已确认的知识更新到既有位置。

## 典型用法

```text
把这个复杂的产品方向通过问答和必要原型完整塑形，最后给我一份当前有效的 Shape。
```

```text
围绕新的权限模型逐轮提问我，直到目标、取舍、失败路径和验证方式都清楚。
```

```text
这个审批页面怎么排版我说不清。做一个可点击原型让我试。
```

```text
项目中的 account 同时指租户和登录账号。基于现有资料澄清词汇，并把已确认的定义维护到现有词汇表。
```

## 四个 Skill 怎么选

- “检查需求有没有遗漏，建立或恢复共识并按需问答、试原型、维护知识” → `decision-shape`
- “我需要通过问答把一个材料决定想清楚” → `decision-grill`
- “用具体候选或实验校准这一处体验、行为或技术选择” → `decision-prototype`
- “澄清项目概念、关系，或维护已确认的重要词义与决定” → `project-context`

## 边界

- 能从代码、配置或文档查到的事实不会反复询问用户。
- 普通实施任务中的局部歧义不会自动进入完整决策访谈。
- `decision-shape` 只在调用者提供路径、仓库有约定或跨会话确有价值时写入 Shape。
- 开发过程资料默认仅在本地 `.dev-workflows/<task>/` 保存，已有位置优先。长期术语与重要决定复用项目知识位置；没有等价位置且确有内容时可采用 `CONTEXT.md` 或 `docs/adr/`。只读请求不授权写入，普通文案修改无需调用知识维护能力。
- `decision-grill` 依据实际答复确认当前问题，保存遵循授权；综合产生新材料含义时再核对，已确认且无新增含义的回答无需机械重复确认。开放问题保持可辨。
- 持久化原型保存问题、可重放证据和结论；只有标准网页 Review 或用户明确要求时才需要 `prototype.json`。构建和迭代默认委派一个 Builder；极小新建、局部微调或子代理不可用时由主代理完成，主代理负责必要验收。
- `decision-prototype` 可以生成清楚标记的临时原型，并按需启动仅绑定本机的 Review 会话。页面用 tabs 展示单个大预览，可按需并排比较；用户选择总体判断后，页面才显示相关评论、受控参数或 drawer 标注。页面只有一个提交动作，同一 revision 的首个有效反馈生效。Agent 优先使用用户可交互的原生预览，脚本的 `open` 操作提供本机默认浏览器兜底；脚本技术失败后由 Agent 使用系统浏览器能力打开同一 URL，均失败则输出 URL 供用户自行打开。权限拒绝不能绕过。所有 `submitted` 回执直接包含当前 revision 已校验的完整反馈和文件路径。原型不会自动成为生产实现。

## Portable Agent Skills

四个 Skill 也可通过 portable-agent-skills 分发；完整依赖闭包同时提供 Human Content 的 `explain-for-review`。使用 `aw skill install decision-kit --scope <project|user>` 安装，或使用 `aw skill materialize decision-kit --scope <project|user> --out <dir>` 导出。

## Review 默认期限

新会话默认有效 30 分钟。使用 `start --ttl` 可以设置本次会话期限，最大为 4 小时。

页面显示剩余期限，支持显式延长或取消本次会话。服务会自行到期，提交成功后也会自行关闭。`wait` 应在工具限制内采用较长等待窗口，避免短轮询。超时只结束当前等待，不取消仍有效的会话。原型和已保存的反馈继续保留。

Review Shell 的维护边界见 [`docs/prototype-review-ux.md`](docs/prototype-review-ux.md)，会话行为见 [`docs/prototype-review-runtime.md`](docs/prototype-review-runtime.md)。
