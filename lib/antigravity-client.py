import json
import os
import socket
import sys

with socket.socket(socket.AF_UNIX) as conn:
    conn.settimeout(35)
    conn.connect("\0magi.antigravity." + str(os.getuid()))
    conn.sendall(sys.stdin.buffer.read(131073) + b"\n")
    conn.shutdown(socket.SHUT_WR)
    with conn.makefile("rb") as reader:
        result = json.load(reader)
    print(json.dumps(result))
