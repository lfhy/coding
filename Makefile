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

.PHONY: all runtime desktop tui install install-app install-cli check uninstall help

all: $(CLIENT)

# 内嵌 Node Host 的 SEA 单文件运行时（所有客户端共用）。
runtime:
	pnpm run build:runtime

# macOS/Windows 桌面 GUI 壳（需要 CGO 与系统 WebView）。
desktop:
	pnpm run build:desktop

# Linux 交互式 TUI。
tui:
	pnpm run build:tui

install: $(INSTALL)

install-app: desktop runtime
	./scripts/package-macos-app.sh
	rm -rf /Applications/Coding.app
	cp -R dist/Coding.app /Applications/
	@touch /Applications/Coding.app
	@/usr/bin/killall Finder >/dev/null 2>&1 || true
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
	@echo "目标：runtime / desktop / tui / install（macOS 装 /Applications，Linux 装 ~/.local/bin）/ uninstall"
	@echo "签名：CODESIGN_IDENTITY=\"Apple Development: …\" make install（默认 ad-hoc）"
