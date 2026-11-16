"""Keeps one model process running and answers requests over HTTP, so the model is loaded once.

    python worker-server.py ocr        [--host 0.0.0.0] [--port 8000]
    python worker-server.py grounding  [--host 0.0.0.0] [--port 8000]

    GET  /health  {"kind": ..., "ready": true}
    POST /run     JSON body, JSON answer in the same shape the one-shot script prints:
        ocr        {"image": base64 JPEG, "settings": {"KKOK_OCR_LANGS": "korean", ...}?}
        grounding  {"image": base64 JPEG, "queries": [{"cueId", "query"}], "threshold"?, "textThreshold"?}

The worker keeps nothing between requests and never calls another worker: the caller decides the order.
Standard library only, so the image needs nothing beyond the model's own requirements.
"""
import argparse, base64, importlib, json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LIMIT = 16 * 1024 * 1024
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def runner(kind):
    if kind == "ocr":
        module = importlib.import_module("ocr")
        def run(payload):
            settings = payload.get("settings") or {}
            if not isinstance(settings, dict) or any(not str(name).startswith("KKOK_OCR_") for name in settings):
                raise ValueError("Invalid settings")
            return module.extract(base64.b64decode(payload["image"], validate=True), settings)
        return run
    module = importlib.import_module("detect")
    return module.detect

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["ocr", "grounding"])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    run = runner(args.kind)
    # One inference at a time: the models are not safe to call from two threads and would share the CPU anyway.
    busy = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def answer(self, status, body):
            data = json.dumps(body, ensure_ascii=True, allow_nan=False).encode("ascii")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            if self.path == "/health": self.answer(200, {"kind": args.kind, "ready": True})
            else: self.answer(404, {"error": "NOT_FOUND"})
        def do_POST(self):
            if self.path != "/run": return self.answer(404, {"error": "NOT_FOUND"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= LIMIT: return self.answer(413, {"error": "REQUEST_TOO_LARGE"})
                payload = json.loads(self.rfile.read(length))
                with busy: result = run(payload)
            except Exception:
                # Photos and their text stay out of the log: the kind of failure is enough.
                sys.stderr.write(f"{args.kind} request failed.\n")
                return self.answer(500, {"error": f"{args.kind.upper()}_FAILED"})
            self.answer(200, result)
        def log_message(self, *_): pass

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(f"{args.kind} worker: http://{args.host}:{args.port}\n")
    server.serve_forever()

if __name__ == "__main__":
    main()
