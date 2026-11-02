package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

// Windows ACL/SID wire layouts are stable and contain no native pointers.
// Keeping this parser portable lets malformed and unsupported ACEs be tested
// without using our own ACL writer as the source of the expected result.
func verifyACLBytes(acl []byte, sid string, fullMask uint32, job bool) error {
	if len(acl) < 8 || (acl[0] != 2 && acl[0] != 4) || int(binary.LittleEndian.Uint16(acl[2:])) != len(acl) {
		return errors.New("invalid ACL header")
	}
	count := int(binary.LittleEndian.Uint16(acl[4:]))
	if count == 0 {
		return errors.New("empty DACL")
	}
	offset, full := 8, false
	for i := 0; i < count; i++ {
		if len(acl)-offset < 8 {
			return errors.New("truncated ACE")
		}
		ace := acl[offset:]
		size := int(binary.LittleEndian.Uint16(ace[2:]))
		if size < 16 || size > len(ace) || size%4 != 0 {
			return errors.New("invalid ACE size")
		}
		ace = ace[:size]
		// Only explicit access-allowed ACEs with ordinary inheritance flags are
		// supported. INHERIT_ONLY cannot prove access to this object itself.
		if ace[0] != 0 || ace[1]&^byte(0x0f) != 0 {
			return errors.New("unsafe ACE type or flags")
		}
		actual, err := sidString(ace[8:])
		if err != nil || actual != sid {
			return errors.New("foreign or invalid ACE SID")
		}
		mask := binary.LittleEndian.Uint32(ace[4:])
		allowedFull := mask&fullMask == fullMask
		if job && fullMask == 0x10000000 {
			allowedFull = allowedFull || mask&0x001f003f == 0x001f003f
		}
		if allowedFull && ace[1]&0x08 == 0 {
			full = true
		}
		offset += size
	}
	if !full {
		return errors.New("owner lacks full access")
	}
	return nil
}

func sidString(data []byte) (string, error) {
	if len(data) < 8 || data[0] != 1 || data[1] > 15 || len(data) != 8+4*int(data[1]) {
		return "", errors.New("invalid SID")
	}
	authority := uint64(0)
	for _, b := range data[2:8] {
		authority = authority<<8 | uint64(b)
	}
	var out strings.Builder
	fmt.Fprintf(&out, "S-1-%d", authority)
	for offset := 8; offset < len(data); offset += 4 {
		fmt.Fprintf(&out, "-%d", binary.LittleEndian.Uint32(data[offset:]))
	}
	return out.String(), nil
}
