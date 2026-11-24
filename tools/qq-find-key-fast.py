"""
快版：先扫内存**收集**候选（不验证），再做粗筛 + 逐个验证。
找到就停，并打印候选样本便于判断模式。

用法: python find-key-fast.py <pid> <nt_msg.db路径>
"""

import ctypes
import ctypes.wintypes as wintypes
import os
import re
import sys

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 0
DB = sys.argv[2] if len(sys.argv) > 2 else ""
if not PID or not DB:
    print("用法: python find-key-fast.py <pid> <nt_msg.db路径>")
    sys.exit(1)

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

# 占位：签名在 MBI 定义之后设置（需要类已存在）
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x08, 0x20, 0x40, 0x80}


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


def read_head(path, n=8192):
    h = k32.CreateFileW(path, 0x80000000, 3, None, 3, 0, None)
    if h in (-1, 0xFFFFFFFFFFFFFFFF):
        raise OSError(f"CreateFileW 失败 {ctypes.get_last_error()}")
    buf = ctypes.create_string_buffer(n)
    got = wintypes.DWORD(0)
    k32.ReadFile(h, buf, n, ctypes.byref(got), None)
    k32.CloseHandle(h)
    return buf.raw[: got.value]


raw = read_head(DB)
content = raw[1024:]
print(f"db 头(1024后): {content[:16].hex()}", flush=True)

# ---------- ① 扫内存收集候选 ----------
h = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, PID)
if not h:
    print("OpenProcess 失败", flush=True)
    sys.exit(2)

# ⚠️ 必须声明签名，否则 64 位指针被当 32 位传，VirtualQueryEx 一律失败
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]
k32.ReadProcessMemory.restype = wintypes.BOOL
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]

PAT = re.compile(rb"[\x20-\x7e]{16}")
cands = set()
addr, regions, read_mb = 0x10000, 0, 0.0
mbi = MBI()
buf = ctypes.create_string_buffer(1 << 20)
got = ctypes.c_size_t(0)
peek = k32.ReadProcessMemory

t_scan_start = __import__("time").time()
while addr < 0x7FFFFFFF0000:
    r = k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi))
    if not r:
        addr += 0x10000
        continue
    base, size = mbi.BaseAddress or 0, mbi.RegionSize or 0
    if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
        regions += 1
        off = 0
        while off < size:
            want = min(len(buf), size - off)
            if not peek(h, ctypes.c_void_p(base + off), buf, want, ctypes.byref(got)):
                break
            n = got.value
            if not n:
                break
            read_mb += n / 1048576
            for m in PAT.finditer(buf.raw[:n]):
                cands.add(m.group(0))
            if n < want:
                break
            off += n
    nxt = base + size
    addr = nxt if nxt > addr else addr + 0x10000
    if regions and regions % 800 == 0:
        print(f"  ...区域 {regions}｜读 {read_mb:.0f} MB｜候选 {len(cands)}", flush=True)
k32.CloseHandle(h)
scan_s = __import__("time").time() - t_scan_start
print(f"收集完成：区域 {regions}｜读了 {read_mb:.0f} MB｜候选 {len(cands)} 个｜耗时 {scan_s:.0f}s", flush=True)

# ---------- ② 粗筛 ----------
def looks_like_key(b: bytes) -> bool:
    s = b.decode("ascii", "ignore")
    if len(s) != 16:
        return False
    if re.search(r"[\\/:*?\"<>| ]", s):      # 路径/命令里常见的字符
        return False
    if len(set(s)) < 6:                       # 熵太低（aaaaaa…）
        return False
    if re.fullmatch(r"[0-9a-f]{16}", s):      # 纯 hex 也排除（密钥一般不这样）
        return False
    if re.fullmatch(r"[A-Za-z]{16}", s) and re.fullmatch(r"[a-z]{16}", s):
        return False                          # 纯小写英文单词不像
    if s.lower().startswith(("http", "www.", "file", "c:\\", "10.0", "127.")):
        return False
    return True


filtered = [c for c in cands if looks_like_key(c)]
print(f"粗筛后剩 {len(filtered)} 个（原 {len(cands)}）", flush=True)
print("样本（前 20）:", flush=True)
for c in filtered[:20]:
    print("   ", c.decode("ascii", "ignore"), flush=True)

# ---------- ③ 逐个验证 ----------
import sqlcipher3

TMP = "C:/Temp/_nt_try.db"


def try_key(key: bytes) -> bool:
    with open(TMP, "wb") as f:
        f.write(content)
    try:
        con = sqlcipher3.connect(TMP)
        cur = con.cursor()
        cur.execute("PRAGMA cipher_page_size = 4096")
        cur.execute("PRAGMA key = \"x'" + key.hex() + "'\"")
        cur.execute("PRAGMA kdf_iter = 4000")
        cur.execute("PRAGMA cipher_hmac_algorithm = HMAC_SHA1")
        cur.execute("PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512")
        cur.execute("SELECT count(*) FROM sqlite_master")
        cur.fetchone()
        con.close()
        return True
    except Exception:
        return False
    finally:
        try:
            os.remove(TMP)
        except Exception:
            pass


t0 = __import__("time").time()
for i, key in enumerate(filtered):
    if try_key(key):
        print("\n" + "=" * 60, flush=True)
        print("✅ 密钥:", key.decode("ascii"), flush=True)
        print("   hex:", key.hex(), flush=True)
        with open("C:/Temp/qq-db-key.txt", "w", encoding="utf-8") as f:
            f.write(key.decode("ascii"))
        print("   已存 C:\\Temp\\qq-db-key.txt", flush=True)
        print("=" * 60, flush=True)
        sys.exit(0)
    if i and i % 200 == 0:
        print(f"  已验证 {i}/{len(filtered)}（{__import__('time').time()-t0:.0f}s）", flush=True)

print(f"\n验证完 {len(filtered)} 个，没找到（{__import__('time').time()-t0:.0f}s）", flush=True)
sys.exit(3)
