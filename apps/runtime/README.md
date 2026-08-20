# Coding Host Runtime

This deploy-only manifest defines the Node Host closure embedded by Coding desktop and terminal launchers. It is not an end-user package; [`scripts/build-coding-runtime.ts`](../../scripts/build-coding-runtime.ts) builds the CLI and Web artifacts, deploys this closure, and packages it for the SEA bootstrapper.
