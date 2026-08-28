# aw-catalog-development

维护完整 AW Catalog Workspace，并把日常维护、只读 composition Review 和远端发布分成三个独立入口。

## 安装

```bash
aw install aw-catalog-development -p both
```

安装会解析其对 `aw-plugin-development` 的依赖。

## 包含的 Skill

| Skill | 用途 |
| --- | --- |
| `author-aw-catalog` | 用 CLI context 初始化或维护当前 Catalog、聚合验证，并管理 development source。 |
| `review-aw-catalog` | 只读评审 Catalog composition、版本一致性和现有 snapshot/发布证据。 |
| `publish-aw-catalog` | 对清晰发布意图先做 preflight，再经本次精确授权发布。 |

## 典型用法

```text
初始化当前项目为 AW Catalog Workspace。
在当前 Catalog 中加入 plugins/status-tools，并完成 Catalog 验证。插件内部修改交给 author-aw-plugin。
删除 plugins/old-plugin。先检查 inventory、反向依赖和版本策略，再验证受影响的闭包并完成 Catalog 验证。
把当前 Catalog 作为 aw CLI source；也可以查看或停用它。
只读评审当前 Catalog 的 inventory、依赖图、版本一致性和现有 snapshot 证据。
发布当前 Catalog。
```

## 边界

- 日常维护不会发布。普通用户的删除请求只使用 `author-aw-catalog`；它编排后把实际删除交给 `author-aw-plugin` 的公开 CLI 分支。删除后重新读取 inventory/依赖，只验证受影响插件与反向依赖闭包；不会创建 tombstone、retirement metadata 或 release ledger。
- Catalog Review 不修改文件、不运行 plugin test/build、Catalog build 或 preflight，也不评审单插件内部质量或跨插件业务 workflow。
- Publish 从 CLI context 解析 root、remote 和 branch。Preflight 会执行已提交插件的 validator 和 build code；每个精确发布 identity 都需要本次单独授权，且 Catalog 不支持同版本重试或 repair。
