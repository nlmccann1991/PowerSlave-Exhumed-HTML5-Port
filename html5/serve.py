#!/usr/bin/env python3
"""Serves the PowerSlave Exhumed folder for the HTML5 port with caching turned off.

`python3 -m http.server` sends no cache headers, so browsers may keep running old
copies of the port's scripts after they change. This sends `Cache-Control: no-cache`,
which makes the browser check for a newer file on every load.

    python3 html5/serve.py [port]        # then open http://localhost:8000/html5/
"""

import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    game_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCacheHandler, directory=game_dir)
    with http.server.ThreadingHTTPServer(('', port), handler) as httpd:
        print(f'Serving {game_dir} at http://localhost:{port}/html5/')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
