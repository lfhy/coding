package remoteagent

import (
	"path/filepath"
	"strings"
)

// sessionOwnerRoot 只规范化 bridge 在启动时固化的所有权路径，不读取文件系统。
// 会话存活期间目录可能被移动或删除；后续清理仍必须能用原 owner key 找到它。
func sessionOwnerRoot(root string) (string, error) {
	value := strings.TrimSpace(root)
	if value == "" {
		return "", nil
	}
	if strings.ContainsRune(value, '\x00') || !filepath.IsAbs(value) {
		return "", fail(400, "invalid-root", "session root must be an absolute path")
	}
	return filepath.Clean(value), nil
}

// canonicalSessionRoot 在启动会话前验证所有权根是可解析的现存目录；返回值只
// 用于文件系统范围检查，不得在后续句柄鉴权时重新计算。
func canonicalSessionRoot(root string) (string, error) {
	ownerRoot, err := sessionOwnerRoot(root)
	if err != nil || ownerRoot == "" {
		return ownerRoot, err
	}
	return resolveScopedPath(ownerRoot, ownerRoot, false)
}
