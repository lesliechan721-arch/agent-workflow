.DEFAULT_GOAL := help

PNPM ?= pnpm
VERSION ?=

.PHONY: help install build test verify-local verify-release pack local-install version-beta version-release beta-release release

help:
	@printf '%s\n' \
		'make install                         安装工作区依赖' \
		'make build                           编译 CLI 与 embedded bundle' \
		'make test                            运行单元/集成测试' \
		'make verify-local                    校验本地开发发布流程（test + smoke build）' \
		'make verify-release                  校验测试版/正式版发布流程（含 tarball smoke）' \
		'make pack                            生成 .release/tarballs 下的本地 tarball' \
		'make local-install                   打包并执行 npm 全局安装，验证本地安装链路' \
		'make version-beta VERSION=x.y.z-beta.0   同步测试版版本号到两个 package.json' \
		'make version-release VERSION=x.y.z        同步正式版版本号到两个 package.json' \
		'make beta-release VERSION=x.y.z-beta.0    发布测试版（dist-tag: beta）' \
		'make release VERSION=x.y.z               发布正式版（dist-tag: latest）'

install:
	$(PNPM) install

build:
	$(PNPM) build

test:
	$(PNPM) test

verify-local:
	$(PNPM) run release:verify:local

verify-release:
	$(PNPM) run release:verify

pack:
	$(PNPM) run release:pack

local-install:
	$(PNPM) run release:local

version-beta:
	@test -n "$(VERSION)" || (echo 'VERSION is required. Example: make version-beta VERSION=0.2.0-beta.0' && exit 1)
	$(PNPM) run version:set:beta -- $(VERSION)

version-release:
	@test -n "$(VERSION)" || (echo 'VERSION is required. Example: make version-release VERSION=0.2.0' && exit 1)
	$(PNPM) run version:set:release -- $(VERSION)

beta-release:
	@test -n "$(VERSION)" || (echo 'VERSION is required. Example: make beta-release VERSION=0.2.0-beta.0' && exit 1)
	$(PNPM) run version:set:beta -- $(VERSION)
	$(PNPM) run release:publish:beta

release:
	@test -n "$(VERSION)" || (echo 'VERSION is required. Example: make release VERSION=0.2.0' && exit 1)
	$(PNPM) run version:set:release -- $(VERSION)
	$(PNPM) run release:publish:latest
