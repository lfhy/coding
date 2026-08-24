# Coding

English | [中文](README.zh.md)

Coding is a personal AI coding client built on the DeepSeek Harness (`dsh`) runtime developed by [DeepSeek AI](https://deepseek.com). The product name, application name, and Linux command are `Coding` and `coding`; internal `@deepseek-ai/dsh` packages, plugins, protocol identifiers, and `$DSH_HOME` data remain compatible with the DeepSeek Harness runtime.

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

Coding is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Clients

| Platform | Client | Status |
| --- | --- | --- |
| macOS arm64 | Native Coding GUI backed by the local Node Host | Planned |
| Windows amd64 | Native Coding GUI backed by the local Node Host | Planned |
| Linux amd64 | Interactive `coding` terminal UI backed by the local Node Host | Planned |

The desktop GUI reuses the existing Web interface in a native WebView. The terminal UI and GUI share sessions, settings, and credentials through `$DSH_HOME` (normally `~/.dsh`) and attach to one local Host when possible. Release artifacts will include the Host runtime, so end users will not need a separate Node installation.

The native desktop window starts maximized. Double-clicking the empty top window area toggles maximization, and sidebar controls keep clear of the macOS traffic-light safe area.

## Run

### Run the current runtime from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The current runtime command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git coding
cd coding
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding. The staged native Coding desktop and terminal launchers are tracked in [TODO.md](TODO.md).

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
