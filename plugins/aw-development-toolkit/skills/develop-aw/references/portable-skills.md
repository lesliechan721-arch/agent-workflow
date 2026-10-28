# Portable Agent Skills 分发

需要声明或导出标准 Agent Skills 时读取。只为创作、评审或简化取得运行包时，使用 来源与运行包（`references/source-materialization.md`），无需先新增 Portable 声明。

## 确认分发与来源

Portable 是独立 distribution，不是 Codex/Claude 的别名。Plugin 必须显式声明 `distributions.agentSkills`，不能从原生 skills 或 marketplace 推断。使用 Portable 字段的 source manifest 采用 Manifest v3，并保留至少一个有效的非空 native capability；它不支持仅有 Portable 的空原生插件。

静态 Portable root 的直接子目录分别形成完整 Skill，保留生产 README。动态 target 使用明确的 distribution 声明。实际字段、支持组件及门禁以当前 capability receipt 和 validator 为准。

确定所选 Skill 的 source、共享文件、runtime imports 与 renderer 输出。共享资源及 capability 传播采用 构建与共享（`references/build-and-sharing.md`），surface 选择采用 平台投影（`references/platform-projection.md`）。原宿主的 Hook、配置或注入能力不能视为所有 Agent 都具备的条件；仅导出目标环境能够满足的内容，并说明其要求。

维护声明或内容时按 Plugin 开发（`references/plugin-development.md`） 验证受影响消费者。保留文件和 runtime requirements receipt 由 AW 注入，source 与 renderer 不自行生成。

## 导出与核对

完成主入口的能力检查后，读取 `aw skill materialize --help`，使用公开入口：

```bash
aw skill materialize <plugin-or-source-selector> --scope <scope> \
  --skill <skill-name> --out <new-directory> --json
```

按实际选择提供参数，全部导出时省略 `--skill`。CLI 验证完整依赖闭包和候选；`--skill` 只过滤最终选择。配置来自该命令支持的来源与 scope，不套用其他命令的配置参数。

物化可能运行必要 build、runtime imports 和 renderer；静态限制下只分析 source 与声明。优先使用新隔离目录；已有目录按公开 ownership/替换规则处理，不补造 marker 或覆盖 foreign 内容。materialize 不安装到 Agent 环境，也不建立 Portable installed state，真实安装须属于用户任务。

从回执读取实际 Skill 路径、归属插件、来源绑定和能力要求，检查引用、资源闭包、未解析模板与目标环境依赖。一个依赖 Skill 仍归其实际 provider，不能归到根插件。结构通过不证明所有 Agent 均能运行。

交付实际导出位置、选择、scope、来源绑定及未验证环境。通用方法可消费该完整包；跨 profile 覆盖、修改归属与输入变化后的绑定核验使用 来源与运行包（`references/source-materialization.md`）。
