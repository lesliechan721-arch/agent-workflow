# AW Dynamic Artifact Renderer

只在插件通过 AW config 生成 Codex/Claude Skill、developer instructions、agent role 或其它受管 artifact 时读取。

## 动态 Artifact Renderer

动态 artifact 用于“产物内容或启用状态由 AW config 决定，但写盘必须由 AW 管理”的平台能力。当前 target 包括：

- `codex.skill`：写入 Codex skill 目录。配置驱动的 skill 优先使用它，而不是 lifecycle 直接改 `.agents/skills/**` 或用户级 Codex runtime。
- `claude.skill`：写入独立的 Claude user/project skill 目录，不使用插件 namespace。
- `codex.developerInstructionsBlock`：写入当前 scope 的 Codex AW managed developer instructions block。
- `codex.agentRole`：写入 role layer 文件，并在当前 scope Codex config 中注册 `[agents.<roleKey>]`。

manifest 中要同时声明 `scripts.artifacts.render` 和 `artifacts.targets`。`artifacts.targets` 是 rebuild 和 live status 的能力真值；renderer 只负责根据当前 config 输出 `ArtifactPlan`。

```json
{
  "scripts": {
    "artifacts": {
      "render": {
        "runner": "node",
        "path": "./scripts/render-artifacts.mjs"
      }
    }
  }
}
```

renderer 在 install、upgrade、reinstall 和配置触发的 reinstall 中执行。`aw status` 不执行 renderer 或 lifecycle。renderer 通过 `AW_PLUGIN_CONTEXT` 读取 JSON context，常用字段包括：

- `event`、`platform`、`scope`
- `plugin.name`、`plugin.version`、`plugin.rootDir`、`paths.manifestPath`
- `artifactSources`，包含 target 的已暂存 `sourceDirs` 绝对路径；renderer 只能读取这些目录
- `config.mode`、`config.targetScope`、`config.values`、`config.sources` 和 `config.issues`
- `changedConfigKeys`，仅 refresh 事件表示本次命中的配置 key
- `previousArtifacts`、AW/Codex/Claude home 和 renderer digest 等诊断信息

artifact render config 和 `aw config get/list` 的 effective config 不同：

- user scope artifact 只按 `schema default < user store` 渲染。
- project scope artifact 只按 `schema default < project shared store` 中可共享的非路径 key 渲染。
- project config 不会影响 user artifact 的内容、digest、stale 判断或 refresh 结果。

user store、project local store 和 `file` / `directory` key 只影响本机 effective config、lifecycle 或 helper，不进入 repo-visible artifact truth。

renderer stdout 必须只输出 JSON：

```json
{
  "version": 2,
  "artifacts": [
    {
      "id": "codex-explore-skill",
      "kind": "skill",
      "platform": "codex",
      "target": "codex.skill",
      "state": "present",
      "skillKey": "codex-explore",
      "refreshKeys": ["explorerModel", "modelReasoningEffort"],
      "content": {
        "files": {
          "SKILL.md": "---\nname: codex-explore\n---\n# Codex Explore\n",
          "references/config.md": "Model: gpt-5.6-terra\n"
        }
      }
    }
  ]
}
```

`ArtifactPlan` 只接受 V2。V1 会失败，并要求用户升级或重新安装插件。`disabled` artifact 可以省略 `content`，但必须保留声明过的 `refreshKeys`，并建议写 `disabledReason: "config"`。

`codex.skill` / `claude.skill` 必须在 manifest 静态声明 `skillKey`。静态完整目录来自 `sourceDirs`：AW 按声明顺序做字节级合并，后面的目录覆盖前面的文件。renderer 的 `content.files` 再覆盖静态树，只接受 UTF-8 字符串和安全的 POSIX 相对路径。最终 Codex tree 必须有 `SKILL.md` 与 `agents/openai.yaml`；最终 Claude tree 必须有 `SKILL.md`。AW apply 阶段 patch 对应平台的触发字段。同一插件声明多个 `codex.developerInstructionsBlock` artifact 时，AW 会按 `artifact.id` 稳定排序后合成为一个 managed block；disabled instruction artifact 只会从合成内容里省略自己的 fragment，所有 instruction artifact 都 disabled 时才移除该插件的 managed block。status 和 refresh preflight 会按合成后的 managed block digest 诊断用户编辑造成的 content drift。`codex.agentRole` 的 `roleKey` 和 `roleFile.name` 必须与 manifest 静态 `artifacts.targets[].roleKey` 一致；`registration.config_file` 和 role layer 路径由 AW 生成，renderer 不能提供。

renderer 不能直接写 Codex/Claude Skill runtime、`.codex/config.toml`、`.codex/agents/*.toml` 或其它 AW 受管文件。写盘和 ownership inspection 集中在 rebuild target apply。

配置写入只覆盖当前命令能定位到的 target，并对这些 target 运行完整 reinstall。CLI 不扫描其它历史 project；receipt 会提示其它项目需要手动 reinstall。动态 artifact 写动作必须来自明确的 platform、scope 和 project root，renderer 仍只返回 plan，不能自行写 AW 受管输出。
