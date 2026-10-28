# 网页反馈

使用标准 Review Shell 展示原型并收集用户反馈。按当前问题启用候选、评论、标注和受控参数，不另建一套 Review 界面。机器字段以 schema、运行时校验和命令输出为准。

## 启动或复用会话

```sh
node scripts/prototype-review.mjs start --prototype <prototype.json>
```

后续命令的 `<session.json>` 使用回执中的 `session` 路径。若回执已返回匹配的 `submitted` 结果，直接进入“消费有效反馈”，无需再次展示或等待。

会话默认有效 30 分钟，等待和查询不会续期。会话期限用 `start --ttl` 设置；其他参数按 `node scripts/prototype-review.mjs --help` 查询。

## 向用户展示页面

沙箱或执行权限受限时，按环境提供的审批流程重试；被拒后停止打开操作，不换工具绕过。远程或无桌面环境无法向用户展示时，使用已有安全转发或预览；仍不可达则说明限制，保留问题和原型，不默认公开服务。

优先使用能向用户展示可操作页面的原生浏览器、预览或端口能力，并核对页面连接信息。

| 条件 | 处理 |
| --- | --- |
| 用户可操作的原生能力不可用或发生技术失败 | 运行 `node scripts/prototype-review.mjs open --session <session.json>` |
| 脚本 `open` 发生技术失败 | 使用当前系统浏览器能力打开会话 URL |
| 自动打开均发生技术失败 | 输出会话 URL 供用户手动打开，继续等待反馈 |

技术兜底复用同一会话和 URL，不重新启动服务。通过脚本重试打开时使用 `--retry`；普通重复调用会复用已有打开结果。

## 等待与处理会话状态

展示页面或提供手动打开 URL 后运行：

```sh
node scripts/prototype-review.mjs wait --session <session.json>
```

默认等待窗口为 30 分钟。为用户反馈设置的等待窗口至少为 30 分钟，需要更长时间时通过 `--timeout` 指定。工具单次等待受限时，支持后台执行就保持同一次 `wait`，分段取得结果并保持进度响应；否则连续等待同一有效会话，避免短时间轮询。

有效提交、取消或会话到期可以提前结束等待。等待超时只结束本次 `wait`，继续等待时复用同一有效会话。仅在回执陈旧或需要诊断状态时运行 `node scripts/prototype-review.mjs status --session <session.json>`。

`wait/status` 已检查持久化反馈；回执为到期、取消或失联时，保留未决状态、问题和原型。用户仍要反馈时复用有效会话，或在原会话已终止后启动新会话。运行时负责到期和提交后的资源回收；需要主动结束会话时使用 `node scripts/prototype-review.mjs stop --session <session.json>`，不按进程名称批量终止程序或关闭用户浏览器。

## 消费有效反馈

网页反馈以运行时验证的 `submitted` 回执为准。直接读取回执中的完整 `feedbackData`，核对当前原型 ID 和 revision；回执也提供 `feedback` 文件路径，仅在旧回执缺少完整内容或需要排查时读取该文件。

`submitted` 表示收到有效提交，是否接受取决于反馈内容。按 取得反馈（`SKILL.md#取得反馈`） 处理修改、拒绝或新问题，再按 形成结论（`SKILL.md#形成结论`） 保存决定及证据，自动继续当前任务，无需用户回到聊天再次确认完成。
