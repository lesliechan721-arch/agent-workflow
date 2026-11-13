# AW 原生工具合同 v2

原生工具由当前运行的 AW 或 Eval 提供。插件声明需要的宿主协议和消费者；宿主在启动消费者前，从自身已安装依赖解析适用平台的工具，并注入本地路径。当前支持 `aw.windows-job.v1`。官方平台包构建与发布流程参见[平台架构说明](../maintainers/architecture/platforms.md)与[发布流程](../maintainers/release.md)。

## 1. 作者声明与能力查询

Plugin Manifest v4 的 `nativeTools` 要求 `aw.native-tools.v2`。从当前工具查询字段和限制：

```bash
aw dev plugin capabilities --surface native-tools --json
```

### 1.1 协议定义与消费者声明

`definitions` 每项只包含插件内唯一的 `key` 和版本化 `protocol`；`consumers` 声明受控消费者及其绑定的工具策略：

```json
{
  "definitions": [
    { "key": "windows-job", "protocol": "aw.windows-job.v1" }
  ],
  "consumers": [
    {
      "kind": "managed-command-set",
      "key": "subagent-run",
      "tools": [
        {
          "key": "windows-job",
          "platforms": ["win32"],
          "policy": "required"
        }
      ]
    }
  ]
}
```

- **消费者类型（`consumers[].kind`）**：仅允许 `managed-command-set`（托管命令集合）与 `plugin-test`（插件测试 runner）。
- **消费者标识（`consumers[].key`）**：分别引用已在 Manifest 中声明的 command set 名称，或测试 runner 标识（如 `node`）。
- **工具绑定（`tools[]`）**：
  - `key`：必须引用 `definitions` 中已声明的工具 key。所有声明的 definitions 必须被至少一个 consumer 引用，严禁悬空定义或未定义引用。
  - `platforms`：显式声明为 `["win32"]`。不适用当前平台的 binding 会自动跳过。
  - `policy` 策略分流：
    - `required`：严禁声明 fallback。解析失败或依赖缺失时**严禁启动消费者**，在产生任何业务副作用前停止。Job containment、ACL 隔离或安全终止缺少等价后端实现时，**必须**使用 `required`。
    - `preferred`：**必须显式声明 `fallback` 标识**，且必须通过相同 protocol 的双 backend 合同测试。preferred backend 在消费者启动时固定，操作失败时**严禁在活跃任务中静默切换后端**。
- 宿主不支持的协议返回 `nativeProtocolUnsupported`。

### 1.2 Reader 与运行时读取

可选 `reader` 指定插件内生成文件，默认 `./.aw/native-tool-reader.mjs`。作者构建从 `AW_PLUGIN_NATIVE_READER` 取得 AW 生成的 reader；运行脚本通过 `readNativeTool(key, protocol)` 读取当前结果：
- 准备就绪：`{ state: "ready", protocol, executable }`。
- preferred 不可用：`{ state: "unavailable", protocol, code }`。

**边界与不变量**：
- Reader 不负责下载或取得工具，不接受业务参数中的任意工具路径。
- Hook、MCP 和任意文件路径不是受控消费者。
- 插件仅保存协议需求与消费者绑定，**不保存平台包版本、descriptor、archive integrity、EXE 摘要、大小或 PE machine，也不复制 EXE**。运行时不重新校验固定的 archive/file 摘要或 PE machine。
- 工具实现随宿主更新；不兼容的工具实现必须使用新的 protocol ID。

---

## 2. 构建与第三方 Workspace 边界

- **无编译依赖**：`aw dev plugin validate/build`、Catalog build 和静态 Skill materialization 处理声明、binding 和 reader，不取得真实 EXE，不要求 Go 编译环境。
- **动态执行前置门禁**：Windows 上执行动态 renderer 或真实插件测试时，使用当前 CLI 的配套 helper；缺少依赖时在启动前停止。
- **Fixture 证据范围**：测试 fixture 仅能证明声明、准备与协议接线正确，**不能证明真实的 Windows ACL、Job containment 或取消行为**。
- **第三方作者使用流程**：
  第三方作者只需要本机已安装的兼容 AW CLI，即可完成验证、构建与测试，无需检出本 monorepo，无需 Go 环境，无需全局 Eval 或官方发布脚本：

  ```bash
  aw dev plugin validate plugins/example --workspace-root /workspace --json
  aw dev plugin build plugins/example --workspace-root /workspace --json
  aw dev plugin test plugins/example --workspace-root /workspace --json
  ```

---

## 3. 安装审阅与运行

- **审阅闭包**：新增、删除或改变 native 声明闭包均进入现有 Review 和 Receipt，闭包只包含 `reader`、`definitions` 和 `consumers`。没有第二套 native 批准流程。
- **已安装 Producer 保护**：已安装 producer 保存并核验声明闭包。Catalog source sync 不修改旧命令；用户确认并成功更新 producer 后，后续调用才使用新声明。producer 更新失败时保留完整旧产物，或撤下不完整绑定。
- **更新前终止活跃任务**：更新、重装或删除 producer 前，必须先结束或停止当前活跃任务。
- **共享 Producer 保护**：仅撤销一个 scope 的原生插件注册时，仍存在的共享静态 Skill producer 保持可用，不计作闭包删除。
- **配置与原生解耦**：配置应用或重放不能替代 native 声明变化确认。独立命令包的当前声明与已安装闭包不同时，配置刷新保留旧 producer 并报告部分失败；先通过 `sync` 或 `command package sync` 审阅确认变化，再重试配置应用。已保存配置仍保留。
- **宿主更新与插件解耦**：仅升级 CLI 的配套原生工具不改变插件声明，**不要求插件重装、重新发布或单独 Review**。
- **启动与上下文注入**：
  - 宿主先校验命令、binding、协议和环境，再解析所需工具；required 成功后才启动消费者、读取任务或产生业务副作用。
  - `start/send/wait/result/stop` 统一遵循相同的准备规则。
  - 宿主启动消费者前，必须先清理继承的旧 native context，再按当前 producer 解析注入。
  - `AW_NATIVE_TOOL_CONTEXT` 保存 schema 1 和本次声明 key 的 ready/unavailable 结果。
  - `AW_NATIVE_*` 是受保护内部环境变量前缀，命令 env/envFrom 严禁覆盖，Windows 按大小写不敏感处理。

---

## 4. 包解析与恢复

- **依赖解析**：Eval 的 `prepareWindowsJobHelper(options = {})` 和 `resolveWindowsJobHelperPath(options = {})` 从 Eval 包自身的依赖上下文，通过 `import.meta.resolve` 解析适用平台包；CLI 复用该能力。不假定依赖位于顶层 `node_modules`，也不读取 `NODE_PATH`。
- **可选依赖（optionalDependencies）**：
  - Eval 精确引用与自身同版本的两个 Windows 平台包：`@lesliechan721/aw-windows-job-win32-x64` 与 `@lesliechan721/aw-windows-job-win32-arm64`。
  - macOS/Linux 环境不安装 Windows 包。通用 npm 包、Skill 和 Catalog 源码不包含 EXE。正常安装不编译 Go，也不通过 postinstall 下载或复制 EXE。
- **故障恢复诊断**：
  Windows 的 optional dependency 缺失时，主包安装可能仍成功。只有需要 helper 的操作才报告 `nativePackageUnavailable`，并在启动消费者前停止；恢复方式是重新安装当前 CLI 或 Eval，并确保包含 optional dependencies。不支持的平台或架构报告 `nativePlatformUnsupported`。
- **离线与缓存原则**：
  - 运行时不访问网络 registry，不搜索 PATH、全局包、仓库 EXE 或旧 AW cache。
  - 离线安装使用包管理器缓存或预先准备的完整 npm 依赖包。AW 不提供内置原生下载器、预取或 native 独立缓存。
  - 旧 AW native cache 不读取、不迁移，也不主动遍历删除。
  - 插件与平台产物清理继续严格保留 foreign 和 shared 内容。
