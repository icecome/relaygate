"""mitmproxy addon：只记录小浣熊域名的请求/响应概要，写入 JSONL。

用法：
  mitmdump -s capture_raccoon.py --listen-host 127.0.0.1 --listen-port 8899
环境变量：
  RACCOON_CAPTURE  输出文件（默认 logs/raccoon-capture.jsonl）
"""
import json
import os
import re
import time

OUT = os.environ.get(
    "RACCOON_CAPTURE",
    r"C:\opt\workstations\project\web\RelayGate\logs\raccoon-capture.jsonl",
)
HOST_RE = re.compile(r"xiaohuanxiong\.com$", re.I)
# 不落敏感值，只记录结构：token 仅留前缀、手机号一律掩码
MASK_HEADERS = {"authorization", "cookie", "set-cookie", "x-org-code"}


def _mask(name, value):
    low = name.lower()
    if low == "authorization":
        return value[:18] + "…(len=%d)" % len(value)
    if low in ("cookie", "set-cookie"):
        return "(%d chars)" % len(value)
    return value


def _record(row):
    with open(OUT, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def response(flow):
    host = (flow.request.host or "")
    if not HOST_RE.search(host):
        return
    req = flow.request
    body = req.get_content()
    text = body.decode("utf-8", "replace") if body else ""
    if re.search(r"phone|mobile", text, re.I):
        text = re.sub(r'"(phone|mobile|nation_code)"\s*:\s*"[^"]*"', r'"\1":"***"', text)
    resp = flow.response
    rbody = resp.get_content()
    rtext = rbody.decode("utf-8", "replace") if rbody else ""

    _record({
        "ts": round(time.time(), 3),
        "host": host,
        "method": req.method,
        "path": req.path,
        "scheme": req.scheme,
        "req_headers": {k: _mask(k, v) for k, v in req.headers.items()},
        "req_body": text[:2000],
        "status": resp.status_code,
        "resp_headers": {k: _mask(k, v) for k, v in resp.headers.items()},
        "resp_body": rtext[:4000],
        "resp_len": len(rbody or b""),
    })
