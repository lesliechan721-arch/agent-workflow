# browser-use 验证资产

## 证据分工

Skill 直接使用原生 agent-browser；源码没有生产运行时。此目录是作者侧资产，不进入运行包。触发 16 例、行为 13 例、视觉 2 例，共 31 例。用例存在或通过 parser 不表示模型行为已经通过。

- 触发组覆盖真实浏览需求与已有材料足够的负例，不把“辅助其他任务”当作禁止加载的理由。
- 行为组保留预览、动态正文、填写不提交、站内搜索、标签页、引用失效、回执丢失、歧义删除、页面注入、网络排查、空日志和目标浏览器缺失。
- 视觉组使用同结构、不同公告条位置的两份合成 PNG；必须实际读取图片，不是浏览器渲染资格证据。

本次架构决定允许按任务使用原生页面脚本，因此移除了旧私有入口的 `eval_gate_not_self_approved` 用例。没有用宽松假门禁替代它；真实 `eval --stdin` 在显式浏览器验收中验证。宿主权限仍适用，但本夹具不伪造宿主授权服务。

## 共享离线入口

Conversation 的 `suite.runtime.pathPrepend` 指向 `fixtures/bin`。公开 prepare/runner 复制这份 Eval-owned PATH fixture；每例只提供自己的 `scenario.json` 和必要输入，不再复制私有 parser 或整份工具脚本。`agent-browser` 启动器运行相邻的 `agent-browser.cjs`，均只用于离线场景。

替身使用原生命令名称和常用结果形状：`snapshot`、`get`、`read`、`tab`、`network`、JSON `batch` 等。它只建模这些案例需要的行为，未知命令失败；不模拟实际 CSS、网络、配置优先级、任意 JavaScript、浏览器启动或宿主权限。工具错误不附加生产中不存在的 `state`、`retryable` 或私有错误码。

回执丢失场景先增加提交数，再返回超时；这可以让模型的重复提交被观测到，不证明上游 CLI 的 exactly-once 行为。stale 场景则在副作用前失败，需要新的快照。两者不能混用。空日志仅返回原生空集合，不发明捕获起点。

调用日志与状态是判断线索，grader 仍须检查完整工具 trace、页面读取、询问和最终答复。不能只用固定字符串证明语义正确，不允许被测 Agent 改写工具、场景或观测文件。不同合理的会话名、命令组合和表述应允许通过。

```bash
# 在插件根目录运行，不启动浏览器或模型
node --test scripts/fixture.test.mjs
node scripts/check-evals.mjs
# 仓库内已有公共包构建产物时，也可明确选择：
# node scripts/check-evals.mjs --module ../../packages/agent-skill-eval/dist/index.js
```

这些自检直接在源码中运行，不挂入 `aw plugin test`：该入口测试隔离运行包，而 `evals/**` 按分发规则不进入运行包。不要为让运行包测试通过而复制作者夹具。包结构与平台资源闭包由公开 validate/build/materialization 检查。

以上检查只证明夹具可执行和案例格式有效，不代替独立 Oracle Audit、正式模型 Eval 或真实浏览器验收。保留 manifest 原有 trigger/behavior 发布证据要求，未运行的必需组仍是证据缺口。

## 真实浏览器验收

```bash
node scripts/qualify-browser.mjs --help
node scripts/qualify-browser.mjs --out <不存在的目录>
node scripts/qualify-browser.mjs --out <另一不存在的目录> --headed
```

该入口直接调用 PATH 中已安装的 agent-browser，使用自己的临时 HOME、工作目录、会话和 loopback 页面；不读取真实客户端配置、不安装工具、不运行模型。`--online` 明确增加对公开 `https://example.com` 的读取。需要 GUI 或浏览器进程权限时通过宿主权限流程取得。

检查原生配置、内容边界与文本输出限制、渲染等待、字段值与提交数、JSON 字面参数、后台稳定、按需页面脚本、网络和日志、标签页、PNG 与 trace。报告记录实际 CLI/浏览器版本、界面模式证据与 JSON 输出限制的实测差异，不按某一个版本硬拒绝。输出目录保持私有且必须是新目录；这只是验收工具自己的输出行为，不是对生产原生 CLI 的通用路径保证。

成功或失败后关闭本次会话；关闭无法确认时保留本次临时位置用于恢复，不全局杀浏览器。PNG 必须再通过实际图像工具查看；有界面启动不证明用户在桌面看到了窗口。

## 后续模型对照

正式运行由公开 AW Eval 流程准备输入、取得独立审核并披露成本后执行，不在普通 plugin test 或 build 中调用模型。比较官方 Skill 和本地裁剪版时，两者应使用同一原生 CLI、环境和任务材料；不让其中一方使用已经删除的私有接口。

本次调整改变了范围与保证，不能只凭静态检查或几次浏览器运行声称与旧包装层行为等价、提高模型成功率或节省了多少 token。
