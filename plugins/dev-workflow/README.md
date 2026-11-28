# Dev Workflow

把开发设计、功能实现、故障定位、重构简化、性能优化、分层审查与真实验证整合在一套可组合的开发工作流里：既可以通过手动总入口按目标走完整路线，也可以按场景直接触发单项工程与验证能力。

## 安装

```bash
aw target set codex claude
aw plugin install dev-workflow --scope user
```

支持 Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI 和 Grok Build；`generic` 只输出通用 Skills。

安装会自动检查同源依赖 `decision-kit`、`human-content` 和 `agent-subagent`，分别提供产品决策访谈/原型、复杂材料清晰呈现与跨平台子代理调度。`dev-workflow` 自身不要求任何必填配置；若当前环境尚未初始化 `agent-subagent` 且目标不是 `generic`，首次连带安装会先由 `agent-subagent` 引导完成基础档位配置。

## 包含的 Skill

### 显式手动入口（4 个）

仅由用户显式调用（Codex 关闭隐式触发，Claude Code 关闭模型自触发），不会被其他工作流自动拉起：

| Skill | 什么时候使用 |
| --- | --- |
| [`dev-workflow`](skills/dev-workflow/README.md) | 从完整目标出发，自动选入设计、功能、修错、重构、性能、持续寻优或大型组合路线并完成验证闭环 |
| [`dev-design`](skills/dev-design/README.md) | 形成或修订可直接施工的开发设计与按需规格，严格停在写代码之前 |
| [`dev-correct`](skills/dev-correct/README.md) | 把仓库里反复出现（≥2 次）的错误按“架构 → 类型/Lint → 行为测试 → 文档”逐级固化为防线 |
| [`dev-verify-author`](skills/dev-verify-author/README.md) | 为项目创建、维修或维护可复跑的验证基础设施、功能地图或形式化模型 |

### 主动工程与验证能力（8 个）

按任务语义自动触发，也可显式点名调用：

| Skill | 什么时候使用 |
| --- | --- |
| [`dev-investigate`](skills/dev-investigate/README.md) | 只读解释代码运行机制与状态权威（How）、查证历史设计理由（Why）或分析 profile/heap/trace 捕获 |
| [`dev-debug`](skills/dev-debug/README.md) | 亲手复现故障、二分排除假设并用运行证据锁定根因（不凭猜测叠补丁） |
| [`dev-architect`](skills/dev-architect/README.md) | 跨模块/接口改动写代码前，先用调用示例和两套具体类型签名定清边界与状态所有权 |
| [`dev-arena`](skills/dev-arena/README.md) | 面对高代价或有实质分歧的设计/实现，并行生成多个独立候选、经独立裁判评判后选基并手工嫁接优点 |
| [`dev-tdd`](skills/dev-tdd/README.md) | 新增/修改自动化测试或要求先红后绿 TDD 回归保护，过滤锁内部实现的伪测试 |
| [`dev-review`](skills/dev-review/README.md) | 只读审查代码、PR、设计或变更影响面；可运行高危变更或显式压测请求自动升级多代理实测破防 |
| [`dev-verify`](skills/dev-verify/README.md) | 在真实 CLI、API、UI、存储或异步表面核验改动是否兑现承诺，拦截编译绿等代理指标伪通过 |
| [`dev-benchmark`](skills/dev-benchmark/README.md) | 按 7 项硬核检验核查延迟、吞吐、提速/回归声明，给出明确裁决 |

## 典型用法

```text
使用 $dev-design 为这套插件配置迁移形成可实施设计，说明状态所有权和未决项，先不写代码。
```

```text
使用 $dev-workflow 新增带并发上限和取消清理的导出命令，并用真实 60k 行样本验证。
```

```text
审查当前分支相对 main 的改动与隐蔽影响面；如果触及并发锁或持久格式，直接做实测压测。
```

```text
核验这次索引构建优化的提速数字是否可信，给出交替多轮中位数、极差和真实瓶颈。
```

## 可选面板配置

插件自身 0 必填。常规编码与子代理委派直接沿用 `agent-subagent` 的基础档位与复杂度路由；如需为当前平台固定多视角竞争或对抗实测的座次，可在平台设置页按需配置以下可选字段：

- `arenaRunners`：`dev-arena` 并行候选使用的执行器与模型座次列表（最多 8 项）。
- `arenaCrossJudge`：`dev-arena` 独立只读裁判的模型配置；留空时仍默认启动 1 名干净上下文独立裁判。
- `reviewAdversaries`：`dev-review` 对抗实测模式使用的隔离对抗者座次列表（最多 8 项）。

未配置且任务未禁止外发时，多候选、独立裁判与对抗实测会软偏好组合异构外部执行器或宿主多家族模型，无可用异构能力时回退同源隔离并如实披露。

## 边界

- **只读与设计硬边界**：`dev-design` 严格停在写代码之前；`dev-investigate`、`dev-review`（含对抗破防）只读报告，不直接修改产品代码。
- **外部传输边界**：凡任务明确禁止外发材料，此约束优先于未配置默认路由和已配置的外部面板，一律限定宿主原生执行（若同时显式硬要求外部执行器，则停止并报告冲突）。
- **验证与防呆边界**：`dev-verify` 不会在缺少入口时越权建设整套验证资产（需显式启动 `$dev-verify-author`）；`dev-correct` 只固化重复出现 ≥2 次的错误类；不可逆外部动作（部署、删真实数据、强推共享分支、对外发信）仍需明确授权。
