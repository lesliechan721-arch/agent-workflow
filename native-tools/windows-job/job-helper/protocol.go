package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"unicode/utf8"
)

const operationInputLimit = 256 * 1024
const operationOutputLimit = 8 * 1024 * 1024

type operationRequest struct {
	SchemaVersion int             `json:"schemaVersion"`
	Operation     string          `json:"operation"`
	Input         json.RawMessage `json:"input"`
}

func decodeStrictJSON(data []byte, value any) error {
	if !utf8.Valid(data) {
		return errors.New("invalid UTF-8 input")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON value")
	}
	return nil
}

func decodeOperation(reader io.Reader) (operationRequest, error) {
	var request operationRequest
	data, err := io.ReadAll(io.LimitReader(reader, operationInputLimit+1))
	if err != nil {
		return request, err
	}
	if len(data) > operationInputLimit {
		return request, errors.New("operation input too large")
	}
	if err := decodeStrictJSON(data, &request); err != nil {
		return request, err
	}
	if request.SchemaVersion != 1 {
		return request, errors.New("unsupported operation schema")
	}
	switch request.Operation {
	case "pathCheck", "pathTree", "aclVerify", "aclProtect", "rootPublish", "processTable", "processIdentity", "processStart", "processStop", "jobObserve", "jobStop":
	default:
		return request, errors.New("unsupported operation")
	}
	input := bytes.TrimSpace(request.Input)
	if len(input) < 2 || input[0] != '{' || input[len(input)-1] != '}' {
		return request, errors.New("operation input must be an object")
	}
	return request, nil
}

func encodeOperationResult(result any) ([]byte, error) {
	data, err := json.Marshal(struct {
		SchemaVersion int `json:"schemaVersion"`
		Result        any `json:"result"`
	}{1, result})
	if err != nil {
		return nil, err
	}
	if len(data)+1 > operationOutputLimit {
		return nil, errors.New("operation output too large")
	}
	return append(data, '\n'), nil
}

// FILETIME starts in 1601; .NET UTC ticks start in year 1. Avoid UnixNano,
// which overflows for modern dates when measured from either Windows epoch.
func filetimeTicks(low, high uint32, cimPrecision bool) (string, error) {
	const epochOffset uint64 = 504911232000000000
	value := uint64(high)<<32 | uint64(low)
	if value > ^uint64(0)-epochOffset {
		return "", errors.New("creation time overflow")
	}
	value += epochOffset
	if cimPrecision {
		value -= value % 10
	}
	return strconv.FormatUint(value, 10), nil
}

func validStarted(value string) bool {
	if len(value) == 0 || len(value) > 19 || value[0] == '0' {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	_, err := strconv.ParseUint(value, 10, 64)
	return err == nil
}
