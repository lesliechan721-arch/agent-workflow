.DEFAULT_GOAL := help

PNPM ?= pnpm
CLI_VERSION ?=
CATALOG_VERSION ?=

.PHONY: help install build test verify-local verify-cli verify-catalog verify-release pack-cli stage-catalog local-install version-beta version-release publish-cli-beta publish-cli-release publish-catalog-beta publish-catalog-release beta-release release

help:
	@printf '%s\n' \
		'make install                         安装工作区依赖' \
		'make build                           编译 CLI 与 schema 3 本地 catalog snapshot' \
		'make test                            运行单元/集成测试' \
		'make verify-local                    校验 CLI 本地发布链路（runtime/pack smoke）' \
		'make verify-cli                      校验 CLI-only 发布链路' \
		'make verify-catalog                  校验 catalog-only 发布链路' \
		'make verify-release                  校验 CLI + catalog 组合发布链路' \
		'make pack-cli                        生成 CLI tarball' \
		'make stage-catalog CATALOG_VERSION=x.y.z[-beta.n] 生成本地 Git catalog 发布 staging' \
		'make local-install                   打包并执行 npm 全局安装，验证 CLI 本地安装链路' \
		'make version-beta CLI_VERSION=x.y.z-beta.0        同步测试版 CLI 版本到两个 package.json' \
		'make version-release CLI_VERSION=x.y.z            同步正式版 CLI 版本到两个 package.json' \
		'make publish-cli-beta CLI_VERSION=x.y.z-beta.0    发布 CLI 测试版（dist-tag: beta）' \
		'make publish-cli-release CLI_VERSION=x.y.z        发布 CLI 正式版（dist-tag: latest）' \
		'make publish-catalog-beta CATALOG_VERSION=x.y.z-beta.0   本地验证/stage 后等待 Phase 4B' \
		'make publish-catalog-release CATALOG_VERSION=x.y.z       本地验证/stage 后等待 Phase 4B' \
		'make beta-release CLI_VERSION=x.y.z-beta.0 CATALOG_VERSION=a.b.c-beta.n   本地验证/stage 后等待 Phase 4B' \
		'make release CLI_VERSION=x.y.z CATALOG_VERSION=a.b.c                        本地验证/stage 后等待 Phase 4B'

install:
	$(PNPM) install

build:
	$(PNPM) build

test:
	$(PNPM) test

verify-local:
	$(PNPM) run release:verify:local

verify-cli:
	$(PNPM) run release:verify:cli

verify-catalog:
	$(PNPM) run release:verify:catalog

verify-release:
	$(PNPM) run release:verify

pack-cli:
	$(PNPM) run release:pack:cli

stage-catalog:
	@test -n "$(CATALOG_VERSION)" || (echo 'CATALOG_VERSION is required. Example: make stage-catalog CATALOG_VERSION=1.2.0-beta.1' && exit 1)
	$(PNPM) run release:stage:catalog -- --catalog-version $(CATALOG_VERSION)

local-install:
	$(PNPM) run release:local

version-beta:
	@test -n "$(CLI_VERSION)" || (echo 'CLI_VERSION is required. Example: make version-beta CLI_VERSION=0.2.0-beta.0' && exit 1)
	$(PNPM) run version:set:beta -- $(CLI_VERSION)

version-release:
	@test -n "$(CLI_VERSION)" || (echo 'CLI_VERSION is required. Example: make version-release CLI_VERSION=0.2.0' && exit 1)
	$(PNPM) run version:set:release -- $(CLI_VERSION)

publish-cli-beta:
	@test -n "$(CLI_VERSION)" || (echo 'CLI_VERSION is required. Example: make publish-cli-beta CLI_VERSION=0.2.0-beta.0' && exit 1)
	$(PNPM) run version:set:beta -- $(CLI_VERSION)
	$(PNPM) run release:publish:cli:beta

publish-cli-release:
	@test -n "$(CLI_VERSION)" || (echo 'CLI_VERSION is required. Example: make publish-cli-release CLI_VERSION=0.2.0' && exit 1)
	$(PNPM) run version:set:release -- $(CLI_VERSION)
	$(PNPM) run release:publish:cli:latest

publish-catalog-beta:
	@test -n "$(CATALOG_VERSION)" || (echo 'CATALOG_VERSION is required. Example: make publish-catalog-beta CATALOG_VERSION=1.2.0-beta.1' && exit 1)
	$(PNPM) run version:catalog:check:beta -- $(CATALOG_VERSION)
	$(PNPM) run release:publish:catalog:beta -- --catalog-version $(CATALOG_VERSION)

publish-catalog-release:
	@test -n "$(CATALOG_VERSION)" || (echo 'CATALOG_VERSION is required. Example: make publish-catalog-release CATALOG_VERSION=1.2.0' && exit 1)
	$(PNPM) run version:catalog:check:release -- $(CATALOG_VERSION)
	$(PNPM) run release:publish:catalog:latest -- --catalog-version $(CATALOG_VERSION)

beta-release:
	@test -n "$(CLI_VERSION)" || (echo 'CLI_VERSION is required. Example: make beta-release CLI_VERSION=0.2.0-beta.0 CATALOG_VERSION=1.2.0-beta.1' && exit 1)
	@test -n "$(CATALOG_VERSION)" || (echo 'CATALOG_VERSION is required. Example: make beta-release CLI_VERSION=0.2.0-beta.0 CATALOG_VERSION=1.2.0-beta.1' && exit 1)
	$(PNPM) run version:set:beta -- $(CLI_VERSION)
	$(PNPM) run version:catalog:check:beta -- $(CATALOG_VERSION)
	$(PNPM) run release:publish:beta -- --cli-version $(CLI_VERSION) --catalog-version $(CATALOG_VERSION)

release:
	@test -n "$(CLI_VERSION)" || (echo 'CLI_VERSION is required. Example: make release CLI_VERSION=0.2.0 CATALOG_VERSION=1.2.0' && exit 1)
	@test -n "$(CATALOG_VERSION)" || (echo 'CATALOG_VERSION is required. Example: make release CLI_VERSION=0.2.0 CATALOG_VERSION=1.2.0' && exit 1)
	$(PNPM) run version:set:release -- $(CLI_VERSION)
	$(PNPM) run version:catalog:check:release -- $(CATALOG_VERSION)
	$(PNPM) run release:publish:latest -- --cli-version $(CLI_VERSION) --catalog-version $(CATALOG_VERSION)
