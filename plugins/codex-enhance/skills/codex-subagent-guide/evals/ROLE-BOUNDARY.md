# Role boundary Eval assets

新增用例共 50 条：联合 workflow 18、worker 8、trigger 18、conversation 6。J15 位于独立的 `joint-guide-only` suite；它只向父代理暴露 Guide。其余 17 条联合用例位于 `joint-workflow`。原有 trigger、routing、model-selection、workflow、output、lifecycle 和 liveness suite 的用途及发布要求保留。

`run-role-boundary-evals.mjs` 只实现 prepare 和 grade。prepare 写真实原始文件，通过已安装 Guide 的公开 `resolve` 核验 AW 身份、资源及 revision，然后使用同次已核验的 snapshot。worker 的完整 canonical 正文放入独立 developer 指令字段；任务保持 user 字段。外部路径交给公共 Eval Engine 的 `instruction-v2` transport，包含真实可执行路径、任务、完整指令、资料路径、内容摘要和行号。provider 不读取模型凭据，不创建自己的模型引擎。

外部运行须提供真实配置文件给公开准备入口：

```sh
aw skill eval prepare codex-enhance codex-subagent-guide \
  --suite joint-workflow --case J18 --profile project-default \
  --config-file /absolute/path/role-boundary-config.json \
  --output /absolute/new/output-directory --json
```

配置文件是插件字段 map，例如 `{ "codex-enhance": { "subagentCommands": [...], "advisorProfile": {...} } }`。注册项使用实际 Node 和已安装 adapter 的绝对地址。profile 引用其真实 key；`lab-workspace`、`lab-bundle` 和 `fixture-*` 只描述场景匹配要求，不发送到模型服务。J18 的 general、complex、advanced 通用 profile 分别解析为 native、workspace、bundle，均选择 advisor worker。J12 的独立本地故障安装由 fixture 创建。

固定 fixture 资产位于 `fixtures/`，prepare 将它们复制到 Eval fixture 根。公共 Engine 在模型启动前执行 setup action；它先独立匹配实际问题并复查 protectedPaths，再执行 interaction action；subject 终态后、独立 grader 前执行 final action。动作只返回真实文件、摘要、安装版本、原始 run 和程序诊断，不输出通过结论。

真实安装场景可使用独立 CatalogWorkspace 中有来源绑定的公开 AW package fixture：先正常 pack CLI 与它声明的包，在隔离 npm prefix 安装真实 tarball 和公开依赖，把完整无 symlink 的运行树放到该 source 的 `evals/fixtures/public-aw/`，并提供普通可执行文件 `bin/aw`。公共 `aw skill eval prepare` 从该可复核 source 正常生成 sourceBinding；不改 prepared receipt。provider 只从其同源固定目录复制完整树，action 固定前置 `fixtures/public-aw/bin` 到 PATH。该临时树不提交到产品源码。没有该树时只使用真实 PATH `aw` 并核对公开能力；没有所需能力则报告环境不可用。

- J08 首次咨询只看到当前两份资料。匹配父任务的真实补证请求后才释放后续耗时文件。
- J03、J10 的 final action 用固定独立输入运行实际 `src/select.js`，检查跨租户同 ID、空 ID、原始顺序及输入不变。它不运行 subject 写的测试。非法导入、超时或缺执行回执保持 unknown；观察到行为错误则失败。
- J11、J17 使用 PATH 中通过 capability check 的公开 `aw`，构造隔离 catalog、配置 home 和 project，通过 validate、build、source sync、install、config save/apply 或 reinstall 生成合法安装。每个 synthetic Skill 都剥离旧 AW 注入的 reader，由本次公开安装生成新资源。父任务用真实 Guide 启动原咨询，把实际 run JSON 保存到 `provided/original-run.json`。apply 前两次真实 status 均须为 running；未观察到活动窗口时报告前提不可用。收尾动作对原 ID 实际 status、collect，并比较原请求与 run-store；这些观察只覆盖其命令区间，父任务有没有重提交仍需真实工具记录。J17 在另一个副本制造新快照配旧 worker 的混合安装，保留 AW 回执不变，验证拒绝；合法新安装继续保留。父任务另在 `new-runs` 中启动已授权的新上下文请求。缺少该请求的真实通道、上下文或终态证据时，正向检查保持 unknown。
- J12 使用明确标注的本地 fault adapter，实际写一次 `probe/once.txt`，记录提交和写入数，退出时不提供完成回执。正式 Guide 将其保存为 unknown。此控制不证明模型质量、服务停止或计费资格。
- J15 公开安装一个合法 synthetic plugin，保留 Guide 方法，另加一个无领域含义的 opaque worker 指令与 binding。父代理的 Skill 发现范围只有 Guide。
- J16 安装诚实声明不支持独立指令通道的 registry 项，用真实 resolve 检查启动前拒绝；adapter 不执行。
- J18 由父任务通过真实原生工具和已安装 Guide 分别完成三条调用；不存在 provider 私有循环或假回执。

公共 Engine 提供独立语义 checks。未取得真实 tool trace、独立指令通道、权限、执行能力或 session 证据的断言保持 unknown。配置声明、最终文本与本地 fault 控制不能替代真实资格证据。当前资产的确定性测试与 prepare 不运行模型，不提供 Oracle passing audit 或发布资格。

旧多档 role 名称已迁移为单一 canonical role，档位仍通过 profile 的 model/effort 选择。隐式 leaf 不再加载协调 Skill 或递归委派；显式、合法协调子任务仍保留单独用例。Explore 的干净上下文检查继续验证 fresh context，模型选择由原有独立选型用例检查。
