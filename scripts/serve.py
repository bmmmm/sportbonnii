"""Static file server for the browser gate: `python3 -m http.server` with a listen backlog of 128.

The default backlog (request_queue_size = 5) resets module loads when Chrome opens a page's module
graph in a burst on a busy machine (net::ERR_CONNECTION_RESET). Measured 2026-10-01, interleaved,
15 runs each, load average (1/5/15 min) 44.75/75.32/54.87 right after: 119 failed loads and 8 red gates
with the default, 0 and 0 with 128; then 30/30 green with this server.

Usage: serve.py <port> <directory>   (pnpm run serve → http://127.0.0.1:8765/)
"""
import functools
import http.server
import sys


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128


port, root = int(sys.argv[1]), sys.argv[2]
Server(("127.0.0.1", port), functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)).serve_forever()
