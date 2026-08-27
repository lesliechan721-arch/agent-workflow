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
| `author-aw-catalog` | 初始化或维护 Catalog metadata、插件 inventory、依赖和精确版本，并运行聚合验证。 |
| `review-aw-catalog` | 只读评审 Catalog composition、版本一致性和现有发布证据。 |
| `publish-aw-catalog` | 在精确 preflight 身份获得用户授权后发布到明确的 Git remote 和 branch。 |

## 典型用法

```text
在这个 Catalog Workspace 中加入 plugins/status-tools，并完成整个 Catalog 的验证。插件内部修改交给 author-aw-plugin。
只读评审这个 Catalog 的 inventory、依赖图、版本一致性和现有 snapshot 证据。
使用 $publish-aw-catalog 发布到 remote staging、branch catalogs/team。
```

## 边界

- 日常维护不会发布。插件 manifest、Skill、extension、config、lifecycle 和 artifact 由 `author-aw-plugin` 修改。
- Catalog Review 不修改文件、不运行 build，也不评审单插件内部质量或跨插件业务 workflow。
- Publish 只接受用户明确给出的 remote 和 branch。Preflight 会执行已提交插件的 validator 和 build code。每个精确发布身份都需要单独授权。
