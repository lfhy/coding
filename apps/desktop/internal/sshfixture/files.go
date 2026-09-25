package sshfixture

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/pkg/sftp"
)

type fileHandlers struct{ root string }

// relative 保留客户端看到的绝对路径，同时将所有 SFTP 操作关在本次临时目录内。
func (h *fileHandlers) relative(name string) (string, error) {
	if name != h.root && !strings.HasPrefix(name, h.root+string(filepath.Separator)) {
		return "", os.ErrPermission
	}
	rel, err := filepath.Rel(h.root, name)
	if err != nil || (rel != "." && !filepath.IsLocal(rel)) {
		return "", os.ErrPermission
	}
	return rel, nil
}

func (h *fileHandlers) Fileread(request *sftp.Request) (io.ReaderAt, error) {
	rel, err := h.relative(request.Filepath)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(h.root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return root.Open(rel)
}

func (h *fileHandlers) Filewrite(request *sftp.Request) (io.WriterAt, error) {
	rel, err := h.relative(request.Filepath)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(h.root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	flags := request.Pflags()
	if !flags.Write || flags.Append || flags.Read {
		return nil, os.ErrPermission
	}
	mode := os.O_WRONLY
	if flags.Creat {
		mode |= os.O_CREATE
	}
	if flags.Excl {
		mode |= os.O_EXCL
	}
	if flags.Trunc {
		mode |= os.O_TRUNC
	}
	return root.OpenFile(rel, mode, 0o600)
}

func (h *fileHandlers) Filecmd(request *sftp.Request) error {
	rel, err := h.relative(request.Filepath)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(h.root)
	if err != nil {
		return err
	}
	defer root.Close()
	switch request.Method {
	case "Mkdir":
		return root.Mkdir(rel, 0o700)
	case "Remove", "Rmdir":
		return root.Remove(rel)
	case "Rename":
		target, err := h.relative(request.Target)
		if err != nil {
			return err
		}
		return root.Rename(rel, target)
	case "Setstat":
		if request.AttrFlags().Permissions {
			return root.Chmod(rel, os.FileMode(request.Attributes().Mode)&0o700)
		}
		return nil
	default:
		return os.ErrPermission
	}
}

type fileList []os.FileInfo

func (list fileList) ListAt(destination []os.FileInfo, offset int64) (int, error) {
	if offset >= int64(len(list)) {
		return 0, io.EOF
	}
	count := copy(destination, list[offset:])
	if int(offset)+count >= len(list) {
		return count, io.EOF
	}
	return count, nil
}

func (h *fileHandlers) Filelist(request *sftp.Request) (sftp.ListerAt, error) {
	rel, err := h.relative(request.Filepath)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(h.root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	switch request.Method {
	case "Stat", "Lstat":
		var info os.FileInfo
		if request.Method == "Lstat" {
			info, err = root.Lstat(rel)
		} else {
			info, err = root.Stat(rel)
		}
		if err != nil {
			return nil, err
		}
		return fileList{info}, nil
	case "List":
		file, err := root.Open(rel)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		entries, err := file.Readdir(0)
		return fileList(entries), err
	default:
		return nil, errors.New("unsupported SFTP listing")
	}
}
