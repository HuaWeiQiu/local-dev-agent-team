#!/usr/bin/env python3
"""Loopback HTTP host for a Laya decision model, used as the orchestrator's Jev.

Laya is a classifier, not a chat model: it scores typed questions in one forward
pass. This script exposes it to `jev.protocol: laya` in agent-team.yaml.

    USE_TF=0 <venv>/bin/python scripts/laya-jev-server.py \
        --model aac6fef/laya-multilingual-mlx --port 9932

POST /decide  {"state": "...", "questions": {...}}  ->  {"answers": {...}}
GET  /health  ->  {"ok": true, "model": "..."}

The server binds to 127.0.0.1 only and handles one request at a time, because
MLX streams belong to the thread that loaded the model.
"""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_BODY_BYTES = 256 * 1024


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="aac6fef/laya-multilingual-mlx")
    parser.add_argument("--port", type=int, default=9932)
    args = parser.parse_args()

    import laya_mlx as laya

    started = time.time()
    agent = laya.load(args.model)
    print(f"[laya-jev] loaded {args.model} in {time.time() - started:.1f}s", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *params):  # keep failure text out of logs
            return

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "model": args.model})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/decide":
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send(413, {"error": "body size out of range"})
                return
            try:
                body = json.loads(self.rfile.read(length))
                state, questions = body["state"], body["questions"]
                if not isinstance(questions, dict):
                    raise ValueError("questions must be an object")
                result = agent.predict(state, questions)
            except (KeyError, ValueError, TypeError) as error:
                self._send(400, {"error": str(error)})
                return
            except Exception as error:  # model failures must not kill the host
                self._send(500, {"error": f"{type(error).__name__}: {error}"})
                return
            self._send(200, {"answers": result["answers"]})

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[laya-jev] listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
