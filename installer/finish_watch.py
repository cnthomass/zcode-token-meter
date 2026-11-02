#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""等待 ZCode 完全退出 → 应用待替换的 app.asar.ztu.tmp → 自动重启 ZCode.

用法（隐藏窗口后台运行）:
  pythonw finish_watch.py <installer.py> [zcode_exe]

流程:
  1. 每 1s 轮询 ZCode.exe 进程；全部退出后执行 installer --finish-pending
  2. 校验注入行存在（installer --status）
  3. 自动重启 ZCode；最长等待 2 小时后放弃（.tmp 保留，可手动收尾）
  日志: ~/.zcode/ztu-statusbar/finish-watch.log
"""

import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
WATCH_LOG = HOME / ".zcode" / "ztu-statusbar" / "finish-watch.log"
MAX_WAIT_S = 2 * 3600
POLL_S = 1.0


def log(msg):
    try:
        WATCH_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(WATCH_LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg + "\n")
    except OSError:
        pass


def zcode_running(exe_hint="ZCode.exe"):
    """tasklist 经 subprocess list 调用（Git Bash 会吞 /FI 开关，不用 shell）。"""
    try:
        r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq " + exe_hint],
                           capture_output=True, timeout=15)
        out = r.stdout.decode("gbk", "replace")
        return exe_hint.lower() in out.lower()
    except Exception as e:
        log("tasklist error: %s" % e)
        return True   # 查不到当作还在运行，宁可不动作


def main():
    installer = Path(sys.argv[1]).resolve()
    zcode_exe = sys.argv[2] if len(sys.argv) > 2 else r"E:\zTool\zCode\ZCode.exe"
    log("watch start: installer=%s exe=%s" % (installer, zcode_exe))
    t0 = time.time()
    while zcode_running():
        if time.time() - t0 > MAX_WAIT_S:
            log("timeout waiting for ZCode exit; tmp left pending")
            return
        time.sleep(POLL_S)
    time.sleep(2)   # 等文件句柄释放
    log("ZCode exited; applying pending tmp")
    r = subprocess.run([sys.executable, str(installer), "--finish-pending"],
                       capture_output=True, timeout=300)
    out = (r.stdout or b"").decode("utf-8", "replace") + (r.stderr or b"").decode("utf-8", "replace")
    log("finish-pending exit=%s out=%s" % (r.returncode, out.strip()[:400]))
    if r.returncode != 0:
        log("apply failed; not relaunching")
        return
    # 校验注入行（语言无关的退出码协议，避免输出编码误判）
    r2 = subprocess.run([sys.executable, str(installer), "--check-inject"],
                        capture_output=True, timeout=120)
    ok = r2.returncode == 0
    log("inject verify: %s" % ok)
    if not ok:
        log("inject line missing after finish; not relaunching")
        return
    try:
        subprocess.Popen([zcode_exe], close_fds=True,
                         creationflags=0x00000008)   # DETACHED_PROCESS
        log("ZCode relaunched")
    except Exception as e:
        log("relaunch failed: %s" % e)


if __name__ == "__main__":
    main()
