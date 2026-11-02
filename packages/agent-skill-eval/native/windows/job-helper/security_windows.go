package main

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	fileObject               = 1
	fileFullAccess           = 0x001f01ff
	readControl              = 0x00020000
	writeDAC                 = 0x00040000
	writeOwner               = 0x00080000
	ownerSecurityInformation = 1
	daclSecurityInformation  = 4
	protectedDACLInformation = 0x80000000
)

var (
	advapi32                         = syscall.NewLazyDLL("advapi32.dll")
	procGetSecurityInfo              = advapi32.NewProc("GetSecurityInfo")
	procSetSecurityInfo              = advapi32.NewProc("SetSecurityInfo")
	procGetSecurityDescriptorControl = advapi32.NewProc("GetSecurityDescriptorControl")
	procGetSecurityDescriptorOwner   = advapi32.NewProc("GetSecurityDescriptorOwner")
	procGetSecurityDescriptorDACL    = advapi32.NewProc("GetSecurityDescriptorDacl")
	procConvertSecurityDescriptor    = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	procIsValidACL                   = advapi32.NewProc("IsValidAcl")
	procIsValidSID                   = advapi32.NewProc("IsValidSid")
)

func currentUserSID() (string, error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String()
}

func verifyCurrentSID(sid string) error {
	current, err := currentUserSID()
	if err != nil {
		return err
	}
	if sid != current {
		return errors.New("resource user does not match current user")
	}
	return nil
}

func privateSecurityDescriptor(sid string, directory bool, fullMask uint32) (uintptr, error) {
	if err := verifyCurrentSID(sid); err != nil {
		return 0, err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	sddl, err := syscall.UTF16PtrFromString(fmt.Sprintf("O:%sD:P(A;%s;0x%08x;;;%s)", sid, flags, fullMask, sid))
	if err != nil {
		return 0, err
	}
	var descriptor uintptr
	ok, _, errno := procConvertSecurityDescriptor.Call(uintptr(unsafe.Pointer(sddl)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return 0, win32CallError("ConvertStringSecurityDescriptorToSecurityDescriptorW", errno)
	}
	return descriptor, nil
}

func objectSecurity(handle syscall.Handle, objectType uint32) (descriptor unsafe.Pointer, owner *syscall.SID, dacl unsafe.Pointer, err error) {
	code, _, _ := procGetSecurityInfo.Call(uintptr(handle), uintptr(objectType), ownerSecurityInformation|daclSecurityInformation,
		uintptr(unsafe.Pointer(&owner)), 0, uintptr(unsafe.Pointer(&dacl)), 0, uintptr(unsafe.Pointer(&descriptor)))
	if code != 0 {
		err = syscall.Errno(code)
	}
	return
}

func verifySID(owner *syscall.SID, sid string) error {
	if owner == nil {
		return errors.New("missing security identifier")
	}
	valid, _, _ := procIsValidSID.Call(uintptr(unsafe.Pointer(owner)))
	if valid == 0 {
		return errors.New("invalid security identifier")
	}
	actual, err := owner.String()
	if err != nil {
		return err
	}
	if actual != sid {
		return errors.New("foreign security identifier")
	}
	return nil
}

func verifyPrivateObject(handle syscall.Handle, objectType uint32, sid string, fullMask uint32) error {
	if err := verifyCurrentSID(sid); err != nil {
		return err
	}
	descriptor, owner, dacl, err := objectSecurity(handle, objectType)
	if err != nil {
		return err
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(descriptor)))
	if err := verifySID(owner, sid); err != nil {
		return err
	}
	var control uint16
	var revision uint32
	ok, _, errno := procGetSecurityDescriptorControl.Call(uintptr(descriptor), uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 {
		return win32CallError("GetSecurityDescriptorControl", errno)
	}
	if control&0x1004 != 0x1004 || dacl == nil {
		return errors.New("DACL must be present and protected")
	}
	valid, _, _ := procIsValidACL.Call(uintptr(dacl))
	if valid == 0 {
		return errors.New("invalid DACL")
	}
	// ACL is a bounded native byte structure. Parse every ACE, including types
	// that GetAccessRules can silently omit, and reject unknown access semantics.
	size := *(*uint16)(unsafe.Add(dacl, 2))
	if size < 8 {
		return errors.New("invalid DACL size")
	}
	return verifyACLBytes(unsafe.Slice((*byte)(dacl), int(size)), sid, fullMask, objectType == 6)
}

func verifyPrivateResource(target, kind, sid string) error {
	if err := checkPath(target, kind); err != nil {
		return err
	}
	handle, err := openCheckedResource(target, kind, readControl)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	if err := verifyPrivateObject(handle, fileObject, sid, fileFullAccess); err != nil {
		return err
	}
	return checkPath(target, kind)
}

func protectPrivateResource(target, kind, sid string) error {
	if err := verifyCurrentSID(sid); err != nil {
		return err
	}
	if err := checkPath(target, kind); err != nil {
		return err
	}
	handle, err := openCheckedResource(target, kind, readControl|writeDAC|writeOwner)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	// Callers initialize only resources they have just created exclusively.
	// Windows can give those resources the token's default group owner. Set the
	// user owner here, then require the private owner and DACL on readback.
	descriptor, err := privateSecurityDescriptor(sid, kind == "directory", fileFullAccess)
	if err != nil {
		return err
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	var owner *syscall.SID
	var dacl uintptr
	var defaulted, present uint32
	ok, _, errno := procGetSecurityDescriptorOwner.Call(descriptor, uintptr(unsafe.Pointer(&owner)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 {
		return win32CallError("GetSecurityDescriptorOwner", errno)
	}
	ok, _, errno = procGetSecurityDescriptorDACL.Call(descriptor, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || present == 0 || dacl == 0 {
		return win32CallError("GetSecurityDescriptorDacl", errno)
	}
	code, _, _ := procSetSecurityInfo.Call(uintptr(handle), fileObject, ownerSecurityInformation|daclSecurityInformation|protectedDACLInformation, uintptr(unsafe.Pointer(owner)), 0, dacl, 0)
	if code != 0 {
		return syscall.Errno(code)
	}
	if err := verifyPrivateObject(handle, fileObject, sid, fileFullAccess); err != nil {
		return err
	}
	return checkPath(target, kind)
}
