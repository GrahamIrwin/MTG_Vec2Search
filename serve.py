"""Serve site/ at http://localhost:8000 for working on it: python serve.py [port]

Every file is checked with the server on each load (no-cache), so a changed app.js shows on a plain
refresh; the live site gets that from its deploys' script versions instead. It also takes bursts of
requests (a gallery of card images and chunks) that python -m http.server's queue of 5 drops.
"""
import functools
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


http.server.ThreadingHTTPServer.request_queue_size = 256
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print(f"http://localhost:{port}", flush=True)
http.server.ThreadingHTTPServer(("", port), functools.partial(NoCache, directory="site")).serve_forever()
