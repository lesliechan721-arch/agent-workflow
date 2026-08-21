.DEFAULT_GOAL := help

PNPM ?= pnpm

.PHONY: help install build test verify-local verify-cli verify-catalog verify-release pack-cli local-install

help:
	@printf '%s\n' \
		'make install                         安装工作区依赖' \
		'make build                           编译 CLI 与 schema 4 本地 catalog snapshot' \
		'make test                            运行单元/集成测试' \
		'make verify-local                    校验 CLI 本地发布链路（runtime/pack smoke）' \
		'make verify-cli                      校验 CLI-only 发布链路' \
		'make verify-catalog                  校验 catalog-only 发布链路' \
		'make verify-release                  校验 CLI + catalog 组合发布链路' \
		'make pack-cli                        生成 CLI tarball' \
		'make local-install                   打包并执行 npm 全局安装，验证 CLI 本地安装链路'

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

local-install:
	$(PNPM) run release:local
