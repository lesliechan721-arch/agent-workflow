---
name: publish-aw-catalog
description: >-
  仅当用户显式调用本宏并要求发布 AW Catalog 时使用。生成可核对的 publication plan，在该完整 planDigest 获得授权后 apply，并核验发布证据。
compatibility: 需要 Node.js 22+、PATH 中可用的 aw CLI 和合法 AW Catalog Workspace。
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: 手动授权并发布 AW Catalog
---

# Publish AW Catalog

将用户选择的 Catalog 发布为具体计划绑定的远端结果。普通开发、验证或自然语言请求不自动启动本宏；公开 CLI 负责 journal、Git refs、tag 和恢复算法。

## 准备具体计划

从本 Skill 实际 root 运行 `aw self check --from <skill-root> --json`，失败即停止。

保留用户已指定的 Workspace root、remote 和 branch；缺省项交给 CLI 解析。当前默认是最近合法 Workspace、`origin` 或唯一 remote，以及 `catalog` 分支，后者不是当前 Git branch。只有无法唯一解析或结果与用户意图冲突时才澄清。

先查询 `aw catalog publish plan --help`，用已给参数生成 JSON plan，省略未指定项。说明该操作会读取远端 refs，并从已提交 source HEAD 执行插件 validator/build 和 Catalog build。计划失败时报告诊断，不请求 apply 授权。

## 核对计划与授权

从同一 receipt 展示 workspaceRoot、workspaceIdentity、sourceHead、catalogVersion、channel、pluginCount、remote、安全的 fetchUrl/pushUrl、remote identity digest、branch、parent、tag、expectedCommit、snapshotDigest、state 和完整 planDigest。缺少必需字段时停止，不猜测或重算。

授权须对应这一完整 planDigest 与 canonical `{descriptor, expectedCommit}`。已有明确授权仍覆盖同一计划时沿用；否则展示具体计划后请求一次确认。初始发布请求或其他计划的授权不能代替它；用户拒绝即停止。

## 应用已授权计划

将 plan 解析出的 root、remote、branch 与完整 planDigest 显式传给 `aw catalog publish apply`，使用 `--expected-plan-digest <planDigest> --yes --json`，不再次依赖缺省解析。

核对 apply receipt 的 identity、sourceHead、remote digest、branch、expectedCommit、snapshotDigest 和 planDigest 与该计划一致。prepared/uncertain 状态按 CLI 指示使用同一 digest 对账或续跑；identity、branch、remote、pending repository 或 immutable tag 冲突时停止，不手工修改状态。

## 确认实际结果

以 published journal 和已核验的 remote refs 确认成功。报告实际发布目标、版本、计划与结果；准备成功不等于远端发布成功。cleanup warning 单独说明，保留 CLI 给出的恢复方式，不自行删除 residue。
