"""
从 NTQQ 进程内存里找 SQLCipher 密钥，并立刻验证 —— 找到就停。

## 原理
  NTQQ 用 SQLCipher 4 加密 nt_msg.db，密钥是 16 字节 ASCII，
  运行时以明文（或紧邻某个结构）留在进程内存里。
  所以：扫可读内存 → 抽所有 16 字节可打印 ASCII → 立刻拿去试解密 → 试通的那个就是密钥。

## 为什么"边扫边试"
  候选可能有几十万个，先存下来再逐个试太慢（每个 opening 10~20ms）。
  边扫边试 = 内存一读完就出结果，中间可以随时 Ctrl+C。

## 只读，不注入、不修改任何东西。
"""

import ctypes
import ctypes.wintypes as wintypes
import re
import sys
import os

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 0
DB = sys.argv[2] if len(sys.argv) > 2 else ""
if not PID or not DB:
    print("用法: python find-key.py <QQ的pid> <nt_msg.db 路径>")
    sys.exit(1)

# ---------- Win32 ----------
k32 = ctypes.WinDLL("kernel32", use_last_error=True)

PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x08, 0x20, 0x40, 0x80}


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", ctypes.wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", ctypes.wintypes.DWORD),
        ("Protect", ctypes.wintypes.DWORD),
        ("Type", ctypes.wintypes.DWORD),
    ]


def read_db_pages(path, nbytes=8192):
    """用共享模式读 db 的前 nbytes 字节（剥掉 1024 字节头之后才是 SQLCipher 内容）"""
    import msvcrt
    from ctypes import wintypes as wt

    GENERIC_READ = 0x80000000
    FILE_SHARE_READ = 1
    FILE_SHARE_WRITE = 2
    OPEN_EXISTING = 3
    h = k32.CreateFileW(
        path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, 0, None
    )
    if h == -1 or h == 0xFFFFFFFFFFFFFFFF:
        raise OSError(f"CreateFileW 失败: {ctypes.get_last_error()}")
    buf = ctypes.create_string_buffer(nbytes)
    got = wintypes.DWORD(0)
    ok = k32.ReadFile(h, buf, nbytes, ctypes.byref(got), None)
    k32.CloseHandle(h)
    if not ok:
        raise OSError("ReadFile 失败")
    return buf.raw[: got.value]


def try_key(key: bytes, header: bytes, page_size=4096) -> bool:
    """用 sqlcipher3 试一把：能读出 sqlite_master 就算对"""
    import sqlcipher3

    # 写临时文件（剥头后的 SQLCipher 内容）
    tmp = "C:/Temp/_nt_try.db"
    with open(tmp, "wb") as f:
        f.write(header)
    try:
        con = sqlcipher3.connect(tmp)
        cur = con.cursor()
        cur.execute(f"PRAGMA cipher_page_size = {page_size}")
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
            os.remove(tmp)
        except Exception:
            pass


# ---------- 读 db 并剥头 ----------
print(f"读 db: {DB}")
raw = read_db_pages(DB, 8192)
print(f"  前 16 字节: {raw[:16]}")
content = raw[1024:]
print(f"  剥掉 1024 字节头后前 16 字节: {content[:16].hex()}")

# ---------- 打开进程 ----------
h = k32.OpenProcess(PROCESS_VM_READ, False, PID)
if not h:
    print(f"OpenProcess 失败: {ctypes.get_last_error()}")
    sys.exit(2)
print(f"已打开进程 {PID}")

peek = k32.ReadProcessMemory
tried = set()
regions = 0
read_mb = 0.0
hits = 0
addr = 0x10000
mbi = MEMORY_BASIC_INFORMATION()
buf = ctypes.create_string_buffer(1 << 20)
got = ctypes.c_size_t(0)

PAT = re.compile(rb"[\x20-\x7e]{16}")

while addr < 0x7FFFFFFF0000:
    r = k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi))
    if not r:
        addr += 0x10000
        continue
    base = mbi.BaseAddress or 0
    size = mbi.RegionSize or 0
    if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in READABLE and 0 < size < (1 << 30):
        regions += 1
        off = 0
        while off < size:
            want = min(len(buf), size - off)
            if not peek(h, ctypes.c_void_p(base + off), buf, want, ctypes.byref(got)):
                break
            n = got.value
            if n == 0:
                break
            read_mb += n / 1048576
            chunk = buf.raw[:n]
            for m in PAT.finditer(chunk):
                cand = m.group(0)
                if cand in tried:
                    continue
                tried.add(cand)
                hits += 1
                key = cand
                if try_key(key, content):
                    print("\n" + "=" * 60)
                    print("✅ 找到密钥:", key.decode("ascii"))
                    print("   hex:", key.hex())
                    with open("C:/Temp/qq-db-key.txt", "w", encoding="utf-8") as f:
                        f.write(key.decode("ascii"))
                    print("   已存 C:\\Temp\\qq-db-key.txt")
                    print("=" * 60)
                    k32.CloseHandle(h)
                    sys.exit(0)
            if n < want:
                break
            off += n
    nxt = base + size
    addr = nxt if nxt > addr else addr + 0x10000
    if regions % 50 == 0:
        print(f"  ...区域 {regions}｜已读 {read_mb:.0f} MB｜试过 {len(tried)} 个候选", flush=True)

k32.CloseHandle(h)
print(f"\n扫完：区域 {regions}｜读了 {read_mb:.0f} MB｜试过 {len(tried)} 个候选 —— 没找到")
sys.exit(3)
