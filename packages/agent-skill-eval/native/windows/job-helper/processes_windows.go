package main

import (
	"errors"
	"syscall"
	"unsafe"
)

const processQueryLimitedInformation = 0x1000

type processRow struct {
	PID     uint32  `json:"pid"`
	PPID    uint32  `json:"ppid"`
	PGID    *uint32 `json:"pgid"`
	Started string  `json:"started"`
}

func processSnapshot() ([]processRow, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.CloseHandle(snapshot)
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	rows := make([]processRow, 0)
	err = syscall.Process32First(snapshot, &entry)
	for err == nil {
		if entry.ProcessID != 0 {
			rows = append(rows, processRow{PID: entry.ProcessID, PPID: entry.ParentProcessID})
		}
		err = syscall.Process32Next(snapshot, &entry)
	}
	if !errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
		return nil, err
	}
	return rows, nil
}

func openObservedProcess(pid, extraAccess uint32) (syscall.Handle, error) {
	handle, err := syscall.OpenProcess(processQueryLimitedInformation|syscall.SYNCHRONIZE|extraAccess, false, pid)
	// OpenProcess documents INVALID_PARAMETER for a nonexistent PID. Access
	// denied is not exit evidence, including protected processes in a snapshot.
	if errors.Is(err, syscall.Errno(87)) { // ERROR_INVALID_PARAMETER
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	exited, err := waitStatus(handle)
	if err != nil || exited {
		syscall.CloseHandle(handle)
		return 0, err
	}
	return handle, nil
}

func processCreation(handle syscall.Handle, cimPrecision bool) (string, error) {
	var creation, exit, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err != nil {
		return "", err
	}
	return filetimeTicks(creation.LowDateTime, creation.HighDateTime, cimPrecision)
}

func processOwner(handle syscall.Handle) (string, error) {
	var token syscall.Token
	if err := syscall.OpenProcessToken(handle, syscall.TOKEN_QUERY, &token); err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String()
}

func processTable(requiredPIDs []uint32) ([]processRow, error) {
	rows, err := processSnapshot()
	if err != nil {
		return nil, err
	}
	required := make(map[uint32]bool)
	for _, pid := range requiredPIDs {
		required[pid] = true
	}
	result := make([]processRow, 0, len(rows))
	for _, row := range rows {
		handle, err := openObservedProcess(row.PID, 0)
		if err != nil {
			if required[row.PID] {
				return nil, err
			}
			continue
		}
		if handle == 0 {
			delete(required, row.PID)
			continue
		}
		row.Started, err = processCreation(handle, true)
		exited, waitErr := waitStatus(handle)
		syscall.CloseHandle(handle)
		if err == nil {
			err = waitErr
		}
		if err != nil {
			if required[row.PID] {
				return nil, err
			}
			continue
		}
		delete(required, row.PID)
		if !exited {
			result = append(result, row)
		}
	}
	// A required process absent from the snapshot needs separate exit evidence;
	// a partial or racing snapshot must not turn a live process into "gone".
	for pid := range required {
		handle, err := openObservedProcess(pid, 0)
		if err != nil {
			return nil, err
		}
		if handle != 0 {
			syscall.CloseHandle(handle)
			return nil, errors.New("required process missing from snapshot")
		}
	}
	return result, nil
}

func processStart(pid uint32) (any, error) {
	handle, err := openObservedProcess(pid, 0)
	if err != nil || handle == 0 {
		return nil, err
	}
	defer syscall.CloseHandle(handle)
	started, err := processCreation(handle, false)
	if err != nil {
		return nil, err
	}
	exited, err := waitStatus(handle)
	if err != nil || exited {
		return nil, err
	}
	return started, nil
}

func processIdentity(pid uint32) (*processRow, error) {
	handle, err := openObservedProcess(pid, 0)
	if err != nil || handle == 0 {
		return nil, err
	}
	defer syscall.CloseHandle(handle)
	owner, err := processOwner(handle)
	if err != nil {
		return nil, err
	}
	if err := verifyCurrentSID(owner); err != nil {
		return nil, err
	}
	started, err := processCreation(handle, true)
	if err != nil {
		return nil, err
	}
	rows, err := processSnapshot()
	if err != nil {
		return nil, err
	}
	exited, err := waitStatus(handle)
	if err != nil || exited {
		return nil, err
	}
	for _, row := range rows {
		if row.PID == pid {
			row.Started = started
			return &row, nil
		}
	}
	return nil, errors.New("live process missing from snapshot")
}

func processStop(pid uint32, started, sid string) (bool, error) {
	if err := verifyCurrentSID(sid); err != nil {
		return false, err
	}
	handle, err := openObservedProcess(pid, syscall.PROCESS_TERMINATE)
	if err != nil || handle == 0 {
		return false, err
	}
	defer syscall.CloseHandle(handle)
	actual, err := processCreation(handle, true)
	if err != nil {
		return false, err
	}
	if actual != started {
		return false, nil
	}
	owner, err := processOwner(handle)
	if err != nil {
		return false, err
	}
	if owner != sid {
		return false, errors.New("process owner does not match")
	}
	// The retained handle binds both identity checks and termination to the
	// same kernel process object even if its numeric PID is subsequently reused.
	if err := syscall.TerminateProcess(handle, 1); err != nil {
		return false, err
	}
	status, err := syscall.WaitForSingleObject(handle, 5000)
	if err != nil {
		return false, err
	}
	if status != syscall.WAIT_OBJECT_0 {
		return false, errors.New("process termination did not complete")
	}
	return true, nil
}
