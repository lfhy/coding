# @deepseek-ai/node-addon-landlock-run-linux-arm64

English | [中文](README.zh.md)

Prebuilt `bin/landlock-run` Landlock launcher for linux-arm64 — a static musl binary compiled natively (no cross toolchain) from the C source shipped in [`@deepseek-ai/node-addon-landlock-run`](https://www.npmjs.com/package/@deepseek-ai/node-addon-landlock-run). npm's `os`/`cpu` fields select this package at install time; the entry package resolves it to a file path — it ships no JavaScript and is never imported.

The binary is git-ignored and enters a local npm tarball through the `files` list; the `prepack` gate refuses to pack when it is missing or has the wrong ELF architecture, and `verify-packed-install.mjs` byte-pins the installed binary against its local workspace build. Static musl linking means one binary for glibc and musl distros alike — hence no libc suffix in the name.

Sibling: `@deepseek-ai/node-addon-landlock-run-linux-x64`.
