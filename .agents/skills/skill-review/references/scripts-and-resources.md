# Scripts and Resources

当被审 Skill 包含 scripts、references、assets，或模型在每次运行中重复实现确定性逻辑时读取。

## 是否应该脚本化

适合脚本：解析、转换、生成、计算、格式校验、静态一致性、批量重复操作和可机械验证的 assertion。

不适合普通脚本：真实 agent 状态、mailbox、取消、竞态、权限决策，或用文件/Git/shell 侧信道推断 runtime 生命周期。

删除复杂功能通常优于为非核心机制增加脚本。

## Agent-facing 脚本检查

- 从 skill 根目录使用相对路径；`SKILL.md` 说明用途、输入、输出和调用 branch。
- 自包含或明确并固定依赖；声明必要 runtime 和权限。
- 非交互；支持 `--help`；错误可操作；退出码有意义。
- stdout 为 JSON、CSV、TSV 或短而稳定的结构；diagnostics 写 stderr。
- 输入校验、输出大小、超时、路径遍历、覆盖写和敏感信息有安全边界。
- 重复运行尽量幂等；破坏性操作提供 dry-run 或 plan/validate/execute。
- 有 fixture、测试或安全样例；release 模式只执行 reviewer 确认无副作用的检查。

脚本不存在不自动扣分；当模型不会重复实现确定性逻辑时，保持纯文本更好。

## Information hierarchy 与资源

资源按用途分类：

- `references/`：按需读取的定义、规则、领域资料和长 reference。
- `assets/`：模板、示例、图片、静态数据；不隐藏必须执行的指令。
- `evals/`：测试提示、assertion、fixture 和结果结构。
- environment lookup：schema、配置、源码、目录或 `--help`，通常不应被低价值复制进 reference。

检查每个资源：

- 是否由 `SKILL.md` 一层指针到达。
- 指针是否说明读取条件，而非只命名路径。
- 是否属于真实 branch，还是每次都必须加载。
- 是否与其它文件重复或把一个概念 scattering 到多个位置。
- 是否有权威 owner、来源、核验日期和更新策略。

## Co-location

同一概念的定义、规则、例外和评分锚点应位于一个权威位置。其它文件可以指向它，但不复制完整规则。

- duplication：同一意义在多处重复。
- scattering：同一意义被拆散，读一处无法得到完整概念。
- co-location：相关内容在同一标题下共同出现。

平坦的同层 review 规则可以保留在一个 reference 中；不要为了“渐进式披露”机械拆成大量小文件。

## Environment as source of truth

优先读取环境能够直接回答的事实。只有以下内容值得缓存：

- 为什么选择某个值或工具。
- 环境文档没有表达的项目约定。
- 反直觉且模型会稳定误判的 gotcha。
- 离线 quick review 必需的最小摘要，并带核验日期。

release 评审应重新核对 current-check 来源，不把旧缓存当成规范。
