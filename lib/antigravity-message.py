"""把本次发件参数摘要交给宿主的工具调用记录。"""
import sys

sys.dont_write_bytecode = True
from antigravity_provenance import digest, request_from

if __name__ == "__main__":
    print(digest(request_from(sys.argv[1:])))
