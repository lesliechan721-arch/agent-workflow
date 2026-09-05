package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	createSuspended                  = 0x00000004
	jobObjectExtendedLimitInfo       = 9
	jobObjectBasicAccountingInfo     = 1
	jobObjectLimitKillOnJobClose     = 0x00002000
	helperContainmentFailureExitCode = 250
	helperParentExitedExitCode       = 251
	jobCleanupTimeout                = 5 * time.Second
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type jobObjectBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

var (
	kernel32                      = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObject           = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject   = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject  = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject        = kernel32.NewProc("TerminateJobObject")
	procQueryInformationJobObject = kernel32.NewProc("QueryInformationJobObject")
	procResumeThread              = kernel32.NewProc("ResumeThread")
)

func win32CallError(name string, errno error) error {
	if errno == syscall.Errno(0) {
		return fmt.Errorf("%s failed", name)
	}
	return fmt.Errorf("%s failed: %w", name, errno)
}

func createKillOnCloseJob() (syscall.Handle, error) {
	value, _, errno := procCreateJobObject.Call(0, 0)
	if value == 0 {
		return 0, win32CallError("CreateJobObjectW", errno)
	}
	job := syscall.Handle(value)
	limits := jobObjectExtendedLimitInformation{}
	limits.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ok, _, errno := procSetInformationJobObject.Call(
		uintptr(job),
		jobObjectExtendedLimitInfo,
		uintptr(unsafe.Pointer(&limits)),
		unsafe.Sizeof(limits),
	)
	if ok == 0 {
		syscall.CloseHandle(job)
		return 0, win32CallError("SetInformationJobObject", errno)
	}
	return job, nil
}

func duplicateStandardHandle(kind int) (syscall.Handle, error) {
	source, err := syscall.GetStdHandle(kind)
	if err != nil {
		return 0, err
	}
	if source == 0 || source == syscall.InvalidHandle {
		return 0, errors.New("standard handle is unavailable")
	}
	current, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0, err
	}
	var duplicate syscall.Handle
	if err := syscall.DuplicateHandle(
		current,
		source,
		current,
		&duplicate,
		0,
		true,
		syscall.DUPLICATE_SAME_ACCESS,
	); err != nil {
		return 0, err
	}
	if err := syscall.SetHandleInformation(source, syscall.HANDLE_FLAG_INHERIT, 0); err != nil {
		syscall.CloseHandle(duplicate)
		return 0, err
	}
	return duplicate, nil
}

func createSuspendedProcess(config launchConfig) (syscall.ProcessInformation, error) {
	var process syscall.ProcessInformation
	executable, err := exec.LookPath(config.Executable)
	if err != nil {
		return process, fmt.Errorf("resolve executable: %w", err)
	}
	extension := strings.ToLower(filepath.Ext(executable))
	if extension == ".cmd" || extension == ".bat" {
		return process, fmt.Errorf("unsupported Windows script executable %q; .cmd and .bat require an explicit .exe launcher", executable)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return process, fmt.Errorf("resolve executable path: %w", err)
	}
	executablePointer, err := syscall.UTF16PtrFromString(executable)
	if err != nil {
		return process, fmt.Errorf("encode executable: %w", err)
	}
	commandLine, err := syscall.UTF16FromString(buildWindowsCommandLine(executable, config.Args))
	if err != nil {
		return process, fmt.Errorf("encode command line: %w", err)
	}

	stdin, err := duplicateStandardHandle(syscall.STD_INPUT_HANDLE)
	if err != nil {
		return process, fmt.Errorf("duplicate stdin: %w", err)
	}
	defer syscall.CloseHandle(stdin)
	stdout, err := duplicateStandardHandle(syscall.STD_OUTPUT_HANDLE)
	if err != nil {
		return process, fmt.Errorf("duplicate stdout: %w", err)
	}
	defer syscall.CloseHandle(stdout)
	stderr, err := duplicateStandardHandle(syscall.STD_ERROR_HANDLE)
	if err != nil {
		return process, fmt.Errorf("duplicate stderr: %w", err)
	}
	defer syscall.CloseHandle(stderr)

	startup := syscall.StartupInfo{
		Cb:        uint32(unsafe.Sizeof(syscall.StartupInfo{})),
		Flags:     syscall.STARTF_USESTDHANDLES,
		StdInput:  stdin,
		StdOutput: stdout,
		StdErr:    stderr,
	}
	if err := syscall.CreateProcess(
		executablePointer,
		&commandLine[0],
		nil,
		nil,
		true,
		createSuspended,
		nil,
		nil,
		&startup,
		&process,
	); err != nil {
		return process, fmt.Errorf("CreateProcessW: %w", err)
	}
	return process, nil
}

func assignProcess(job syscall.Handle, process syscall.Handle) error {
	ok, _, errno := procAssignProcessToJobObject.Call(uintptr(job), uintptr(process))
	if ok == 0 {
		return win32CallError("AssignProcessToJobObject", errno)
	}
	return nil
}

func resumeProcess(thread syscall.Handle) error {
	value, _, errno := procResumeThread.Call(uintptr(thread))
	if value == ^uintptr(0) {
		return win32CallError("ResumeThread", errno)
	}
	return nil
}

func terminateJob(job syscall.Handle, exitCode uint32) error {
	ok, _, errno := procTerminateJobObject.Call(uintptr(job), uintptr(exitCode))
	if ok == 0 {
		return win32CallError("TerminateJobObject", errno)
	}
	return nil
}

func activeJobProcesses(job syscall.Handle) (uint32, error) {
	accounting := jobObjectBasicAccountingInformation{}
	ok, _, errno := procQueryInformationJobObject.Call(
		uintptr(job),
		jobObjectBasicAccountingInfo,
		uintptr(unsafe.Pointer(&accounting)),
		unsafe.Sizeof(accounting),
		0,
	)
	if ok == 0 {
		return 0, win32CallError("QueryInformationJobObject", errno)
	}
	return accounting.ActiveProcesses, nil
}

func terminateAndWaitForEmptyJob(job syscall.Handle, exitCode uint32) error {
	if err := terminateJob(job, exitCode); err != nil {
		return err
	}
	deadline := time.Now().Add(jobCleanupTimeout)
	for {
		active, err := activeJobProcesses(job)
		if err != nil {
			return err
		}
		if active == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("job cleanup timed out with %d active processes", active)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitStatus(handle syscall.Handle) (bool, error) {
	status, err := syscall.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	return status == syscall.WAIT_OBJECT_0, nil
}

func run(config launchConfig) (uint32, error) {
	parent, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, config.ParentPID)
	if err != nil {
		return helperContainmentFailureExitCode, fmt.Errorf("open parent process: %w", err)
	}
	defer syscall.CloseHandle(parent)
	job, err := createKillOnCloseJob()
	if err != nil {
		return helperContainmentFailureExitCode, err
	}
	defer syscall.CloseHandle(job)
	child, err := createSuspendedProcess(config)
	if err != nil {
		return helperContainmentFailureExitCode, err
	}
	defer syscall.CloseHandle(child.Process)
	defer syscall.CloseHandle(child.Thread)
	if err := assignProcess(job, child.Process); err != nil {
		_ = syscall.TerminateProcess(child.Process, helperContainmentFailureExitCode)
		_, _ = syscall.WaitForSingleObject(child.Process, syscall.INFINITE)
		return helperContainmentFailureExitCode, err
	}
	if err := resumeProcess(child.Thread); err != nil {
		_ = terminateAndWaitForEmptyJob(job, helperContainmentFailureExitCode)
		return helperContainmentFailureExitCode, err
	}

	for {
		rootExited, err := waitStatus(child.Process)
		if err != nil {
			_ = terminateAndWaitForEmptyJob(job, helperContainmentFailureExitCode)
			return helperContainmentFailureExitCode, fmt.Errorf("wait for root process: %w", err)
		}
		if rootExited {
			var exitCode uint32
			if err := syscall.GetExitCodeProcess(child.Process, &exitCode); err != nil {
				_ = terminateAndWaitForEmptyJob(job, helperContainmentFailureExitCode)
				return helperContainmentFailureExitCode, fmt.Errorf("read root exit code: %w", err)
			}
			if err := terminateAndWaitForEmptyJob(job, helperContainmentFailureExitCode); err != nil {
				return helperContainmentFailureExitCode, err
			}
			return exitCode, nil
		}
		parentExited, err := waitStatus(parent)
		if err != nil {
			_ = terminateAndWaitForEmptyJob(job, helperContainmentFailureExitCode)
			return helperContainmentFailureExitCode, fmt.Errorf("wait for parent process: %w", err)
		}
		if parentExited {
			if err := terminateAndWaitForEmptyJob(job, helperParentExitedExitCode); err != nil {
				return helperContainmentFailureExitCode, err
			}
			return helperParentExitedExitCode, errors.New("parent process exited before the root process")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func main() {
	if len(os.Args) != 3 || os.Args[1] != "--config" {
		fmt.Fprintln(os.Stderr, "aw-windows-job: expected --config <base64url-json>")
		syscall.ExitProcess(helperContainmentFailureExitCode)
	}
	config, err := decodeLaunchConfig(os.Args[2])
	if err != nil {
		fmt.Fprintf(os.Stderr, "aw-windows-job: %v\n", err)
		syscall.ExitProcess(helperContainmentFailureExitCode)
	}
	exitCode, err := run(config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "aw-windows-job: %v\n", err)
	}
	syscall.ExitProcess(exitCode)
}
