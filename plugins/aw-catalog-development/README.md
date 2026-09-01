# aw-catalog-development

维护 AW Catalog Workspace，并把日常写入、严格只读 Review 和远端发布分成三个独立入口。

## 安装

```bash
aw install aw-catalog-development -p both
```

安装会解析其对 `aw-plugin-development` 的依赖。当前生产合同使用 Plugin Manifest v3、Catalog snapshot schema 6 和 Catalog Sources Config schema 2。消费端从内容寻址的 Catalog store 读取 `Active` snapshot。

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| `author-aw-catalog` | 初始化或维护 Workspace、metadata、inventory、依赖、版本和聚合结果；显式请求时激活本地 development source。 |
| `review-aw-catalog` | 只读检查 Catalog composition 和已有 snapshot 的 `absent/current/stale/invalid` evidence。 |
| `publish-aw-catalog` | 用户明确给出 root、remote 和 branch 后，生成 plan，并在授权 `planDigest` 后 apply。 |

## 典型用法

```text
初始化当前 Git 项目为 AW Catalog Workspace，并完成空 inventory 验证。
在当前 Catalog 中新增 status-tools；插件内部修改交给 author-aw-plugin，返回后验证受影响闭包和 Catalog。
把当前 Workspace 作为本地 CLI development source。
只读评审 targets/catalog-b/plugins/worker 所属 Catalog 的 inventory、依赖图和已有 snapshot。
发布 Workspace ./catalog 到 remote staging、branch catalogs/team。
```

## 边界

- Catalog Author 不发布。普通维护运行 Catalog build/validate；显式本地使用由一次 `catalog dev activate` 完成 build、complete validate、managed source 注册、sync 和 readiness。
- Catalog Reviewer 只使用静态 status，并按需验证已存在 snapshot。它不运行插件代码、build、source mutation、publication plan/apply 或网络操作。
- Publisher 的 plan 会检查远端并执行已提交插件的 validator/build。plan 本身不授权 apply；每个完整 `planDigest` 都需要一次明确授权。
- `prepared` 或 `uncertain` 的同一 plan 可对账或重试 apply。不同 plan、损坏的 pending publication state、ref 冲突或 immutable tag 占用要求提高 Catalog version。
