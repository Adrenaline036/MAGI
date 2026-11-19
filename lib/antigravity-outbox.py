"""从本机工作区转交已登记的消息，每个请求最多派发一次。"""
import json
import os
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTBOX = Path(os.environ["MAGI_OUTBOX"])


def run():
    OUTBOX.mkdir(parents=True, exist_ok=True)
    executable = os.environ.get("MAGI_WINDOWS_NODE", "/mnt/c/Program Files/nodejs/node.exe")
    entry = subprocess.check_output(["wslpath", "-w", str(ROOT / "lib" / "message.mjs")],
                                    text=True).strip()
    while True:
        for ready in OUTBOX.glob("*.ready"):
            try:
                if str(uuid.UUID(ready.stem)) != ready.stem:
                    continue
                ready.with_suffix(".attempt").touch(exist_ok=False)
            except (ValueError, FileExistsError):
                continue
            try:
                request_file = ready.with_suffix(".json")
                if request_file.is_symlink() or request_file.stat().st_size > 100000:
                    raise ValueError("请求文件无效")
                request = json.loads(request_file.read_text(encoding="utf8"))
                if not isinstance(request.get("from"), str) or not request["from"].startswith("antigravity/"):
                    raise ValueError("发送会话类型无效")
                result = subprocess.run([executable, entry, "antigravity-request"],
                                        input=json.dumps(request), encoding="utf8", capture_output=True, timeout=65)
                if result.returncode:
                    raise ValueError("入口返回错误：" + result.stderr[-1800:])
                receipt = json.loads(result.stdout)
            except (ValueError, TypeError, AttributeError, OSError, subprocess.TimeoutExpired) as exc:
                receipt = {"status": "unconfirmed", "detail": str(exc)}
            with ready.with_suffix(".result").open("x", encoding="utf8") as out:
                json.dump(receipt, out, ensure_ascii=False)
        time.sleep(1)