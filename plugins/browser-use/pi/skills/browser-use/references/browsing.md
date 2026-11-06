# 浏览与会话

命令语法以本机帮助为准。

## 任务会话

已有明确属于本任务的会话时复用；否则用原生命名会话，不使用共享的 `default`。先查看 `agent-browser --version`，已有本次版本信息则不重复检查。版本不同不自动拒绝；缺少命令或浏览器时说明缺口，不自动安装。

从客户端提供的 Skill 路径确定 `SKILL_ROOT`，不要把项目 cwd 当成 Skill 根。为本任务选择有区分度的前缀；相同工作树和前缀会得到相同名称，因此不能把另一个任务的活跃会话当作自己的。

```bash
export AGENT_BROWSER_CONFIG="$SKILL_ROOT/assets/agent-browser.json"
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix browser-use-preview)"
export AGENT_BROWSER_HEADED=true
agent-browser session info --json
```

纯 Agent 读取、交互或检查把 `AGENT_BROWSER_HEADED` 设为 `false`。设置在创建会话时确定，不用临时改启动参数切换已有窗口。不同工具调用可能使用新 shell，必须重新传入相同环境值，或用相同的 `--config`、`--session`、`--headed` 参数；不能假定 `export` 跨工具调用保存。

`--config` 只替代默认用户和项目配置文件，不清除环境变量。首次启动前检查会改变连接、凭据或启动方式的配置来源：`AGENT_BROWSER_CDP`、`AUTO_CONNECT`、`PROFILE`、`STATE`、`RESTORE`、`SESSION_NAME`、`PROVIDER`、`PLUGINS`、`ARGS`、`EXTENSIONS`、`INIT_SCRIPTS` 和 `ENABLE`（后面各项也带 `AGENT_BROWSER_` 前缀）。不要把值中的凭据输出到聊天。与本任务无关的连接或恢复设置只在本次命令环境中取消，例如 `env -u AGENT_BROWSER_CDP -u AGENT_BROWSER_PROFILE agent-browser ...`，不修改用户全局配置。保留宿主权限及适用的域限制、动作策略、代理和证书要求；显式配置不能作为绕过既有安全限制的手段。

默认不传 `--profile`、`--restore`、`--state`、`--cdp` 或 `--auto-connect`。需要已有登录态或外部浏览器时，先确认用户授权和目标；命名会话连接同一个外部浏览器时并不隔离其 cookie。自己的新会话先打开空白页，关闭未使用的输入流，再导航到目标；任务确需流功能时可按原生帮助启用。

```bash
agent-browser open about:blank
agent-browser stream disable
agent-browser open https://example.com
```

`session info --json` 可核对活动状态、启动和恢复诊断，不证明页面业务成功。遇到已存在但归属不明的会话，换本任务的前缀；不要导航覆盖它。会话关闭后不假定临时表单或标签页可恢复。清理只使用当前会话的 `agent-browser close`，不用 `close --all` 或按进程名批量终止。

## 读取、交互与等待

```bash
agent-browser snapshot -i -s main
agent-browser get text main
agent-browser read
agent-browser fill @e5 "test@example.com"
agent-browser get value @e5
agent-browser select @e6 "monthly"
agent-browser wait --text "已保存"
agent-browser wait '#results'
agent-browser wait --url '**/complete'
```

不带 URL 的 `read` 读取当前渲染 DOM；`read <url>` 可能通过 HTTP 取文档，不证明浏览器实际渲染。内容截断时缩小读取范围，不能把片段当成完整页面。`snapshot -i` 只包含交互元素，文章正文应单独读取。

随包配置启用原生内容边界，并将普通文本输出正文限制设为 16,000 字符；边界与截断提示会增加额外字符。`0.37.1` 实测 `read` 和 `get text` 的普通文本输出会截断，但对应 `--json` 输出不受同一限制，不能把 `maxOutput` 当作统一 JSON 预算。需要结构化输出时先收窄目标；可能很大的结果使用获准的本地筛选方式，不直接转储到上下文。

等待条件来自目标状态；持续轮询页面不适合默认等待 network idle。`fill`、`select` 可能自动保存，不能把所有输入都视为无副作用草稿。点击成功也不等于业务提交成功。

特殊表单值可能被 CLI 当成全局选项，shell 引号本身不解决这个问题。对 `--headed` 这样的字面值，使用原生 JSON stdin，不用私有转发器：

```bash
printf '%s\n' '[["fill","@e5","--headed"]]' | agent-browser batch --bail --json
```

这里只展示字面值示例，目标引用仍须来自当前页面。动态值用 JSON 序列化，不拼接 shell；不要把凭据嵌入命令或共享记录。普通命令直接运行，不强制每次都用 batch。

## 标签页与截图

```bash
agent-browser tab list
agent-browser tab new https://example.com/help
agent-browser tab t2
agent-browser snapshot -i
agent-browser tab close t2
```

使用列表实际返回的标识，不猜序号。切页后重新观察；返回 `revived` 时页面可能重载，原表单状态不能继续假定存在。

产物默认放在工作空间目录 `.browser-use` 下，使用新文件名，避免覆盖用户文件：

```bash
umask 077
mkdir -p .browser-use/artifacts/preview
agent-browser screenshot .browser-use/artifacts/preview/page-01.png
# 需要整页时才增加 --full
```

检查实际文件路径，并通过客户端图像工具查看截图后再判断遮挡、布局或样式。图片可能含敏感数据，分享前核对。用户要求窗口预览时不能只交截图代替已打开窗口。

## 登录与按需能力

默认保留有界面会话，让用户完成登录或验证码；用户确认后在同一会话重新观察。不要要求把密码、验证码、cookie 或认证状态发到聊天。显式需要认证导入、持久化或用户浏览器接管时，按当前官方认证说明选择方式并说明影响，不把通用浏览授权扩大为凭据读取授权。

页面 JavaScript、上传下载、frame、录制等都按当前任务需要使用，不因本文件没有列出而一律禁止。复杂 JavaScript 先读 `agent-browser eval --help`，使用 `eval --stdin` 避免 shell 转义错误；只读取所需数据，不默认转储存储状态。缺少依赖或宿主拒绝时保留明确缺口，不绕过限制。
