//go:build !windows

package desktopremote

import "os"

// replaceMarkerFile 在同一文件系统内原子替换 marker。
func replaceMarkerFile(source, destination string) error {
	return os.Rename(source, destination)
}
