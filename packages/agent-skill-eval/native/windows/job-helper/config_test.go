package main

import (
	"encoding/base64"
	"testing"
)

func TestDecodeLaunchConfig(t *testing.T) {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(
		`{"schemaVersion":1,"executable":"C:\\Tools\\agent.exe","args":["a b","quote\"value"],"parentPid":42}`,
	))
	config, err := decodeLaunchConfig(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if config.Executable != `C:\Tools\agent.exe` || config.ParentPID != 42 {
		t.Fatalf("unexpected config: %#v", config)
	}
}

func TestDecodeLaunchConfigRejectsTrailingJSONValue(t *testing.T) {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(
		`{"schemaVersion":1,"executable":"agent.exe","args":[],"parentPid":42} {}`,
	))
	if _, err := decodeLaunchConfig(encoded); err == nil {
		t.Fatal("expected trailing JSON value to fail")
	}
}

func TestQuoteWindowsArgument(t *testing.T) {
	tests := map[string]string{
		"":            `""`,
		"plain":       `"plain"`,
		"two words":   `"two words"`,
		`C:\dir\`:     `"C:\dir\\"`,
		`say "hello"`: `"say \"hello\""`,
	}
	for input, expected := range tests {
		if actual := quoteWindowsArgument(input); actual != expected {
			t.Errorf("quoteWindowsArgument(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestBuildWindowsCommandLine(t *testing.T) {
	actual := buildWindowsCommandLine(`C:\Program Files\agent.exe`, []string{"", `tail\`})
	expected := `"C:\Program Files\agent.exe" "" "tail\\"`
	if actual != expected {
		t.Fatalf("command line = %q, want %q", actual, expected)
	}
}
