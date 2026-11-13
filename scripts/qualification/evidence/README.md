# Native 资格证据归档

可重复运行的无认证托管资格入口、候选来源及覆盖限制见 [CI 无认证 Native 客户端资格](../../../docs/maintainers/ci.md#6-无认证-native-客户端资格)。下文是固定历史证据及其原始采集限制，不是新入口的完整资格结论。

[native-skills-2026-11-12.json](native-skills-2026-11-12.json) 保存六个 Hosted 环境中 Codex CLI `0.167.0`、Pi CLI `1.5.0` 的普通 Skill 原生生命周期与 user/project 隔离证据：Linux、macOS、Windows 的 x64/arm64。记录来自同一次源码/候选的[资格运行](https://github.com/lesliechan721-arch/agent-workflow/actions/runs/43177034163)；整体运行因其他客户端失败，只有摘录的 Native 通过单元构成有限 profile 依据。文件保留原报告 SHA-256、数组索引、候选绑定、精确包获取信息、原始检查回执及限量脱敏命令输出，省略 native stderr。RPC 通过原检查回执表示，不补造未归档的响应正文。

[native-grok-skills-2026-11-12.json](native-grok-skills-2026-11-12.json) 保存 Grok CLI `1.0.77` 在 Linux x64/arm64、macOS arm64、Windows x64 的 User 普通 Skill 原生安装、当前正文发现、`uninstall --keep-data`/install 刷新、中立目录发现及移除记录。四个通过单元来自[同次候选运行](https://github.com/lesliechan721-arch/agent-workflow/actions/runs/43202542989)，均保留原报告摘要、索引、获取信息与命令回执。Project、其他环境/版本及其他组件不继承资格；四环境执行过保留数据参数，不等于已在四环境完成持久数据哨兵对照。该正反对照只在单独的 macOS arm64 探针完成。

[native-grok-project-skills-2026-11-13.json](native-grok-project-skills-2026-11-13.json) 保存 Grok CLI `1.0.77` 四环境 Project 的4个原生管理与有效 scope 通过单元、44条原命令，来自[运行43363001312](https://github.com/lesliechan721-arch/agent-workflow/actions/runs/43363001312)。安装和刷新均核对实际包体字节，目标新客户端报告启用，中立目录不可见，移除及清理完成。夹具仅向精确规范化临时项目写入经验 `trusted_folders.toml`，不授予生产自动信任权限。Skill 发现/加载仍未知；公开 AW Project 安装、更新、同版本动态消费字节和 scope 尚须新 Hosted 实测，不声称公开通过。旧 User 记录保持独立原绑定；无官方分发的 macOS x64、Windows arm64 只排除，不记通过。

这些记录不证明模型采用、调用控制、其他组件执行、Desktop 或未列出的版本/环境。当前 AW 投影候选的 Native 观察与公开 AW 编排分别验收；不得将本记录的通过扩写为所有公开链路已通过。新 Hosted 取证流程以 CI 主题为准，历史报告保持原始版本绑定。

历史本机记录 [native-skills-2026-11-10.json](native-skills-2026-11-10.json) 保存一次真实客户端观察的必要摘录。范围为 macOS 26.3.1、arm64 上的 Codex CLI `0.167.0` 和 Pi CLI `1.5.0`，只覆盖 Skills 的宿主发现、原生生命周期及 user/project scope 隔离。

归档保留 fixture manifest、精确版本输出、环境、关键原生命令、RPC 场景和来源报告 SHA-256。`sourceIndex` 可定位原报告数组中的记录。JSON 输出只解析格式空白；RPC 数组只保留本次 fixture Skill，Pi state 只保留四个运行状态字段。真实 home、可执行文件绝对路径和 native stderr 均未归档；`<TEMP_ROOT>` 表示已清理的隔离运行根。入口文件 SHA-256 只标识该入口文件，不代表完整客户端分发目录。

这些包是本次自有最小原生 fixture。它们不是 AW adapter 端到端安装产物。证据不覆盖模型行为、Skill 调用控制、MCP、Hooks、Instructions、Agents、其他客户端版本、Desktop 或其他 OS/架构。Codex 的 project false 会覆盖 user true；更新记录使用 remove/add 刷新，不代表存在 `plugin update` 命令。

历史本机记录是固定证据，不是安装账本，也不加入默认测试、构建或发布链。原始报告和本机临时探针保留在对应开发工作项中。临时探针绑定本机入口，不能直接作为通用 runner。复现该历史本机观察时，必须显式提供已安装的精确版本 binary，使用独立临时 HOME、Agent/XDG/AW 根和 workspace，保持无凭据、无 prompt、无模型请求；不得下载客户端或连接已有/远程 server。不能通过替换版本号复用旧 `0.151.0` suite 的资格结论。

[native-copilot-skills-2026-11-12.json](native-copilot-skills-2026-11-12.json) 保存 Copilot CLI `1.0.95` 在 Linux/macOS/Windows x64/arm64 的 User/Project 普通 Skill 原生管理、发现、更新、隔离与移除记录。12 个 Native 通过单元来自[同次候选运行](https://github.com/lesliechan721-arch/agent-workflow/actions/runs/43293549338)，原报告整体仍为 unverified，不用摘录覆盖其他未验证场景。记录保留原索引、摘要、获取信息及每条命令的真实进程观察模式；Darwin 使用已接受的 ordinary observed，不是 Provider 或 OS 隔离资格。Project 证据显式使用 `COPILOT_ALLOW_ALL=true` 临时信任前提，该值也批准工具，但测试没有工具、prompt 或模型请求；不传给用户环境。公开 AW 链、普通新会话、模型采用、调用控制和其他组件仍须单独验证。

[native-gemini-skills-2026-11-12.json](native-gemini-skills-2026-11-12.json) 保存 Gemini CLI `0.67.0` 六环境 User 普通 Skill 的六个通过单元及96条命令，来自同次43293549338原生报告。精确来源、命令模式、发现/更新/移除与无凭据前提均保留，原整体及公开链仍未验证。该固定记录仍只授权 User，共用包体不扩大其 scope；Project 使用下述独立记录。公开 AW 链、其他版本/组件/App、调用控制与模型采用均须另验。

[native-gemini-project-skills-2026-11-13.json](native-gemini-project-skills-2026-11-13.json) 保存 Gemini CLI `0.67.0` 六环境 Project 普通 Skill 的六个原生管理与有效 scope 通过单元、102条原命令，来自[运行43372721076](https://github.com/lesliechan721-arch/agent-workflow/actions/runs/43372721076)。目标新客户端报告启用，中立目录报告停用，更新后的 Skill 描述、移除及清理均有原始回执。夹具先信任隔离来源与工作目录，并手工插入 `!*` 默认禁用规则；该前提不证明 AW 自动项目激活。公开 AW Project 安装、更新、同版本动态消费字节和 scope 必须使用生产 writer 另做 Hosted 实测，不得手工补激活。Skill 发现已有观察，实际加载与模型采用仍未知；该未知不阻塞有限管理资格。原六份报告整体仍为 failed，旧 User 记录的绑定和结论保持独立。

[native-claude-skills-2026-11-12.json](native-claude-skills-2026-11-12.json) 保存 Claude CLI `2.1.317` 六环境 User/Project 的12个原生管理与有效 scope 通过单元、168条原命令。目标/neutral 新客户端库存分别证明 User true/true、Project true/false，更新版本和移除均有管理证据；这不是 Skill 发现或实际加载证据。按当前管理验收判据，未知加载非阻塞；动态内容仍须另验实际消费字节，scope 未知仍阻塞。原43293549338六报告及公开链的未验证状态、source、candidate和进程模式保持，不反向改写旧记录。

[native-antigravity-user-skills-six-hosts-2026-11-14.json](native-antigravity-user-skills-six-hosts-2026-11-14.json) 保存 Antigravity CLI `1.3.4` 原六环境的 User 普通 Skill 管理资格：三修订的实际副本正文、标准 owner、双目录有效 scope、移除及清理共48项必需检查。Linux双架构/macOS x64取43477684754 attempt1，macOS ARM64/Windows双架构取43486467669 attempt1，分别保留源与完整候选/helper绑定；旧失败、Windows夹具错误与MacARM容量取消不改绿。公开AW链单独实测，Project、其他组件、加载/模型和会话trust不提升。旧单Linux记录继续保留原始来源。
