package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Fresh Node/Go resources use the token's default owner. ACL protection must
// work on those resources before the private owner and DACL can be verified.
func TestProtectFreshPrivateResource(t *testing.T) {
	sid, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"directory", "file"} {
		t.Run(kind, func(t *testing.T) {
			target := t.TempDir()
			if kind == "file" {
				target = filepath.Join(target, "private.json")
				if err := os.WriteFile(target, []byte("{}"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			handle, err := openCheckedResource(target, kind, readControl)
			if err != nil {
				t.Fatalf("read fresh resource: %v", err)
			}
			descriptor, owner, _, err := objectSecurity(handle, fileObject)
			syscall.CloseHandle(handle)
			if err != nil {
				t.Fatalf("read fresh resource security: %v", err)
			}
			actual, err := owner.String()
			syscall.LocalFree(syscall.Handle(uintptr(descriptor)))
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("fresh owner matches user: %t; is Administrators: %t", actual == sid, actual == "S-1-5-32-544")
			if err := protectPrivateResource(target, kind, sid); err != nil {
				t.Fatalf("protect fresh resource: %v", err)
			}
			if err := verifyPrivateResource(target, kind, sid); err != nil {
				t.Fatalf("verify protected resource: %v", err)
			}
		})
	}
}
