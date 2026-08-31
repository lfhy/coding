# Use the Web UI

English | [中文](index.zh.md)

Start the Web UI through the [root README](../../../README.md#run); the command prints its URL. This guide begins after that server is running. The `dsh` process uses its invoking directory as the default filesystem location; a fresh Web UI starts without a selected Workspace.

## Configure a model

Open **Settings → Models**, enter a [DeepSeek API key](https://platform.deepseek.com/), and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose how to start

Click **Choose workspace** to search the listed Workspaces. To work locally, select an existing Workspace or choose **Open folder** and select the project directory. The composer becomes available after that Session opens.

Choose **Work without a project** to create a Session at the Host's default working directory without registering a Workspace. The composer is unavailable only while there is no current Session.

In the Coding desktop app, choose **Connect Remote-SSH** to enter an SSH host, authenticate with a password or private key, confirm an unknown host key, and select a remote directory. Credentials stay in the current dialog/connection and are not saved; after restarting the app, run the connection flow again. The ordinary browser UI cannot start an SSH connection.

Remote-SSH runs semantic filesystem operations, `glob`/`grep`, foreground and background Bash, persistent terminals/PTYs, LSP, and Code Mode in the selected directory through a compact Go agent. The target does not need Node; the local Host still owns tool approval and durable Session logging. Remote Bash requires **Full access** (`danger-full-access`) until a same-world remote sandbox provider exists. Code Mode transforms TypeScript with esbuild and runs it in Goja, so it has declared tool bindings but not Node built-ins, `process`, `require`, or the Host environment. A stale marker or lost connection fails rather than running the operation on the local machine.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/)
