//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestPluginLaunchConfigBoundary(t *testing.T) {
	valid := pluginLaunchConfig{SchemaVersion: 1, Executable: `C:\tools\backend.exe`, Args: []string{"", `quote" and slash\`}, ParentPID: 42, Name: `Local\aw-subagent-0123456789abcdef0123456789abcdef`, Status: `C:\private\ready.json`, SID: "S-1-5-21-1"}
	data, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodePluginLaunchConfig(data)
	if err != nil || !reflect.DeepEqual(got, valid) {
		t.Fatalf("valid launch: %#v, %v", got, err)
	}
	cases := map[string][]byte{
		"unknown field":  bytes.Replace(data, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"extra":true`), 1),
		"unknown schema": bytes.Replace(data, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":2`), 1),
		"null argument":  []byte(`{"schemaVersion":1,"executable":"backend.exe","args":[null],"parentPid":42,"name":"Local\\aw-subagent-0123456789abcdef0123456789abcdef","status":"C:\\private\\ready.json","sid":"S-1-5-21-1"}`),
		"trailing JSON":  append(append([]byte{}, data...), []byte(` {}`)...),
		"invalid UTF-8":  append(append([]byte{}, data...), 0xff),
		"oversized":      []byte(strings.Repeat(" ", operationInputLimit+1)),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := decodePluginLaunchConfig(input); err == nil {
				t.Fatal("unsafe launch accepted")
			}
		})
	}
	mutations := map[string]func(*pluginLaunchConfig){
		"null args":      func(c *pluginLaunchConfig) { c.Args = nil },
		"NUL argument":   func(c *pluginLaunchConfig) { c.Args = []string{"a\x00b"} },
		"empty command":  func(c *pluginLaunchConfig) { c.Executable = "" },
		"missing parent": func(c *pluginLaunchConfig) { c.ParentPID = 0 },
		"foreign name":   func(c *pluginLaunchConfig) { c.Name = `Global\aw-subagent-0123456789abcdef0123456789abcdef` },
		"bad name":       func(c *pluginLaunchConfig) { c.Name = `Local\aw-subagent-0123456789abcdef0123456789abcdeF` },
		"missing SID":    func(c *pluginLaunchConfig) { c.SID = "" },
		"relative ready": func(c *pluginLaunchConfig) { c.Status = `ready.json` },
		"device ready":   func(c *pluginLaunchConfig) { c.Status = `C:\private\NUL.json` },
		"ready stream":   func(c *pluginLaunchConfig) { c.Status = `C:\private\ready.json:stream` },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			input := valid
			mutate(&input)
			data, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := decodePluginLaunchConfig(data); err == nil {
				t.Fatal("unsafe launch accepted")
			}
		})
	}
}

func TestPluginJobProcessListBoundary(t *testing.T) {
	// Win32 layout: assigned count, returned count, then ULONG_PTR PIDs.
	data := []byte{2, 0, 0, 0, 2, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0, 0x92, 0x10, 0, 0, 0, 0, 0, 0}
	pids, err := decodePluginJobPIDs(data, 8)
	if err != nil || !reflect.DeepEqual(pids, []uint32{42, 4242}) {
		t.Fatalf("process list: %v, %v", pids, err)
	}
	empty, err := decodePluginJobPIDs(make([]byte, 8), 8)
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty process list must encode as []: %v, %v", empty, err)
	}
	cases := map[string][]byte{
		"short header": {0, 0, 0, 0},
		"missing PID":  {1, 0, 0, 0, 1, 0, 0, 0},
		"partial list": {2, 0, 0, 0, 1, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0},
		"zero PID":     {1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
		"PID overflow": {1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0},
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := decodePluginJobPIDs(input, 8); err == nil {
				t.Fatal("incomplete or invalid observation accepted")
			}
		})
	}
}
