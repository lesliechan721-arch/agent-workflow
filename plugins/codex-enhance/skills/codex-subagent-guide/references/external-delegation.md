# 调用外部子代理

## 选择执行器

按 profile.executor 精确匹配表中的 key，以 mode 准备材料，不根据显示名称猜测。

<!-- subagent-commands -->

## 调用与参数
```bash
node scripts/subagent.mjs run \
  --profile generalTaskProfile \
  --workspace /path/to/project \
  --prompt '检查 src/example.ts 的错误处理，给出依据；不要修改项目。'
```

| 参数 | 用法                                                                      |
| --- |-------------------------------------------------------------------------|
| `--profile KEY` | 必填。使用调用方选定的 profile key。                                                |
| `--prompt TEXT` / `--prompt -` | 必填且只提供一次。长文本用非交互 stdin，避免 argv 长度限制，如 `--prompt - < task.md`；输入须结束。     |
| `--instructions-file PATH` | 可选角色指令文件。相对路径以调用目录为基准，不随 `--workspace` 改变。                              |
| `--workspace DIR` | 工作目录，不传默认为调用进程 cwd。                                                     |
| `--file SELECTOR` | bundle 文件选择，具体规则见 `references/file-selection.md` ；workspace 禁止传入（包括空值）。 |
| `--model MODEL`、`--reasoning-effort EFFORT` | 显式覆盖 profile 的对应值；不支持时报告实际错误，不静默换值。                                     |

任务须包含目标、范围、来源、约束、验收和输出。角色职责由 prompt 或指令文件提供；默认角色指令为 `assets/task-instructions.md`。不提供文件时不会自动补入默认角色，prompt 须保留全部职责与约束。

## 预览与结果

追加 `--preview` 可检查准备，不启动模型，也不是 run 的必经步骤。它展示本次配置和输入概况；bundle 只显示标为“未解析”的选择式，不证明材料存在、可读或可上传。环境只显示变量名和引用来源，不显示值。

run 在前台执行，沿用 Guide 的同一 session 等待规则。执行上限为 30 分钟，不是一次工具等待窗口。最终正文最多 4 MiB；超限不能当作完整回答。

返回文字状态和回答，例如：

```text
COMPLETED · generalTaskProfile → codex-local · workspace

完整回答。
```

| 状态 | 处理方式 |
| --- | --- |
| COMPLETED | 调用已完成，仍需验收正文、依据、覆盖和产物。 |
| FAILED | 查看原因与已知提交阶段；只在授权和预算内处理重试，不凭非零退出认定未提交。 |
| CANCELLED | 核对已有副作用，再决定接手方式。 |
| UNKNOWN | 保留部分结果和缺口，不自动重提、换后端、force 或续接其它会话。 |

退出码为 0=完成/预览/帮助，1=其它运行结果，2=无效输入。输入错误见 stderr；已开始的运行在 stdout 保留状态和可用正文。不把非空文本或业务正文里的“完成”当成服务终态。

## 停止与恢复

停止时使用原 session 的操作，只处理本次可证明归属的执行与临时资源，不按进程名关闭共享浏览器。本地退出不能证明远端停止；无法确认时保持 UNKNOWN。

一次前台调用限制的是对同一任务重复提交，不限制外部后端在任务边界内的正常工具、多步处理或内部协作。

外部调用没有 resume。追问是新的生成，计入预算，不用于取回原结果。宿主 session 丢失后不保证恢复，遗留临时目录也不是恢复入口。
