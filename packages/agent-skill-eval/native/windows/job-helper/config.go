package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const configSchemaVersion = 1

type launchConfig struct {
	SchemaVersion int      `json:"schemaVersion"`
	Executable    string   `json:"executable"`
	Args          []string `json:"args"`
	ParentPID     uint32   `json:"parentPid"`
}

func decodeLaunchConfig(encoded string) (launchConfig, error) {
	var config launchConfig
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return config, fmt.Errorf("decode config: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("parse config: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return config, errors.New("parse config: trailing JSON value")
	}
	if config.SchemaVersion != configSchemaVersion {
		return config, fmt.Errorf("unsupported config schema %d", config.SchemaVersion)
	}
	if config.Executable == "" || strings.ContainsRune(config.Executable, 0) {
		return config, errors.New("invalid executable")
	}
	if config.ParentPID == 0 {
		return config, errors.New("invalid parent pid")
	}
	for _, arg := range config.Args {
		if strings.ContainsRune(arg, 0) {
			return config, errors.New("argument contains NUL")
		}
	}
	return config, nil
}

func quoteWindowsArgument(value string) string {
	var output strings.Builder
	output.WriteByte('"')
	backslashes := 0
	for _, char := range value {
		switch char {
		case '\\':
			backslashes++
		case '"':
			output.WriteString(strings.Repeat("\\", backslashes*2+1))
			output.WriteRune(char)
			backslashes = 0
		default:
			output.WriteString(strings.Repeat("\\", backslashes))
			backslashes = 0
			output.WriteRune(char)
		}
	}
	output.WriteString(strings.Repeat("\\", backslashes*2))
	output.WriteByte('"')
	return output.String()
}

func buildWindowsCommandLine(executable string, args []string) string {
	quoted := make([]string, 0, len(args)+1)
	quoted = append(quoted, quoteWindowsArgument(executable))
	for _, arg := range args {
		quoted = append(quoted, quoteWindowsArgument(arg))
	}
	return strings.Join(quoted, " ")
}
