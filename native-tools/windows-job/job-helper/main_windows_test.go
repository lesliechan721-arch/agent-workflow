package main

import "testing"

func TestResumeProcessRejectsInvalidThreadHandle(t *testing.T) {
	// ResumeThread reports failure as a DWORD, including on 64-bit Windows.
	// Exercise the real API so a widened sentinel cannot hide launch failure.
	if err := resumeProcess(0); err == nil {
		t.Fatal("invalid thread handle did not report resume failure")
	}
}
