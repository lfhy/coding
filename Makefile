# Coding 构建/安装入口。make install 把本机产物装进用户可执行目录；
# 未构建时先按平台补齐所需产物。

SHELL := /bin/sh

# install 目标目录：用户级 bin（无需 sudo），可用 DESTDIR 覆盖。
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Darwin)
CLIENT := dist/Coding
INSTALL := install-app
else
CLIENT := dist/coding
INSTALL := install-cli
endif

.PHONY: all runtime remote-agent desktop dev tui install install-app install-cli check uninstall help

all: $(CLIENT)

# 内嵌 Node Host 的 SEA 单文件运行时（所有客户端共用）。
runtime:
	pnpm run build:runtime

# SSH 首连部署的跨平台 Go remote agent（不包含 Node 运行时）。
remote-agent:
	pnpm run build:remote-agent

# macOS/Windows 桌面 GUI 壳（需要 CGO 与系统 WebView）。先补齐 devDependencies，
# 同时修复被中断的 legacy runtime deploy 可能留下的生产依赖状态。
desktop:
	pnpm install --frozen-lockfile --config.confirm-modules-purge=false
	pnpm run build:desktop

# 使用仓库锁定的 Wails CLI 和当前源码产物启动独立的桌面开发实例。
dev:
	node scripts/dev-desktop.mjs --check-platform
	pnpm run build
	mkdir -p .dsh-build/desktop
	ln -sfn ../../apps/desktop/packaging/icon.iconset/icon_512x512@2x.png .dsh-build/desktop/appicon.png
	cd apps/desktop && CGO_ENABLED=1 GOBIN="$(CURDIR)/.dsh-build" go install github.com/wailsapp/wails/v2/cmd/wails@$$(go list -m -f '{{.Version}}' github.com/wailsapp/wails/v2)
	node scripts/dev-desktop.mjs

# Linux 交互式 TUI。
tui:
	pnpm run build:tui

install: $(INSTALL)

install-app: desktop runtime remote-agent
	./scripts/package-macos-app.sh
	rm -rf /Applications/Coding.app
	cp -R dist/Coding.app /Applications/
	@touch /Applications/Coding.app
	@echo "Coding: 已安装 /Applications/Coding.app"

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
	@echo "目标：dev（独立桌面开发实例）/ runtime / desktop / tui / install（macOS 装 /Applications，Linux 装 ~/.local/bin）/ uninstall"
	@echo "签名：CODESIGN_IDENTITY=\"Apple Development: …\" make install（默认 ad-hoc）"
