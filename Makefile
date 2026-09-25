# Coding 构建/安装入口。macOS 安装应用到 /Applications，Linux 安装 CLI 到用户目录。

SHELL := /bin/sh

# install 目标目录：用户级 bin（无需 sudo），可用 DESTDIR 覆盖。
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Darwin)
INSTALL := install-app
ALL := desktop
else
INSTALL := install-cli
ALL := tui
endif

.PHONY: all runtime remote-agent desktop dev electron-app check-electron tui install install-app install-cli check uninstall help

all: $(ALL)

# 内嵌 Node Host 的 SEA 单文件运行时（所有客户端共用）。
runtime:
	pnpm run build:runtime

# SSH 首连部署的跨平台 Go remote agent（不包含 Node 运行时）。
remote-agent:
	pnpm run build:remote-agent

# macOS arm64 Electron 应用。先补齐打包所需的 devDependencies。
desktop: electron-app

electron-app:
	pnpm install --frozen-lockfile --config.confirm-modules-purge=false
	pnpm run build:desktop

# 启动 Electron 开发实例；脚本负责构建 Host、Web、helper 与桌面壳。
dev:
	pnpm run dev:electron

check-electron:
	pnpm run test:electron:packaged

# Linux 交互式 TUI。
tui:
	pnpm run build:tui

install: $(INSTALL)

install-app: desktop
	@set -eu; \
	  stage=$$(mktemp -d /Applications/.Coding-install.XXXXXXXX); \
	  installed=0; \
	  cleanup() { \
	    if [ "$$installed" -eq 0 ] && { [ -e "$$stage/previous" ] || [ -L "$$stage/previous" ]; }; then \
	      if [ -e /Applications/Coding.app ] || [ -L /Applications/Coding.app ]; then \
	        mv /Applications/Coding.app "$$stage/rejected" || return 1; \
	      fi; \
	      mv "$$stage/previous" /Applications/Coding.app || { \
	        echo "Coding: 恢复失败，原应用保留在 $$stage/previous" >&2; return 1; \
	      }; \
	    fi; \
	    rm -rf "$$stage"; \
	  }; \
	  trap cleanup EXIT; \
	  trap 'exit 1' HUP INT TERM; \
	  cp -R dist/Coding.app "$$stage/Coding.app"; \
	  if [ -e /Applications/Coding.app ] || [ -L /Applications/Coding.app ]; then mv /Applications/Coding.app "$$stage/previous"; fi; \
	  mv "$$stage/Coding.app" /Applications/Coding.app; \
	  installed=1; \
	  echo "Coding: 已安装 /Applications/Coding.app"

install-cli: tui runtime
	mkdir -p $(BINDIR)
	install -m 0755 dist/coding $(BINDIR)/coding
	@echo "Coding: 已安装 $(BINDIR)/coding"

# 快速验证 SEA 运行时可启动（就绪行出现即通过，随后停止）。
check: runtime
	@DSH_HOME=$$(mktemp -d) ./scripts/check-runtime-start.sh

uninstall:
	rm -rf /Applications/Coding.app
	rm -f $(BINDIR)/coding

help:
	@echo "目标：dev（Electron 开发实例）/ desktop 或 electron-app（macOS Electron 包）/ check-electron / runtime / tui / install（macOS 应用或 Linux CLI）/ uninstall"
	@echo "macOS 应用：dist/Coding.app，本机 ad-hoc 签名，未经公证；make install 会替换 /Applications/Coding.app"
