# 按需调试

仅在用户要求排查或任务发生异常时读取，不让普通预览默认进入诊断流程。

## 页面与网络证据

```bash
agent-browser console
agent-browser errors
agent-browser network requests --filter /api/search
agent-browser network request <实际请求ID>
```

先用页面结果、操作顺序和请求 URL 确认关联，再读取确有需要的详情。原生详情可能带请求头或正文，不保证已全面脱敏；敏感场景不要把完整原始结果带入聊天，使用获准的本地筛选方式仅提取必要字段。请求正文只在实际捕获时可用，字段缺失不是服务器返回空内容，也不授权重新发送请求。

HTTP 500 不能单独证明具体后端根因，HTTP 200 也不保证业务成功。缺少真实状态、耗时或捕获起点时保持未知，不填造字段。空日志只说明当前记录为空；覆盖目标操作的时段未确认时不能据此宣布正常。

## Trace

```bash
agent-browser trace start
# 只执行已授权、确有必要的最短复现
agent-browser trace stop .browser-use/artifacts/preview/failure-01.json
```

先按[产物约定](browsing.md#标签页与截图)准备私有目录和新路径。开始录制不会补回过去的操作；实际格式和产物位置以本机结果为准。当前基线的 trace 是 Chrome DevTools trace，不是 Playwright trace 包，也不是视频。不要默认上传完整 trace、HAR 或响应体。

## 失败与版本差异

先保留实际错误，区分读操作失败与写操作结果未知。写操作超时后先看页面回执和相关记录，不自动重新提交、刷新、换后端或重建会话重做。工具终止不代表业务回滚；本 Skill 不提供 exactly-once 保证。

排查会话状态或错误记录异常时，核对以下两处：

- 若页面状态意外丢失，检查 `AGENT_BROWSER_DEFAULT_TIMEOUT` 等启动设置是否在会话内变化，并用 `session info --json` 核对后台和启动状态。一个会话内保持启动设置稳定；不要为每条命令建立自定义超时层。
- 执行 `errors --clear` 后再次读取 `errors`，确认记录是否实际清空。若旧记录仍在，需要新的观察期时可创建专属会话；不把旧记录伪装成已删除。

遇到版本差异先查询相关 `--help` 和官方文档，必要时用本地页面验证，不因版本不同直接拒绝。`doctor` 可能清理旧状态或启动探测，`doctor --fix` 还有修复副作用；只在问题需要且影响已获准时运行，不作为每次浏览前的固定步骤。不自动升级、安装浏览器或尝试有费用的服务。

macOS 的 Unix socket 路径长度有限。隔离 HOME 或会话名称过长导致启动前报错时，使用较短的本任务前缀，或按原生错误提示选择较短的私有 socket 目录；不要删除其他会话的文件。
