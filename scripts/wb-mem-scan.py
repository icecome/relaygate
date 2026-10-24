import ctypes
import ctypes.wintypes as w
import hashlib
import json
import re
import sys
import binascii

k32 = ctypes.WinDLL('kernel32', use_last_error=True)

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
PAGE_READABLE = (0x02, 0x04, 0x20, 0x40, 0x08, 0x80)  # READONLY, READWRITE, EXECUTE_READ, EXECUTE_READWRITE, WRITECOPY, EXECUTE_WRITECOPY
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('BaseAddress', ctypes.c_void_p),
        ('AllocationBase', ctypes.c_void_p),
        ('AllocationProtect', w.DWORD),
        ('RegionSize', ctypes.c_size_t),
        ('State', w.DWORD),
        ('Protect', w.DWORD),
        ('Type', w.DWORD),
    ]


def open_proc(pid):
    return k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)


def regions(h):
    addr = 0
    mbi = MEMORY_BASIC_INFORMATION()
    while k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
        yield int(mbi.BaseAddress or 0), int(mbi.RegionSize), int(mbi.State), int(mbi.Protect)
        addr = int(mbi.BaseAddress or 0) + int(mbi.RegionSize)
        if addr > 0x7FFFFFFFFFFF:
            break


def read_chunk(h, base, size):
    buf = ctypes.create_string_buffer(size)
    n = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(h, ctypes.c_void_p(base), buf, size, ctypes.byref(n))
    if not ok:
        return None
    return buf.raw[: n.value]


TARGET_KEYID = b'9127dea1b44020a7'
B64_44 = re.compile(rb'[A-Za-z0-9+/]{43}=')


def verify_key(cand: bytes):
    try:
        raw = binascii.a2b_base64(cand)
    except Exception:
        return False
    if len(raw) != 32:
        return False
    return hashlib.sha256(raw).hexdigest()[:16] == TARGET_KEYID.decode()


def main():
    result = {'keys': [], 'tokens': [], 'keyIdsSeen': 0}
    pids = [int(x) for x in sys.argv[1:]]
    for pid in pids:
        h = open_proc(pid)
        if not h:
            print(f'pid {pid}: OpenProcess failed ({ctypes.get_last_error()})')
            continue
        total = 0
        try:
            for base, size, state, prot in regions(h):
                if state != MEM_COMMIT or prot & PAGE_NOACCESS or prot & PAGE_GUARD:
                    continue
                if size <= 0 or size > 512 * 1024 * 1024:
                    continue
                off = 0
                chunk = 8 * 1024 * 1024
                while off < size:
                    n = min(chunk, size - off)
                    data = read_chunk(h, base + off, n)
                    off += n
                    if not data:
                        continue
                    total += len(data)
                    if TARGET_KEYID in data:
                        result['keyIdsSeen'] += 1
                        for m in B64_44.finditer(data):
                            cand = m.group(0)
                            if verify_key(cand):
                                hexkey = hashlib.sha256(binascii.a2b_base64(cand)).digest().hex()
                                if hexkey not in [k['keyHash'] for k in result['keys']]:
                                    result['keys'].append({'b64': cand.decode(), 'keyHash': hexkey, 'pid': pid, 'source': 'b64-44'})
                    # keyBase64 JSON adjacency
                    for m in re.finditer(rb'keyBase64"\s*:\s*"([A-Za-z0-9+/]{43}=)"', data):
                        cand = m.group(1)
                        if verify_key(cand):
                            hexkey = hashlib.sha256(binascii.a2b_base64(cand)).digest().hex()
                            if hexkey not in [k['keyHash'] for k in result['keys']]:
                                result['keys'].append({'b64': cand.decode(), 'keyHash': hexkey, 'pid': pid, 'source': 'keyBase64'})
                    # JWT-like tokens
                    for m in re.finditer(rb'eyJ[A-Za-z0-9_-]{40,4000}', data):
                        tok = m.group(0)
                        if len(tok) >= 120:
                            s = tok.decode('ascii', 'ignore')
                            if s not in result['tokens']:
                                result['tokens'].append(s)
        finally:
            k32.CloseHandle(h)
        print(f'pid {pid}: scanned {total/1024/1024:.0f} MB')
    out = {
        'keys': result['keys'],
        'keyIdHits': result['keyIdsSeen'],
        'tokens': [{'len': len(t), 'head': t[:24]} for t in result['tokens'][:50]],
    }
    print(json.dumps(out, indent=2)[:4000])
    with open(r'C:\opt\workstations\project\web\RelayGate\logs\_mem_keys.json', 'w', encoding='utf-8') as f:
        json.dump(result, f)


if __name__ == '__main__':
    main()


