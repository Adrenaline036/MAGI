"""将会话命令与宿主工具事件绑定。"""
import hashlib
import json
import shlex
import sys
import time
import uuid
from pathlib import Path

OUTBOX = Path(__file__).resolve().parent / "outbox"
FIELDS = {"send": "to", "reply": "replyTo", "broadcast": "group"}


def request_from(args):
    if len(args) not in (4, 5) or args[0] not in FIELDS:
        raise ValueError("需要操作、目标、正文和来源地址")
    action, dest, text, source = args[:4]
    request = {"from": source, FIELDS[action]: dest, "text": text}
    if len(args) == 5:
        request["project"] = args[4]
    return request


def digest(request):
    data = json.dumps(request, sort_keys=True, ensure_ascii=False).encode()
    return "MAGI-REQUEST " + hashlib.sha256(data).hexdigest()


def command_request(command):
    words = shlex.split(command)
    if len(words) < 2 or words[0] != "python3" or words[1] not in (".agents/magi/antigravity-message.py", "./.agents/magi/antigravity-message.py"):
        return None
    return request_from(words[2:])


def capture(event):
    call = event.get("toolCall", {})
    command = call.get("args", {}).get("CommandLine", "")
    if call.get("name") != "run_command" or event.get("error") or "antigravity-message.py" not in command:
        return
    try:
        request = command_request(command)
    except ValueError:
        return
    if request is None:
        return
    cid = str(uuid.UUID(event["conversationId"]))
    step = event["stepIdx"]
    if type(step) is not int or step < 0:
        return
    OUTBOX.mkdir(parents=True, exist_ok=True)
    entry = OUTBOX / str(uuid.uuid5(uuid.NAMESPACE_URL, "magi:" + cid + ":" + str(step)))
    if request["from"] != "antigravity/" + cid:
        with entry.with_suffix(".result").open("x", encoding="utf8") as out:
            json.dump({"status":"rejected", "reason":"source_mismatch", "conversationId":cid,
                       "claimed":request["from"], "stepIdx":step}, out)
        return
    with entry.with_suffix(".json").open("x", encoding="utf8") as out:
        json.dump(dict(request, proof={"session":cid,"step":step}), out, ensure_ascii=False)
    entry.with_suffix(".ready").touch(exist_ok=False)


def verify(envelope):
    proof = envelope.pop("proof")
    cid = str(uuid.UUID(proof["session"]))
    step = proof["step"]
    if type(step) is not int or step < 1 or envelope.get("from") != "antigravity/" + cid:
        raise ValueError("来源与宿主事件不符")
    path = Path.home() / ".gemini/antigravity/brain" / cid / ".system_generated/logs/transcript.jsonl"
    deadline = time.monotonic() + 10
    while True:
        calls = []
        with path.open(encoding="utf8") as log:
            for line in log:
                if not line.endswith("\n"):
                    continue
                event = json.loads(line)
                idx = event.get("step_index")
                if idx == step - 1:
                    calls = event.get("tool_calls", [])
                if idx == step and event.get("status") == "DONE":
                    if len(calls) != 1 or calls[0].get("name") != "run_command":
                        raise ValueError("工具调用不唯一")
                    raw = calls[0]["args"]["CommandLine"]
                    command = json.loads(raw) if raw.startswith('"') else raw
                    output = event.get("content","").replace("\r\n","\n")
                    if (command_request(command) != envelope or event.get("source") != "MODEL"
                            or event.get("type") != "GENERIC" or "Command exited with code 0." not in output
                            or output.partition("\nCommand output:\n")[2].strip() != digest(envelope)):
                        raise ValueError("命令或执行结果与发件请求不符")
                    return
        if time.monotonic() >= deadline:
            raise ValueError("未能核实宿主工具事件")
        time.sleep(0.25)


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    if sys.argv[1:] == ["verify"]:
        verify(payload)
    else:
        try:
            capture(payload)
        except FileExistsError:
            pass
        print("{}")