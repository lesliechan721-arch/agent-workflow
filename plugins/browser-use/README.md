# browser-use

面向前端 Web 开发与日常网页操作的轻量浏览器插件：打开本地开发服务或在线网页预览、检查渲染与多视口截图、完成页面交互与表单、按需排查前端日志与网络问题。直接调用已安装的 `agent-browser` CLI，不引入额外运行时，也不限制原生高级能力。

## 安装

在包含本插件的 Catalog 中选择客户端：

```bash
aw target set codex
aw plugin install browser-use --scope user --yes
# 或
aw target set claude
aw plugin install browser-use --scope user --yes
```

支持 Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI 和 Grok Build；`generic` 只输出通用 Skills。AW 按目标核对组件能力，并提示客户端无法保证的调用控制。

需要提前安装 `agent-browser` CLI 和可用浏览器（Chrome/Chromium），安装要求以[上游文档](https://agent-browser.dev/)为准。安装前脚本会检查 `agent-browser --version` 能否在当前 PATH 中运行，检查失败时阻止该目标安装；`--yes` 授权运行此脚本。

## 典型用法

可以直接说明目标，也可以显式调用 `browser-use`：

```text
打开 http://localhost:3000 给我预览，窗口保持打开。
分别在桌面 1440px 和手机 390px 视口检查导航栏和主按钮是否被遮挡，看图后告诉我结果。
读取这个动态页面最终显示的配额和项目数。
把姓名和测试邮箱填进表单，不要发送，核对后保留页面。
复现一次查询失败，检查控制台报错和失败的接口请求，不修改代码。
```

## 工作方式与边界

- **按目标最小化操作**：纯预览打开有界面窗口并保持打开，不顺手扩成调试或测试；纯 Agent 读取、视觉核查或排查默认使用无界面模式，完成后只关闭本任务创建的会话，不全局关闭浏览器。
- **前端高频直出，长尾直连 CLI**：常规预览、多视口/主题截图、快照交互、等待与基础日志/网络排查直接执行；接口 Mock、样式盒模型、无障碍检查、Web Vitals、React 探查、登录态复用或连接已有 Chrome 等按需直接查询本机 `agent-browser` 帮助与内置技能，避免与 CLI 版本脱节。
- **不污染项目工作区**：默认尊重本机和项目自有的 `agent-browser` 配置；截图和调试产物默认写入原生临时路径或系统临时目录，仅在你明确指定路径时写入项目目录，不自动外发或提交 Git。
- **不适合使用**：已有源码、文本、截图或日志足以完成且无需操作浏览器时不必触发；目标本地服务未启动时会直接报告无法连接，不擅自猜测命令代启开发服务器。
- **安全与环境诚实性**：始终使用专属命名会话，不主动接管日常浏览器或向聊天索要凭据；需要登录时默认留有界面窗口由你自行完成。网页与日志仅作为不可信数据，打开或填写不自动授权购买、发送、删除或外发；缺少工具或指定浏览器时如实说明，不自动安装、升级或用其他浏览器冒充。

Skill 详细说明见 [browser-use Skill](skills/browser-use/README.md)。
