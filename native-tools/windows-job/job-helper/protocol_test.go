package main

import (
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestOperationEnvelope(t *testing.T) {
	request, err := decodeOperation(strings.NewReader(`{"schemaVersion":1,"operation":"processStart","input":{"pid":42}}`))
	if err != nil || request.Operation != "processStart" {
		t.Fatalf("valid request: %v, %v", request, err)
	}
	for _, input := range []string{
		`{"schemaVersion":2,"operation":"processStart","input":{"pid":42}}`,
		`{"schemaVersion":1,"operation":"shell","input":{"script":"exit"}}`,
		`{"schemaVersion":1,"operation":"processStart","input":null}`,
		`{"schemaVersion":1,"operation":"processStart","input":[]}`,
		`{"schemaVersion":1,"operation":"processStart","input":{},"script":"exit"}`,
		`{"schemaVersion":1,"operation":"processStart","input":{}} {}`,
		"{\"schemaVersion\":1,\"operation\":\"processStart\",\"input\":{\"pid\":\"\xff\"}}",
		strings.Repeat(" ", operationInputLimit+1),
	} {
		if _, err := decodeOperation(strings.NewReader(input)); err == nil {
			t.Errorf("accepted unsafe envelope %.150q", input)
		}
	}
	result, err := encodeOperationResult(nil)
	if err != nil || string(result) != "{\"schemaVersion\":1,\"result\":null}\n" {
		t.Fatalf("null response = %s, %v", result, err)
	}
	if _, err := encodeOperationResult(strings.Repeat("x", operationOutputLimit)); err == nil {
		t.Fatal("accepted oversized response")
	}
}

func TestStrictOperationInput(t *testing.T) {
	var value struct {
		PID uint32 `json:"pid"`
	}
	for _, input := range []string{`{"pid":-1}`, `{"pid":1.5}`, `{"pid":4294967296}`, `{"pid":1,"command":"bad"}`, `{"pid":1} null`} {
		if err := decodeStrictJSON([]byte(input), &value); err == nil {
			t.Errorf("accepted %s", input)
		}
	}
	var output any
	encoded, err := encodeOperationResult([]int{12, 34})
	if err != nil || json.Unmarshal(encoded, &output) != nil {
		t.Fatal("response is not one valid JSON value")
	}
}

func TestCreationTimeCompatibility(t *testing.T) {
	// Known FILETIME fixtures: Unix epoch and 2024-01-01 UTC + 1234567 ticks.
	cases := []struct {
		filetime   uint64
		exact, cim string
	}{
		{0, "504911232000000000", "504911232000000000"},
		{116444736000000000, "621355968000000000", "621355968000000000"},
		{133485408001234567, "638396640001234567", "638396640001234560"},
	}
	for _, test := range cases {
		for _, cim := range []bool{false, true} {
			expected := test.exact
			if cim {
				expected = test.cim
			}
			value, err := filetimeTicks(uint32(test.filetime), uint32(test.filetime>>32), cim)
			if err != nil || value != expected {
				t.Fatalf("FILETIME %d cim=%v: %s (%v), want %s", test.filetime, cim, value, err, expected)
			}
		}
	}
	if _, err := filetimeTicks(0xffffffff, 0xffffffff, false); err == nil {
		t.Fatal("accepted overflowing FILETIME")
	}
	for _, value := range []string{"", "0", "01", "1.2", "-1", "instance:token", "18446744073709551616"} {
		if validStarted(value) {
			t.Errorf("accepted invalid identity %q", value)
		}
	}
}

func TestPrivateACLRejectsUnsafeAccess(t *testing.T) {
	// ACL revision 2; one explicit FullControl allow ACE for S-1-5-21-42.
	// Bytes follow the documented ACL / ACCESS_ALLOWED_ACE / SID layouts.
	base, err := hex.DecodeString("020020000100000000001800ff011f000102000000000005150000002a000000")
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyACLBytes(base, "S-1-5-21-42", 0x001f01ff, false); err != nil {
		t.Fatalf("ordinary private ACL: %v", err)
	}
	tests := []struct {
		name   string
		mutate func([]byte) []byte
	}{
		{"null", func(b []byte) []byte { return nil }},
		{"empty", func(b []byte) []byte { b[2] = 8; b[4] = 0; return b[:8] }},
		{"deny", func(b []byte) []byte { b[8] = 1; return b }},
		{"unsupported object ACE", func(b []byte) []byte { b[8] = 5; return b }},
		{"unsupported callback ACE", func(b []byte) []byte { b[8] = 9; return b }},
		{"inherited", func(b []byte) []byte { b[9] = 0x10; return b }},
		{"inherit only", func(b []byte) []byte { b[9] = 0x08; return b }},
		{"foreign", func(b []byte) []byte { b[28] = 43; return b }},
		{"partial access", func(b []byte) []byte { b[12] = 1; return b }},
		{"truncated SID", func(b []byte) []byte { b[17] = 3; return b }},
		{"oversized ACE", func(b []byte) []byte { b[10] = 255; return b }},
		{"truncated ACE count", func(b []byte) []byte { b[4] = 2; return b }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := test.mutate(append([]byte(nil), base...))
			if err := verifyACLBytes(data, "S-1-5-21-42", 0x001f01ff, false); err == nil {
				t.Fatal("unsafe ACL accepted")
			}
		})
	}
	directory := append([]byte(nil), base...)
	directory[9] = 3
	if err := verifyACLBytes(directory, "S-1-5-21-42", 0x001f01ff, false); err != nil {
		t.Fatalf("directory OI/CI: %v", err)
	}
	job := append([]byte(nil), base...)
	copy(job[12:16], []byte{0x3f, 0, 0x1f, 0})
	if err := verifyACLBytes(job, "S-1-5-21-42", 0x10000000, true); err != nil {
		t.Fatalf("mapped Job full access: %v", err)
	}
}
