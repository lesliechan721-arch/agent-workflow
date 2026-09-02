# Prototype Review 运行时接口

只在使用标准网页反馈时读取。从 Skill 根运行命令。脚本不自动打开浏览器。

## 命令

```bash
node scripts/prototype-review.mjs start --prototype <prototype.json>
node scripts/prototype-review.mjs wait --session <session.json> --timeout 30m
node scripts/prototype-review.mjs status --session <session.json>
node scripts/prototype-review.mjs stop --session <session.json>
```

参数、退出码和完整 receipt 以各命令的 `--help` 为准。

## 主路径

1. `start` 校验 Prototype 和 artifact，从 Skill assets 服务 Review Shell，并在系统临时目录创建 localhost 会话。
2. Agent 使用环境可用能力打开 `ready` receipt 中的 URL，然后执行 `wait`。
3. `wait` 返回 `submitted` 后，读取 receipt 指向的 `feedback.json`，核对 Prototype ID 和 revision，再继续当前任务。
4. 同一 revision 已有有效反馈时，`start` 直接返回 `submitted`，不启动重复页面。

## Receipt 状态

- `start`：`ready | submitted`
- `wait`：`submitted | cancelled | timeout`
- `status`：`ready | submitted | unreachable | not-found`
- `stop`：`stopped | not-found`
- 参数错误：`usage`；其它失败：`failed`

`submitted` 返回 Prototype ID、revision、verdict、选择数、标注数和 `feedback.json` 路径。反馈已经由运行时完成 schema、ID 和 revision 校验。

## 重复会话与 revision

- 同一 Prototype revision 的第一个有效提交生效。其它会话读取同一份 canonical feedback，不覆盖它。
- Prototype 已进入新 revision 时，旧会话拒绝写入。
- 新 revision 启动前只删除已验证属于同一 Prototype 的旧 revision feedback。不同 ID、更新 revision、无效文件或符号链接全部 fail closed。

## 失败与降级

- 没有浏览器或页面预览能力时，把 URL 和最短打开方式交给用户，然后继续 `wait`；不要声称页面已经打开。
- 客户端不能长时间阻塞时，使用 `status` 明确重试。
- `timeout`、`cancelled`、`unreachable` 和 `not-found` 都不表示用户已经作出决定。Prototype 和 artifact 继续保留。
- `stop` 在服务可达时请求认证关闭，并清理已证明属于该会话的临时文件；服务已经不可达时仍清理本地会话描述。它不删除 Prototype 输入或结果。

会话只绑定 `127.0.0.1`。session token、server 进程和日志位于系统临时目录，不写入 Prototype 的 `review/` 子目录。
