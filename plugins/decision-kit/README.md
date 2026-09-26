# Decision Kit

通过主题编排、有依据的问答或可体验原型，为重要决定建立准确的共享理解，并按需维护项目领域词汇与长期重要决定。

Decision Kit 先调查可以确认的事实，再按任务范围选择完整塑形、独立访谈或最低成本原型。

## 安装

```bash
aw install decision-kit -p both
```

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`decision-shape`](skills/decision-shape/) | 建立、恢复或修订一个主题的共享理解；受委托的对齐也可通过一轮澄清完成 |
| [`decision-grill`](skills/decision-grill/) | 需要通过有依据的问答确认材料选择，一问或多轮均可 |
| [`decision-prototype`](skills/decision-prototype/) | 一个明确决定必须看到、运行、操作、实验或测量候选结果后才能作出 |
| [`project-context`](skills/project-context/) | 澄清项目特有词汇，维护已确认的重要决定、适用条件和必要理由 |

四个 Skill 都可以直接调用。`decision-shape` 恢复当前主题与已确认方向，协调 `decision-grill` 的材料问答和 `decision-prototype` 的证据反馈。方向变化时，它只重新打开受影响的决定。访谈和原型两个叶子 Skill 不互相调用，也不依赖 `decision-shape`。`project-context` 独立维护项目知识，不管理开发阶段；完整开发设计可使用 dev-workflow 插件的 `dev-design`。

`decision-prototype` 按主要不确定性选择逻辑演示、界面候选或技术实验，再选择反馈方式。Review Shell 负责呈现证据和收集输入。Shape 只吸收当前答案、成立条件、必要风险和证据指针。

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

- “建立或恢复这个主题的共识，按需澄清、访谈或制作原型” → `decision-shape`
- “我需要通过问答把一个材料决定想清楚” → `decision-grill`
- “只靠说无法判断，我需要看到、操作或测量候选结果” → `decision-prototype`
- “维护项目特有词汇，或为重要决定保留长期理由与边界” → `project-context`

## 边界

- 能从代码、配置或文档查到的事实不会反复询问用户。
- 普通实施任务中的局部歧义不会自动进入完整决策访谈。
- `decision-shape` 只在调用者提供路径、仓库有约定或跨会话确有价值时写入 Shape。
- 开发过程资料默认仅在本地 `.dev-workflows/<task>/` 保存，已有位置优先。长期术语与重要决定复用项目知识位置；没有等价位置且确有内容时可采用 `CONTEXT.md` 或 `docs/adr/`。只读请求不授权写入，普通文案修改无需调用知识维护能力。
- `decision-grill` 依据实际答复确认当前问题，保存遵循授权；综合产生新材料含义时再核对，已确认且无新增含义的回答无需机械重复确认。开放问题保持可辨。
- 持久化原型保存问题、可重放证据和结论；只有标准网页 Review 或用户明确要求时才需要 `prototype.json`。构建和迭代默认委派一个 Builder；极小新建、局部微调或子代理不可用时由主代理完成，主代理负责必要验收。
- `decision-prototype` 可以生成清楚标记的临时原型，并按需启动仅绑定本机的 Review 会话。页面用 tabs 展示单个大预览，可按需并排比较；用户选择总体判断后，页面才显示相关评论、受控参数或 drawer 标注。页面只有一个提交动作，同一 revision 的首个有效反馈生效。Agent 优先使用用户可交互的原生预览，脚本的 `open` 操作提供本机默认浏览器兜底；脚本技术失败后由 Agent 使用系统浏览器能力打开同一 URL，均失败则输出 URL 供用户自行打开。权限拒绝不能绕过。所有 `submitted` 回执直接包含当前 revision 已校验的完整反馈和文件路径。原型不会自动成为生产实现。

## Portable Agent Skills

四个 Skill 也可通过 portable-agent-skills 分发。使用 `aw skill install decision-kit --scope <project|user>` 安装，或使用 `aw skill materialize decision-kit --scope <project|user> --out <dir>` 导出。

## Review 默认期限

新会话默认有效 30 分钟。使用 `start --ttl` 可以设置本次会话期限，最大为 4 小时。

页面显示剩余期限，支持显式延长或取消本次会话。服务会自行到期，提交成功后也会自行关闭。`wait` 应在工具限制内采用较长等待窗口，避免短轮询。超时只结束当前等待，不取消仍有效的会话。原型和已保存的反馈继续保留。

Review Shell 的维护边界见 [`docs/prototype-review-ux.md`](docs/prototype-review-ux.md)，会话行为见 [`docs/prototype-review-runtime.md`](docs/prototype-review-runtime.md)。
