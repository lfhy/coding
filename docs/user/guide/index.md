# Use the Web UI

English | [中文](index.zh.md)

Start the Web UI through the [root README](../../../README.md#run); the command prints its URL. This guide begins after that server is running. The `dsh` process uses its invoking directory as the default filesystem location; a fresh Web UI starts without a selected Workspace.

## Configure a model

Open **Settings → Models**, enter a [DeepSeek API key](https://platform.deepseek.com/), and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose how to start

Click **Choose workspace** to search the listed Workspaces. To work locally, select an existing Workspace or choose **Open folder** and select the project directory. The composer becomes available after that Session opens.

Choose **Work without a project** to create a Session at the Host's default working directory without registering a Workspace. The composer is unavailable only while there is no current Session.

Choose **Connect to remote** to open an already reachable Host page. Enter its full `http://` or `https://` address, such as an HTTPS deployment or an SSH local port-forward address. This action navigates to the target; it does not create an SSH tunnel, authenticate, or discover a Host.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/)
