package main

import (
	"errors"
	"os"
	"syscall"
	"time"
)

type resourceInput struct {
	Target string   `json:"target"`
	Kind   string   `json:"kind"`
	Chain  []string `json:"chain,omitempty"`
	SID    string   `json:"sid,omitempty"`
}

func executeOperation(request operationRequest) (any, error) {
	switch request.Operation {
	case "pathCheck", "pathTree":
		var input struct {
			Target string   `json:"target"`
			Kind   string   `json:"kind"`
			Chain  []string `json:"chain,omitempty"`
		}
		if err := decodeStrictJSON(request.Input, &input); err != nil {
			return nil, err
		}
		if request.Operation == "pathTree" {
			if input.Kind != "directory" {
				return nil, errors.New("pathTree requires a directory")
			}
			return true, checkTree(input.Target)
		}
		return true, checkPath(input.Target, input.Kind)
	case "aclVerify", "aclProtect":
		var input struct {
			Chain     []string        `json:"chain,omitempty"`
			Resources []resourceInput `json:"resources"`
		}
		if err := decodeStrictJSON(request.Input, &input); err != nil {
			return nil, err
		}
		if input.Resources == nil {
			return nil, errors.New("resources must be an array")
		}
		checked := make(map[string]string)
		for _, resource := range input.Resources {
			if request.Operation == "aclProtect" {
				if err := protectPrivateResource(resource.Target, resource.Kind, resource.SID); err != nil {
					return nil, err
				}
			} else {
				// Derive the complete chain ourselves. Caller-supplied chains never permit
				// a missing ancestor or substitute for validation of the target.
				if err := checkPathCached(resource.Target, resource.Kind, checked); err != nil {
					return nil, err
				}
				handle, err := openCheckedResource(resource.Target, resource.Kind, readControl)
				if err != nil {
					return nil, err
				}
				err = verifyPrivateObject(handle, fileObject, resource.SID, fileFullAccess)
				syscall.CloseHandle(handle)
				if err != nil {
					return nil, err
				}
			}
		}
		return true, nil
	case "rootPublish":
		var input struct {
			Source      string `json:"source"`
			Destination string `json:"destination"`
		}
		if err := decodeStrictJSON(request.Input, &input); err != nil {
			return nil, err
		}
		return true, publishRoot(input.Source, input.Destination)
	case "processTable":
		var input struct {
			RequiredPIDs []uint32 `json:"requiredPids,omitempty"`
		}
		if err := decodeStrictJSON(request.Input, &input); err != nil {
			return nil, err
		}
		for _, pid := range input.RequiredPIDs {
			if pid == 0 {
				return nil, errors.New("invalid required PID")
			}
		}
		return processTable(input.RequiredPIDs)
	case "processIdentity", "processStart":
		var input struct {
			PID uint32 `json:"pid"`
		}
		if err := decodeStrictJSON(request.Input, &input); err != nil {
			return nil, err
		}
		if input.PID == 0 {
			return nil, errors.New("invalid PID")
		}
		if request.Operation == "processIdentity" {
			return processIdentity(input.PID)
		}
		return processStart(input.PID)
	case "processStop":
		var input struct {
			PID     uint32 `json:"pid"`
			Started string `json:"started"`
			SID     string `json:"sid"`
		}
		if err := decodeStrictJSON(request.Input, &input); err != nil {
			return nil, err
		}
		if input.PID == 0 || !validStarted(input.Started) {
			return nil, errors.New("invalid process identity")
		}
		return processStop(input.PID, input.Started, input.SID)
	case "jobObserve", "jobStop":
		return pluginJobOperation(request.Operation, request.Input)
	default:
		return nil, errors.New("unsupported operation")
	}
}

func runOperation() error {
	// Also bound a stalled stdin or blocked Windows API, independently of the JS
	// caller's timeout. This applies only to the short-lived operation mode.
	timer := time.AfterFunc(30*time.Second, func() { os.Exit(int(helperContainmentFailureExitCode)) })
	defer timer.Stop()
	request, err := decodeOperation(os.Stdin)
	if err != nil {
		return err
	}
	result, err := executeOperation(request)
	if err != nil {
		return err
	}
	data, err := encodeOperationResult(result)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(data)
	return err
}
