# 当前 Native 资格依据

本目录只保留当前有限能力声明所引用的固定版本证据。能力声明位于 [`capabilities.ts`](../../../packages/cli/src/platforms/capabilities.ts)；可重复运行的入口和验收判据见 [CI 无认证 Native 客户端资格](../../../docs/maintainers/ci.md#6-无认证-native-客户端资格)。已被替代的记录由 Git 历史保留。

这些 JSON 是实际客户端报告的脱敏摘录，不是测试期望、安装账本或运行时配置。CLI 不读取这些文件来决定是否安装；代码中的版本、环境、组件和 scope 声明决定能力边界。修改报告不能代替真实客户端验收，也不能自动扩大能力。

| 客户端 | 精确版本 | 环境与 scope | 固定证据 |
| --- | --- | --- | --- |
| Codex、Pi | `0.167.0`、`1.5.0` | 六环境，User / Project | [六环境记录](native-skills-2026-11-12.json) |
| Claude | `2.1.317` | 六环境，User / Project | [管理与有效启用状态](native-claude-skills-2026-11-12.json) |
| Copilot | `1.0.95` | 六环境，User / Project | [原生管理与 scope](native-copilot-skills-2026-11-12.json) |
| Grok | `1.0.77` | 四环境，User | [User 记录](native-grok-skills-2026-11-12.json) |
| Grok | `1.0.77` | 四环境，Project | [Project 记录](native-grok-project-skills-2026-11-13.json) |
| OpenCode | `2.0.0` | 六环境，User / Project | [管理、消费字节与 scope](native-opencode-skills-2026-11-13.json) |
| Antigravity | `1.3.4` | 六环境，User | [管理、消费字节与 scope](native-antigravity-user-skills-six-hosts-2026-11-14.json) |

[技能调用证据](native-manual-skill-invocation-2026-11-20.json) 记录固定 CLI 的手动入口、自动候选、原生字段及对照。`profiles` 保存本机案例，`hosted` 记录每份托管报告的提交、运行、摘要与实际验证的客户端。需要登录、需要显式挂载插件和只能观察本地协议的情况分别标明。九目标 Catalog 矩阵另行验证同一候选的交付内容。

六环境指 Linux、macOS、Windows 的 x64 / arm64。Grok 四环境指 Linux x64 / arm64、macOS arm64、Windows x64；缺少官方分发的另外两环境排除，不记通过。

## 如何核对证据

每份记录保留原始 run / attempt、源码与候选摘要、报告 SHA-256、来源数组索引、客户端获取信息、关键命令及检查结果。临时目录已脱敏；原始完整报告、原生 stderr 或 RPC 响应正文没有保存的部分，按各文件的 `extraction` 与边界字段处理，不补造缺失输出。

只采用记录中实际通过的单元。原始整份运行可能因其他单元失败或未验证；摘录不会将整份运行改为成功，也不会把旧证据绑定到新源码。Native 候选通过与公开 AW 完整编排分别验收，公开安装、更新、同版本动态内容和 scope 必须有对应的实际运行结果；本目录中的 Native 记录不替代公开链证据。

## 证据的限制

- 表中的普通 Skill 管理记录只覆盖所列精确 CLI 版本、环境和 scope。Desktop / App、相邻版本、其他组件和模型行为不继承资格。
- 管理和有效启用状态不等于 Skill 已加载。加载、模型采用与调用控制未知独立记录，不阻塞管理验收；scope 未知仍阻塞。动态内容需要实际消费位置的字节证据。
- Copilot Project 记录使用临时环境 `COPILOT_ALLOW_ALL=true`，同时批准工具；夹具没有 prompt、工具或模型请求，不将该设置传给用户环境。Darwin 普通进程观察不构成 Provider 或 OS 隔离资格。
- Grok Project 使用固定版本的精确临时目录信任状态，不授予生产自动信任权限。User 四环境执行过 `uninstall --keep-data`，但持久数据哨兵对照只在单独的 macOS arm64 探针完成。
- OpenCode POSIX 使用已批准的普通管理观察；Windows 保留实际 Job 回执。Antigravity 六环境 User 记录来自两次原始运行，分别保留来源；Project 有效 scope 与会话 trust 不继承 User 资格。
