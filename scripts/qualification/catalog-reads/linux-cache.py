"""Evict and inspect the Catalog regular-file pages owned by this Linux runner."""

import ctypes
import json
import mmap
import os
import sys
from pathlib import Path


def main():
    mode = sys.argv[1]
    if mode not in {"evict", "inspect"}:
        raise ValueError(f"Unexpected cache operation: {mode}")
    root = Path(sys.argv[2])
    files = sorted(file for file in root.rglob("*") if file.is_file())
    mincore = ctypes.CDLL(None, use_errno=True).mincore
    mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    page_size = os.sysconf("SC_PAGE_SIZE")
    total_pages = 0
    resident_pages = 0

    for path in files:
        size = path.stat().st_size
        if not size:
            continue
        with path.open("rb") as file:
            if mode == "evict":
                os.fsync(file.fileno())
                os.posix_fadvise(file.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
            page_count = (size + page_size - 1) // page_size
            vector = (ctypes.c_ubyte * page_count)()
            # A private mapping allows a buffer address without touching the file.
            with mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_COPY) as mapping:
                address = ctypes.addressof(ctypes.c_char.from_buffer(mapping))
                if mincore(address, size, vector):
                    errno = ctypes.get_errno()
                    raise OSError(errno, os.strerror(errno))
            total_pages += page_count
            resident_pages += sum(page & 1 for page in vector)

    print(json.dumps({
        "regularFiles": len(files),
        "residentPages": resident_pages,
        "totalPages": total_pages,
    }))


if __name__ == "__main__":
    main()
