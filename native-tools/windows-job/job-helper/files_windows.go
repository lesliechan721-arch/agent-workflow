package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func normalizedPath(target string) error {
	if target == "" || strings.ContainsRune(target, 0) || !filepath.IsAbs(target) || filepath.Clean(target) != target || strings.Contains(target, "/") {
		return errors.New("path must be absolute and normalized")
	}
	// Device namespaces and alternate streams bypass ordinary file semantics.
	if strings.HasPrefix(target, `\\?\`) || strings.HasPrefix(target, `\\.\`) || strings.HasPrefix(target, `\??\`) {
		return errors.New("device paths are unsupported")
	}
	volume := filepath.VolumeName(target)
	if volume == "" {
		return errors.New("missing path volume")
	}
	for _, part := range strings.Split(strings.TrimPrefix(target, volume), `\`) {
		if part == "" {
			continue
		}
		if strings.ContainsAny(part, `:<>"|?*`) || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return errors.New("invalid path component")
		}
		for _, char := range part {
			if char < 32 {
				return errors.New("invalid path character")
			}
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9') {
			return errors.New("reserved path component")
		}
	}
	return nil
}

// Validation accepts only ordinary normalized paths. Add the native prefix
// internally so long private runtime paths do not hit the legacy MAX_PATH cap.
func nativePath(target string) string {
	if strings.HasPrefix(target, `\\`) {
		return `\\?\UNC\` + strings.TrimPrefix(target, `\\`)
	}
	return `\\?\` + target
}

func openCheckedResource(target, kind string, access uint32) (syscall.Handle, error) {
	if kind != "file" && kind != "directory" {
		return 0, errors.New("unsupported resource kind")
	}
	name, err := syscall.UTF16PtrFromString(nativePath(target))
	if err != nil {
		return 0, err
	}
	handle, err := syscall.CreateFile(name, access, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return 0, err
	}
	var info syscall.ByHandleFileInformation
	err = syscall.GetFileInformationByHandle(handle, &info)
	if err == nil {
		var fileType uint32
		fileType, err = syscall.GetFileType(handle)
		if err == nil && fileType != syscall.FILE_TYPE_DISK {
			err = errors.New("resource is not a disk file or directory")
		}
	}
	if err == nil && (info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (info.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0) != (kind == "directory")) {
		err = errors.New("unsafe resource type or reparse point")
	}
	if err != nil {
		syscall.CloseHandle(handle)
		return 0, err
	}
	return handle, nil
}

func checkPath(target, kind string) error { return checkPathCached(target, kind, nil) }

func checkPathCached(target, kind string, checked map[string]string) error {
	if err := normalizedPath(target); err != nil {
		return err
	}
	if kind != "file" && kind != "directory" {
		return errors.New("unsupported resource kind")
	}
	var chain []string
	for current := target; ; current = filepath.Dir(current) {
		chain = append(chain, current)
		if parent := filepath.Dir(current); parent == current {
			break
		}
	}
	for i := len(chain) - 1; i >= 0; i-- {
		item, expected := chain[i], "directory"
		if i == 0 {
			expected = kind
		}
		if actual, found := checked[item]; found {
			if actual != expected {
				return errors.New("conflicting path types")
			}
			continue
		}
		handle, err := openCheckedResource(item, expected, 0)
		if err != nil {
			return err
		}
		syscall.CloseHandle(handle)
		if checked != nil {
			checked[item] = expected
		}
	}
	return nil
}

func checkTree(target string) error {
	if err := checkPath(target, "directory"); err != nil {
		return err
	}
	pending := []string{target}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		// Check before enumeration, then every child before placing directories on
		// the work list. Never recurse through an unchecked reparse point.
		if err := checkPath(current, "directory"); err != nil {
			return err
		}
		entries, err := os.ReadDir(current)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			child := filepath.Join(current, entry.Name())
			name, err := syscall.UTF16PtrFromString(nativePath(child))
			if err != nil {
				return err
			}
			attrs, err := syscall.GetFileAttributes(name)
			if err != nil {
				return err
			}
			kind := "file"
			if attrs&syscall.FILE_ATTRIBUTE_DIRECTORY != 0 {
				kind = "directory"
			}
			if err := checkPath(child, kind); err != nil {
				return err
			}
			if kind == "directory" {
				pending = append(pending, child)
			}
		}
	}
	return nil
}

func publishRoot(source, destination string) error {
	if err := checkPath(source, "directory"); err != nil {
		return err
	}
	if err := normalizedPath(destination); err != nil {
		return err
	}
	if err := checkPath(filepath.Dir(destination), "directory"); err != nil {
		return err
	}
	from, _ := syscall.UTF16PtrFromString(nativePath(source))
	to, _ := syscall.UTF16PtrFromString(nativePath(destination))
	// MoveFileW has no replace flag: files and directories already occupying the
	// destination both fail, including a concurrent publisher winning the race.
	return syscall.MoveFile(from, to)
}
