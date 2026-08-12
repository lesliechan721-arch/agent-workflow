# Skill Scripts 设计指南

插件内某个 skill 需要执行可复用命令、解析格式、验证输出或封装确定性逻辑时读取本文。

这里讨论的是 `skills/<skill>/scripts/`，脚本由 agent 按 `SKILL.md` 指令执行。插件根目录的 `scripts/` 属于 AW config、lifecycle、artifact renderer 和 `pnpm plugin:test` 合同，见 `references/aw-scripts-config-lifecycle.md`，两者不要混用。

## 何时使用脚本

优先直接调用已经存在的工具，命令应短、版本明确且容易一次写对。出现以下信号时改为 bundled script：

- 多个任务都会重新实现相同逻辑
- 命令已经包含复杂转义、管道或多步状态处理
- 需要稳定解析输入或生成结构化输出
- 需要机械验证模型产物
- 失败信息需要包含可操作的修复建议

不要为了隐藏一两行清楚的命令而创建脚本。

## 目录与引用

```text
skills/<skill-name>/
├── SKILL.md
└── scripts/
    ├── analyze.mjs
    └── validate.mjs
```

在 `SKILL.md` 中列出脚本用途，并使用相对 skill 根目录的路径：

```markdown
## 可用脚本

- `scripts/analyze.mjs`：分析输入并向 stdout 输出 JSON
- `scripts/validate.mjs`：验证结果；退出码 0 表示通过

## 工作流

1. 运行 `node scripts/analyze.mjs --input <path>`
2. 编辑结果
3. 运行 `node scripts/validate.mjs --input <path>`
4. 验证失败时按 stderr 提示修复并重跑
```

不要依赖 agent 猜测脚本参数或从源码逆向接口。

## 依赖与可重复性

- 优先使用宿主已保证的运行时和标准库
- 需要额外运行时、系统包或网络时，在 `compatibility` 和正文中说明
- 一次性包执行要固定版本，避免每次解析到不同实现
- bundled script 要自包含，或在同一 skill 中清楚记录依赖和安装方式
- 不要假设仓库根 `node_modules`、全局 PATH 或当前工作目录恰好满足依赖

AW 插件根脚本存在更严格的离线依赖和打包合同；不要把那套 `scripts.node.packageRoot` 约定自动套到 skill scripts。

## 面向 agent 的命令接口

### 非交互

脚本不得等待 TTY、密码对话框或确认菜单。输入只通过：

- 命令行 flag
- 环境变量
- stdin
- 明确的输入文件

缺少输入时立即失败并给出完整用法，不要挂起。

### `--help`

每个有参数的脚本都应支持 `-h` / `--help`，至少包含：

- 一句话用途
- 必填参数和默认值
- 输出格式
- 退出码
- 一到两个真实示例

保持 help 简短，因为输出会进入 agent 上下文。

### 可操作错误

错误要同时说明：

1. 哪里错误
2. 期望什么
3. 实际收到什么
4. 下一步如何修复

例如：

```text
Error: --format must be one of json, csv, table.
Received: xml
Run with --help for examples.
```

不要只输出 `invalid input` 或原始 stack trace。

## 输出合同

- 机器数据优先使用 JSON、JSONL、CSV 或 TSV
- 数据写 stdout，进度、warning 和诊断写 stderr
- 成功退出码为 0；不同失败类型需要被调用方区分时使用有文档的非零退出码
- 默认输出摘要或合理上限，避免工具输出被截断
- 大结果支持 `--output <file>`、分页、limit/offset 或显式 opt-in stdout

如果输出只供人阅读且没有下游解析，可以使用简洁文本，不需要为了结构化而制造复杂 schema。

## 安全与重试

- agent 可能重试命令，脚本应尽量幂等
- 对歧义输入 fail closed，不要猜测路径、环境或目标
- 有状态或破坏性操作提供 `--dry-run`，并使用安全默认值
- 覆盖、删除、发布或部署需要明确的目标和确认 flag
- 不在 argv、stdout、stderr 或异常中打印 secret
- 临时文件使用受控目录，并在成功或失败时清理

## 测试

至少覆盖：

- `--help` 成功且信息完整
- 正常输入的退出码和 stdout shape
- 缺少参数、非法枚举和不存在文件的可操作错误
- 重复运行的行为
- dry-run 不产生写入
- 大输出不会默认淹没上下文

机械检查用脚本断言；模型最终输出质量仍按 `references/skill-evaluation.md` 评估。

## 完成检查

- [ ] 脚本确实消除了重复或脆弱逻辑
- [ ] SKILL.md 列出脚本用途和准确调用方式
- [ ] 依赖、版本和环境要求明确
- [ ] 不使用交互式输入
- [ ] 支持 `--help` 和可操作错误
- [ ] stdout 与 stderr 职责清楚
- [ ] 具备幂等、安全默认值和必要的 dry-run
- [ ] 输出大小可预测
- [ ] 关键成功与失败路径有测试

## 上游参考

- [Using scripts in skills](https://agentskills.io/skill-creation/using-scripts)
- [Best practices for skill creators](https://agentskills.io/skill-creation/best-practices)
