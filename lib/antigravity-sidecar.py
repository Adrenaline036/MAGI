"""以宿主授予的上下文按会话发送。抽象 Unix 套接字随进程退出自动释放。"""
import json
import os
import socket
import struct
import subprocess
import runpy
import threading
import uuid
from pathlib import Path

def serve():
    if not os.environ.get("ANTIGRAVITY_LS_ADDRESS"):
        raise RuntimeError("需要 Antigravity Sidecar 宿主环境")
    api = Path.home() / ".gemini/antigravity/bin/agentapi"
    with socket.socket(socket.AF_UNIX) as server:
        server.bind("\0magi.antigravity." + str(os.getuid()))
        server.listen(8)
        while True:
            peer, _ = server.accept()
            with peer:
                try:
                    _, uid, _ = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != os.getuid():
                        continue
                    peer.settimeout(5)
                    with peer.makefile("rb") as reader:
                        req = json.loads(reader.readline(131073))
                    cid, body = req["session"], req["body"]
                    if str(uuid.UUID(cid)) != cid or not isinstance(body, str) or not 0 < len(body.encode()) <= 65536:
                        raise ValueError("会话或正文无效")
                    result = subprocess.run([str(api), "send-message", cid, body], capture_output=True, timeout=25)
                    reply = {"accepted": result.returncode == 0}
                except (KeyError, TypeError, ValueError, OSError, subprocess.TimeoutExpired):
                    reply = {"accepted": False}
                try:
                    peer.sendall(json.dumps(reply).encode())
                except OSError:
                    pass

if __name__ == "__main__":
    dispatcher = runpy.run_path(str(Path(__file__).with_name("antigravity-outbox.py")))["run"]
    threading.Thread(target=dispatcher, name="magi-outbox", daemon=True).start()
    serve()