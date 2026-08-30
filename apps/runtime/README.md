# Coding Host Runtime

English | [中文](README.zh.md)

This deploy-only manifest defines the Node Host closure shipped by Coding clients. It is not an end-user package; [`scripts/build-coding-runtime.ts`](../../scripts/build-coding-runtime.ts) builds the CLI and Web artifacts, deploys a symlink-free closure, and emits both the pre-expanded `Coding.app/Contents/Resources/runtime` payload for macOS and the SEA archive used by the Linux terminal launcher.
