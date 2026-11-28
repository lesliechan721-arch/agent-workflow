# Decision Kit

在动手设计或编码之前，通过有边界的逐轮访谈和最低成本的可丢弃体验原型，把未定的产品取舍、交互方向与隐藏假设落成清晰、可追溯的决定。

## 安装

```bash
aw target set codex claude
aw plugin install decision-kit --scope user
```

支持 Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI 和 Grok Build；`generic` 只输出通用 Skills。

安装会自动检查同源依赖 `human-content`，在复杂已有材料妨碍理解时提供 `explain-clearly`。普通短问题直接沟通，不强制制作阅读页。

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`decision-grill`](skills/decision-grill/README.md) | 围绕计划、业务规则或重要产品选择逐轮追问，主动暴露分支、假设与后果，直到关键取舍明确 |
| [`decision-prototype`](skills/decision-prototype/README.md) | 布局、信息层级、操作流或状态关系难靠文字说清时，用低成本可丢弃原型取得真实反馈并记录接受边界 |

## 典型用法

```text
围绕新的租户退出与数据保留规则逐轮问我，先查清楚仓库现状，把遗漏分支和后果问透。
```

```text
这个审批页面的筛选和详情排布我拿不准，把两三种实质不同的方案放进同一个切换器里让我点点看。
```

## 两个 Skill 怎么选

- **想通过问答把目标、业务规则、分支和后果想清** → `decision-grill`
- **想亲手体验具体布局、操作或状态演示再拍板** → `decision-prototype`
- **只需把已有复杂文档、规格或机制讲清楚（不探索未定新方案）** → `explain-clearly`

## 边界

- **可查可跑的不问人**：能从仓库代码、配置或最小实验中确认的事实由 Agent 自行核查或实测后给出带证据的推荐，不抛给用户凭直觉猜；纯内部工程选型归工程设计，不拉用户做原型仪式。
- **不自动实施产品**：两项能力停在确认共识与记录接受边界，不自动修改生产代码；原型明确标注为一次性临时产物，复用为生产实现需另行决定并按工程标准重评估。
- **提交不等于接受**：多轮原型修订递增 revision，旧 revision 的反馈不能批准新版本；构建子代理交付演示也不等于用户已接受。
- **本机 Review 会话**：按需启动仅绑定本机的网页 Review 服务，默认有效 30 分钟（`start --ttl` 最高 4 小时），支持页面延长或取消，提交成功后自动关闭并保留原型与已校验反馈文件。
- **写入与外部动作**：持久化原型默认写入调用方指定目录或 `.dev-workflows/<decision-id>/prototypes/`，不覆盖生产源码；只读请求不触发写入。
