package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	pluginJobObjectType      = 6
	pluginJobGenericAll      = 0x10000000
	pluginJobQuery           = 4
	pluginJobTerminate       = 8
	pluginJobProcessListInfo = 3
	pluginJobProcessLimit    = 1 << 19
	pluginDeleteAccess       = 0x00010000
	pluginFileDisposition    = 4
)

var (
	procOpenPluginJobObject      = kernel32.NewProc("OpenJobObjectW")
	procPluginSetFileInformation = kernel32.NewProc("SetFileInformationByHandle")
)

type pluginLaunchConfig struct {
	SchemaVersion int             `json:"schemaVersion"`
	Executable    string          `json:"executable"`
	Args          pluginArguments `json:"args"`
	ParentPID     uint32          `json:"parentPid"`
	Name          string          `json:"name"`
	Status        string          `json:"status"`
	SID           string          `json:"sid"`
}

type pluginArguments []string

func (args *pluginArguments) UnmarshalJSON(data []byte) error {
	var values []json.RawMessage
	if err := json.Unmarshal(data, &values); err != nil {
		return err
	}
	if values == nil {
		return errors.New("plugin arguments must be an array")
	}
	parsed := make(pluginArguments, 0, len(values))
	for _, value := range values {
		// encoding/json otherwise accepts null as an empty string.
		if len(value) == 0 || value[0] != '"' {
			return errors.New("plugin argument must be a string")
		}
		var arg string
		if err := json.Unmarshal(value, &arg); err != nil {
			return err
		}
		parsed = append(parsed, arg)
	}
	*args = parsed
	return nil
}

func validPluginJobName(name string) bool {
	const prefix = `Local\aw-subagent-`
	if !strings.HasPrefix(name, prefix) || len(name) != len(prefix)+32 {
		return false
	}
	for _, char := range name[len(prefix):] {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func decodePluginLaunchConfig(data []byte) (pluginLaunchConfig, error) {
	var config pluginLaunchConfig
	if len(data) > operationInputLimit {
		return config, errors.New("plugin config too large")
	}
	if err := decodeStrictJSON(data, &config); err != nil {
		return config, fmt.Errorf("parse plugin config: %w", err)
	}
	if config.SchemaVersion != configSchemaVersion || config.ParentPID == 0 || config.Args == nil {
		return config, errors.New("invalid plugin config schema or launch fields")
	}
	if config.Executable == "" || strings.ContainsRune(config.Executable, 0) {
		return config, errors.New("invalid plugin executable")
	}
	for _, arg := range config.Args {
		if strings.ContainsRune(arg, 0) {
			return config, errors.New("plugin argument contains NUL")
		}
	}
	if !validPluginJobName(config.Name) || config.SID == "" || strings.ContainsRune(config.SID, 0) {
		return config, errors.New("invalid plugin job identity")
	}
	if err := normalizedPath(config.Status); err != nil {
		return config, fmt.Errorf("invalid plugin ready path: %w", err)
	}
	return config, nil
}

func deletePluginFileHandle(handle syscall.Handle) error {
	remove := uint32(1)
	ok, _, errno := procPluginSetFileInformation.Call(uintptr(handle), pluginFileDisposition, uintptr(unsafe.Pointer(&remove)), unsafe.Sizeof(remove))
	if ok == 0 {
		return win32CallError("SetFileInformationByHandle", errno)
	}
	return nil
}

func loadPluginLaunchConfig(target, sid string) (pluginLaunchConfig, error) {
	var config pluginLaunchConfig
	if err := checkPath(target, "file"); err != nil {
		return config, err
	}
	handle, err := openCheckedResource(target, "file", syscall.GENERIC_READ|readControl|pluginDeleteAccess)
	if err != nil {
		return config, err
	}
	file := os.NewFile(uintptr(handle), "plugin launch config")
	defer file.Close()
	if err := verifyPrivateObject(handle, fileObject, sid, fileFullAccess); err != nil {
		return config, err
	}
	data, err := io.ReadAll(io.LimitReader(file, operationInputLimit+1))
	if err != nil {
		return config, err
	}
	// Delete the verified file through its open handle. A replacement at the
	// original path must not be removed in its place.
	if err := deletePluginFileHandle(handle); err != nil {
		return config, err
	}
	if err := file.Close(); err != nil {
		return config, err
	}
	config, err = decodePluginLaunchConfig(data)
	if err == nil && config.SID != sid {
		err = errors.New("plugin config user does not match current user")
	}
	return config, err
}

func createPrivatePluginJob(name, sid string) (syscall.Handle, error) {
	descriptor, err := privateSecurityDescriptor(sid, false, pluginJobGenericAll)
	if err != nil {
		return 0, err
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	attributes := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: descriptor}
	jobName, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	value, _, errno := procCreateJobObject.Call(uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(jobName)))
	if value == 0 {
		return 0, win32CallError("CreateJobObjectW", errno)
	}
	job := syscall.Handle(value)
	// Never change or terminate an existing object, even when its owner matches.
	if errno == syscall.ERROR_ALREADY_EXISTS {
		syscall.CloseHandle(job)
		return 0, errors.New("plugin job name is already in use")
	}
	if err := verifyPrivateObject(job, pluginJobObjectType, sid, pluginJobGenericAll); err != nil {
		syscall.CloseHandle(job)
		return 0, err
	}
	limits := jobObjectExtendedLimitInformation{}
	limits.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ok, _, errno := procSetInformationJobObject.Call(uintptr(job), jobObjectExtendedLimitInfo, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		syscall.CloseHandle(job)
		return 0, win32CallError("SetInformationJobObject", errno)
	}
	return job, nil
}

func writePluginJobReady(target, sid string, pid uint32) (err error) {
	if err := normalizedPath(target); err != nil {
		return err
	}
	parent := filepath.Dir(target)
	if err := verifyPrivateResource(parent, "directory", sid); err != nil {
		return err
	}
	descriptor, err := privateSecurityDescriptor(sid, false, fileFullAccess)
	if err != nil {
		return err
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	attributes := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: descriptor}
	name, err := syscall.UTF16PtrFromString(nativePath(target))
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_WRITE|readControl|pluginDeleteAccess, syscall.FILE_SHARE_READ, &attributes, syscall.CREATE_NEW, syscall.FILE_ATTRIBUTE_NORMAL|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(handle), "plugin job ready")
	defer func() {
		if err != nil {
			err = errors.Join(err, deletePluginFileHandle(handle))
		}
		err = errors.Join(err, file.Close())
	}()
	if err := verifyPrivateObject(handle, fileObject, sid, fileFullAccess); err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		Ready bool   `json:"ready"`
		PID   uint32 `json:"pid"`
	}{true, pid})
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := checkPath(target, "file"); err != nil {
		return err
	}
	if err := verifyPrivateResource(parent, "directory", sid); err != nil {
		return err
	}
	return verifyPrivateObject(handle, fileObject, sid, fileFullAccess)
}

func runPluginJob(configPath string) (exitCode uint32, err error) {
	exitCode = helperContainmentFailureExitCode
	sid, err := currentUserSID()
	if err != nil {
		return exitCode, err
	}
	config, err := loadPluginLaunchConfig(configPath, sid)
	if err != nil {
		return exitCode, err
	}
	parent, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, config.ParentPID)
	if err != nil {
		return exitCode, fmt.Errorf("open plugin parent: %w", err)
	}
	defer syscall.CloseHandle(parent)
	parentExited, err := waitStatus(parent)
	if err != nil {
		return exitCode, err
	}
	if parentExited {
		return helperParentExitedExitCode, errors.New("plugin parent exited before launch")
	}
	job, err := createPrivatePluginJob(config.Name, sid)
	if err != nil {
		return exitCode, err
	}
	defer syscall.CloseHandle(job)
	child, err := createSuspendedProcess(launchConfig{SchemaVersion: config.SchemaVersion, Executable: config.Executable, Args: config.Args, ParentPID: config.ParentPID})
	if err != nil {
		return exitCode, err
	}
	defer syscall.CloseHandle(child.Process)
	defer syscall.CloseHandle(child.Thread)
	assigned := false
	cleanupCode := uint32(helperContainmentFailureExitCode)
	defer func() {
		if !assigned {
			cleanupErr := syscall.TerminateProcess(child.Process, helperContainmentFailureExitCode)
			status, waitErr := syscall.WaitForSingleObject(child.Process, uint32(jobCleanupTimeout/time.Millisecond))
			if waitErr == nil && status != syscall.WAIT_OBJECT_0 {
				waitErr = errors.New("suspended plugin child cleanup timed out")
			}
			if cleanupErr = errors.Join(cleanupErr, waitErr); cleanupErr != nil {
				err = errors.Join(err, cleanupErr)
				exitCode = helperContainmentFailureExitCode
			}
		}
		if cleanupErr := terminateAndWaitForEmptyJob(job, cleanupCode); cleanupErr != nil {
			err = errors.Join(err, cleanupErr)
			exitCode = helperContainmentFailureExitCode
		}
	}()
	if err := assignProcess(job, child.Process); err != nil {
		return helperContainmentFailureExitCode, err
	}
	assigned = true
	if err := writePluginJobReady(config.Status, sid, child.ProcessId); err != nil {
		return helperContainmentFailureExitCode, err
	}
	parentExited, err = waitStatus(parent)
	if err != nil {
		return helperContainmentFailureExitCode, err
	}
	if parentExited {
		cleanupCode = helperParentExitedExitCode
		return helperParentExitedExitCode, errors.New("plugin parent exited before resume")
	}
	if err := resumeProcess(child.Thread); err != nil {
		return helperContainmentFailureExitCode, err
	}
	for {
		rootExited, err := waitStatus(child.Process)
		if err != nil {
			return helperContainmentFailureExitCode, err
		}
		if rootExited {
			var code uint32
			if err := syscall.GetExitCodeProcess(child.Process, &code); err != nil {
				return helperContainmentFailureExitCode, err
			}
			return code, nil
		}
		parentExited, err := waitStatus(parent)
		if err != nil {
			return helperContainmentFailureExitCode, err
		}
		if parentExited {
			cleanupCode = helperParentExitedExitCode
			return helperParentExitedExitCode, errors.New("plugin parent exited before root")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func decodePluginJobPIDs(data []byte, pointerSize int) ([]uint32, error) {
	if len(data) < 8 || (pointerSize != 4 && pointerSize != 8) {
		return nil, errors.New("invalid job process list")
	}
	assigned := binary.LittleEndian.Uint32(data)
	count := binary.LittleEndian.Uint32(data[4:])
	if assigned != count || uint64(count) > uint64((len(data)-8)/pointerSize) || count > pluginJobProcessLimit {
		return nil, errors.New("incomplete job process list")
	}
	pids := make([]uint32, 0, count)
	for i := 0; i < int(count); i++ {
		entry := data[8+i*pointerSize:]
		pid := uint64(binary.LittleEndian.Uint32(entry))
		if pointerSize == 8 {
			pid = binary.LittleEndian.Uint64(entry)
		}
		if pid == 0 || pid > uint64(^uint32(0)) {
			return nil, errors.New("invalid job process identifier")
		}
		pids = append(pids, uint32(pid))
	}
	return pids, nil
}

func pluginJobMembers(job syscall.Handle) ([]uint32, error) {
	const attempts = 8
	capacity := 128
	pointerSize := int(unsafe.Sizeof(uintptr(0)))
	for attempt := 0; attempt < attempts; attempt++ {
		data := make([]byte, 8+capacity*pointerSize)
		ok, _, errno := procQueryInformationJobObject.Call(uintptr(job), pluginJobProcessListInfo, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 0)
		if ok == 0 && errno != syscall.ERROR_MORE_DATA {
			return nil, win32CallError("QueryInformationJobObject", errno)
		}
		assigned := binary.LittleEndian.Uint32(data)
		count := binary.LittleEndian.Uint32(data[4:])
		if ok != 0 && assigned == count {
			return decodePluginJobPIDs(data, pointerSize)
		}
		next := capacity * 4
		if uint64(assigned) > uint64(next) {
			next = int(assigned)
		}
		if next > pluginJobProcessLimit {
			return nil, errors.New("job process list exceeds observation limit")
		}
		capacity = next
	}
	return nil, errors.New("job process list changed during observation")
}

func pluginJobOperation(operation string, input json.RawMessage) (any, error) {
	if operation != "jobObserve" && operation != "jobStop" {
		return nil, errors.New("unsupported plugin job operation")
	}
	var scope struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
		SID  string `json:"sid"`
	}
	if err := decodeStrictJSON(input, &scope); err != nil {
		return nil, err
	}
	if scope.Kind != "windows-job" || !validPluginJobName(scope.Name) {
		return nil, errors.New("invalid plugin job scope")
	}
	if err := verifyCurrentSID(scope.SID); err != nil {
		return nil, err
	}
	access := uint32(pluginJobQuery | readControl)
	if operation == "jobStop" {
		access |= pluginJobTerminate
	}
	name, err := syscall.UTF16PtrFromString(scope.Name)
	if err != nil {
		return nil, err
	}
	value, _, errno := procOpenPluginJobObject.Call(uintptr(access), 0, uintptr(unsafe.Pointer(name)))
	if value == 0 {
		if errno == syscall.ERROR_FILE_NOT_FOUND {
			return []uint32{}, nil
		}
		return nil, win32CallError("OpenJobObjectW", errno)
	}
	job := syscall.Handle(value)
	defer syscall.CloseHandle(job)
	if err := verifyPrivateObject(job, pluginJobObjectType, scope.SID, pluginJobGenericAll); err != nil {
		return nil, err
	}
	if operation == "jobStop" {
		if err := terminateAndWaitForEmptyJob(job, helperContainmentFailureExitCode); err != nil {
			return nil, err
		}
		return []uint32{}, nil
	}
	return pluginJobMembers(job)
}
