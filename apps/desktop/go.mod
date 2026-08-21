module github.com/deepseek-ai/coding/apps/desktop

go 1.24.0

require (
	github.com/deepseek-ai/coding/apps/internal/hostlaunch v0.0.0
	github.com/webview/webview_go v0.0.0-20240831120633-6173450d4dd6
)

require golang.org/x/sys v0.36.0 // indirect

replace github.com/deepseek-ai/coding/apps/internal/hostlaunch => ../internal/hostlaunch
