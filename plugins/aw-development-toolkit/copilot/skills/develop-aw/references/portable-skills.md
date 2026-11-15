# Portable Agent Skills 分发

需要声明或导出标准 Agent Skills 时读取。只为创作、评审或简化取得运行包时，使用 来源与运行包（`references/source-materialization.md`），先确定该插件的实际支持平台。

## 确认分发与来源

标准 Skill 导出使用十个 canonical target 中的显式平台 profile。支持集合由顶层 platforms 取得，缺省或空数组表示全部十平台。具体 Agent 的安装走原生平台路由；generic 仅管理通用 Skills。导出不会把 Native 能力缺口变成支持。

静态内容来自统一 skills 来源；动态 renderer 按所选平台、render scope 和 kinds 返回完整组件集合 v3，不预声明 Skill 清单。导出从本次集合选取 Skill，每个最终直接子目录形成完整标准 Skill，保留生产 README。实际字段与组件限制以当前 capability receipt 和 validator 为准。

确定所选 Skill 的 source、共享文件、runtime imports 与 renderer 输出。共享资源及 capability 传播采用 构建与共享（`references/build-and-sharing.md`），surface 选择采用 平台投影（`references/platform-projection.md`）。原宿主的 Hook、配置或注入能力不能视为所有 Agent 都具备的条件；仅导出目标环境能够满足的内容，并说明其要求。

导出不注册真实本机命令。命令引用只能经该入口的隔离准备与完整 producer 校验；generic 不提供 Native 托管命令。需要独立运行的标准包应提供不依赖安装态命令 ID 的内容与资源。

维护声明或内容时按 Plugin 开发（`references/plugin-development.md`） 验证受影响消费者。保留文件和 runtime requirements receipt 由 AW 注入，source 与 renderer 不自行生成。

## 导出与核对

完成主入口的能力检查后，读取 `aw dev skill export --help`，使用公开入口：

```bash
aw dev skill export <plugin-or-source-selector> --platform <platform> --scope <scope> \
  --skill <skill-name> --out <new-directory> --json
```

按实际选择提供参数，全部导出时省略 `--skill`。CLI 验证完整依赖闭包和候选；`--skill` 只过滤最终选择。platform 必填并绑定固定能力及配置 profile；Generic 也有固定 generic profile，不随后来读取它的 Agent 改变。配置仅取 defaults 与显式非敏感覆盖，不读取本机安装配置；scope 不产生项目值层。profile 中 unverified 能力仍形成具体 unmet。

物化可能运行必要 build、runtime imports 和 renderer；静态限制下只分析 source 与声明。优先使用新隔离目录；已有目录按公开 ownership/替换规则处理，不补造 marker 或覆盖 foreign 内容。materialize 不安装到 Agent 环境，也不建立 Portable installed state，真实安装须属于用户任务。

从回执读取实际 Skill 路径、归属插件、来源绑定和能力要求，检查引用、资源闭包、未解析模板与目标环境依赖。一个依赖 Skill 仍归其实际 provider，不能归到根插件。结构通过不证明所有 Agent 均能运行。

交付实际导出位置、选择、具体平台、scope、来源绑定及未验证环境。通用方法可消费该完整包；跨 profile 覆盖、修改归属与输入变化后的绑定核验使用 来源与运行包（`references/source-materialization.md`）。
