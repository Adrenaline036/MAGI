"""为单个 Antigravity 工作区准备可核验的安装文件与目标清单。"""
import argparse
import hashlib
import json
import shlex
import shutil
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspace", type=Path)
    parser.add_argument("staging", type=Path)
    args = parser.parse_args()
    workspace = args.workspace.resolve(strict=True)
    if not workspace.is_dir():
        parser.error("工作区必须是现有目录")
    stage = args.staging.resolve()
    stage.mkdir(parents=True, exist_ok=False)
    lib = Path(__file__).resolve().parents[1] / "lib"
    dest = workspace / ".agents" / "magi"
    hook = {"PostToolUse": [{"matcher": "run_command", "hooks": [{
        "type": "command", "command": "python3 " + shlex.quote(str(dest / "antigravity_provenance.py")), "timeout": 5}]}]}
    hooks_path = workspace / ".agents/hooks.json"
    hooks = json.loads(hooks_path.read_text(encoding="utf8")) if hooks_path.exists() else {}
    hooks["MAGI 发件来源核验"] = hook
    sidecar = {"command": "/usr/bin/python3", "args": [str(lib / "antigravity-sidecar.py")],
               "restart_policy": "always", "env": {"MAGI_OUTBOX": str(dest / "outbox")}, "display_name": "MAGI 会话路由"}
    manifest = {}
    for name in ("antigravity-message.py", "antigravity_provenance.py"):
        shutil.copyfile(lib / name, stage / name)
        manifest[name] = str(dest / name)
    for name, value, target in (("hooks.json", hooks, hooks_path), ("sidecar.json", sidecar,
            Path.home() / ".gemini/config/sidecars/magi-router/sidecar.json")):
        (stage / name).write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf8")
        manifest[name] = str(target)
    plans = [{"file": name, "target": target, "sha256": hashlib.sha256((stage / name).read_bytes()).hexdigest()}
             for name, target in manifest.items()]
    (stage / "install.json").write_text(json.dumps(plans, indent=2, ensure_ascii=False), encoding="utf8")


if __name__ == "__main__":
    main()