# Install Coding

English | [中文](install.zh.md)

Coding ships the same local agent Host with two clients: a native desktop GUI on macOS and Windows, and an interactive terminal UI on Linux. All clients share one `$DSH_HOME` (default `~/.dsh`), so sessions, settings, and credentials stay in one place.

## Platform matrix

| Platform | Client | Artifact |
| --- | --- | --- |
| macOS arm64 | Native GUI (WKWebView) | `Coding.app` / `.dmg` |
| Windows x64 | Native GUI (WebView2) | installer |
| Linux x64 | Interactive terminal UI | single `coding` executable |

## What runs on your machine

The client binary embeds the Node Host runtime. On first run it materializes the runtime into `$DSH_HOME/runtime/<sha256>` and starts the Host from there; installing Node separately is not required. The directory name is the content hash of the embedded archive, so a later product version that ships the same bytes reuses that directory. Only the current archive's runtime directory is kept after a successful start.

The Host binds to loopback only. Clients discover it through `$DSH_HOME/host.json` and connect over the existing HTTP/WebSocket API; an idle Host with no connected client and no running task exits after five minutes.

## Install the desktop app

Download the release artifact for your platform and install it manually:

- macOS: mount the `.dmg` and drag **Coding** into `Applications`.
- Windows: run the installer. If the WebView2 runtime is missing, the app shows the official Microsoft download link before exiting.

Start **Coding** from your applications menu. The window loads the local Web UI directly; there is no browser dependency. A second launch focuses the existing window instead of starting a new app. On macOS, closing the main window keeps Coding in the menu bar; use its status item to show or hide the window, or choose **Quit Coding** to end the desktop app.

## Install the Linux client

Copy the `coding` executable into a directory on your `PATH`, for example `/usr/local/bin`:

```sh
sudo install coding /usr/local/bin/coding
```

Run `coding` in any terminal. Use `coding --cwd <dir>` to change the default workspace directory.

## Where data lives

All sessions, settings, credentials, plugins, and materialized runtimes stay under `$DSH_HOME`. Set the `DSH_HOME` environment variable to relocate everything. Removing that directory resets the client to a clean install.
