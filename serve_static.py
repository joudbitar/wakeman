#!/usr/bin/env python3
"""Tiny static server with Vercel-style cleanUrls, for xerb.

Serves the current working directory. Resolves extensionless paths to their
.html file (so /cpi -> cpi.html, /blog/cpi -> blog/cpi.html), matching the
portfolio's vercel.json { "cleanUrls": true }. Binds PORT (env) on 127.0.0.1.

Usage: run from the site directory. `python3 serve_static.py [port]`
"""
import os, socketserver, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8000))
ROOT = os.getcwd()


class CleanURLHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        fs = self.translate_path(self.path)
        # extensionless, non-directory path that doesn't exist -> try .html
        if (not os.path.exists(fs) and not path.endswith("/")
                and "." not in os.path.basename(path)):
            if os.path.isfile(self.translate_path(path + ".html")):
                self.path = path + ".html"
        return super().send_head()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(ThreadingHTTPServer):
    # HTTPServer.server_bind calls socket.getfqdn(), a reverse DNS lookup that
    # can stall for many seconds on some Macs (CI runners among them) before
    # the port opens. The name is only used in CGI env vars; the host will do.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


if __name__ == "__main__":
    handler = lambda *a, **k: CleanURLHandler(*a, directory=ROOT, **k)
    srv = Server(("127.0.0.1", PORT), handler)
    print(f"serve_static: {ROOT} on http://127.0.0.1:{PORT} (cleanUrls)", flush=True)
    srv.serve_forever()
