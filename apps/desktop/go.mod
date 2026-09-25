module github.com/deepseek-ai/coding/apps/desktop

go 1.25.0

require (
	github.com/creack/pty v1.1.24
	github.com/deepseek-ai/coding/apps/internal/hostlaunch v0.0.0
	github.com/dop251/goja v0.0.0-20260826204918-8f1c0696a37b
	github.com/evanw/esbuild v0.28.2
	github.com/pkg/sftp v1.13.9
	golang.org/x/crypto v0.53.0
	golang.org/x/sys v0.46.0
)

require (
	github.com/dlclark/regexp2/v2 v2.5.2 // indirect
	github.com/go-sourcemap/sourcemap v2.1.3+incompatible // indirect
	github.com/google/pprof v0.0.0-20230207041349-798e818bf904 // indirect
	github.com/kr/fs v0.1.0 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
	golang.org/x/text v0.39.0 // indirect
)

replace github.com/deepseek-ai/coding/apps/internal/hostlaunch => ../internal/hostlaunch
