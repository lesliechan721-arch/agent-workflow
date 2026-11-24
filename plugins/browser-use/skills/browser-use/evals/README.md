# browser-use 验证资产

## 证据分工

Skill 采用单文件行为契约 + 高频骨架 + 本机 `agent-browser` CLI 桥接设计，源码没有额外浏览器运行时。此目录为作者侧资产，不进入构建后的运行包。当前包含触发 20 例、行为 17 例、视觉 2 例，共 39 例。用例存在或通过 parser 不表示模型行为已经通过。

- 触发组覆盖前端预览、多视口响应式核查、控制台/网络排查、表单交互与在线浏览等正例，以及含显式禁令与无显式禁令（前端报错堆栈分析）的近邻负例。
- 行为组覆盖前端核心任务（预览保活、本地服务不可达不代启、多视口默认临时路径截图不污染工作区、带 HMR 页面避开 `networkidle` 等待 `#spinner` 隐藏、接口 `network route` Mock 验证）以及关键安全/边界（填表不提交、引用失效重观察、写操作超时不重试、歧义删除停手、网页防注入、网络排查、空日志证据边界、目标浏览器缺失）。
- 视觉组使用同结构、不同公告条位置的两份合成 PNG，验证必须实际读取图像且按用户显式指定路径输出；不替代真实浏览器渲染资格。

## 共享离线入口

Conversation 的 `suite.runtime.pathPrepend` 指向 `fixtures/bin`。公开 prepare/runner 复制这份 Eval-owned PATH fixture；每例仅提供 `scenario.json` 和必要输入。`agent-browser` 启动器调用相邻的 `agent-browser.cjs`，仅用于离线场景。

替身建模常用原生命令语义：`session id/info/list`、`open`（含不可达 `ERR_CONNECTION_REFUSED`）、`snapshot`、`read`、`get`（含 `box`/`styles`）、`find role/text/label/placeholder`、`set viewport/media`（支持 `reduced-motion` 组合）、`fill`、`select`、`click`、`press`、`wait`（支持短别名、参数顺序、`--state hidden|detached`/`--fn` 及 HMR 场景 `networkidle` 超时）、`dialog`、`tab`、`console`、`errors`、`network`（含 `route`/`unroute` 与类型/状态/方法过滤）、`screenshot`（支持 `-f`/`--full`/`--annotate`，无路径或 `TMPDIR` 显式路径记为非工作区产物）、`batch`、`close`。未建模命令直接报错，不伪造真实 CSS、网络、配置优先级或宿主权限。

回执丢失场景先增加提交数再返回超时，用于观测重复提交；stale 场景则在副作用前失败，需要重新 `snapshot -i`。空日志返回空集合，不发明捕获起点。

```bash
# 在插件根目录运行，不启动真实浏览器或模型
node --test scripts/fixture.test.mjs
node scripts/check-evals.mjs
# 仓库内已有公共包构建产物时，也可明确选择：
# node scripts/check-evals.mjs --module ../../packages/agent-skill-eval/dist/index.js
```

这些自检直接在源码中运行，不挂入 `aw dev plugin test`（该入口测试隔离运行包，而 `evals/**` 不进入运行包）。包结构与平台资源闭包由公开 validate/build/materialization 检查。

以上检查只证明夹具可执行和案例格式有效，不代替独立 Oracle Audit、正式模型 Eval 或真实浏览器验收。

## 真实浏览器验收

```bash
node scripts/qualify-browser.mjs --help
node scripts/qualify-browser.mjs --out <不存在的目录>
node scripts/qualify-browser.mjs --out <另一不存在的目录> --headed
```

该入口直接调用 PATH 中已安装的 `agent-browser`，使用独立临时 HOME、工作目录、专属命名会话和本地 loopback 页面，不读取真实用户配置、不安装工具、不运行模型。`--online` 额外验证公开 `https://example.com`。

验收覆盖：命名会话与显式 `--session`、多视口（1440x900 / 390x844）与主题切换、原生临时路径截图（零工作区污染）与显式路径 PNG、等待加载态与 `#spinner` 隐藏、按需 `--content-boundaries --max-output`、`get box`/`get styles`、`eval --stdin`、`network requests --type --status` 与 `network route` Mock、标签页、`trace` 以及只关闭自有会话。

## 后续模型对照

正式运行由公开 AW Eval 流程准备输入、取得独立审核并披露成本后执行，不在普通 plugin test 或 build 中调用模型。与官方 `agent-browser` Skill 对照时，应使用同一原生 CLI、环境与前端任务集，比较实际产物正确性、误操作率、调用步数与上下文消耗。
