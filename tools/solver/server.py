"""Advisory HTTP service. Concurrent health checks, serialized solver state.

POST /solve  body: 局面 JSON   -> 求解结果
GET  /health                    -> {"ok": true}
"""
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from solve_api import analyze  # noqa: E402
from practical_api import analyze_practical, VERSION as PRACTICAL_VERSION
PRACTICAL = os.environ.get('POKER_SOLVER_MODE') == 'practical'

PORT = int(os.environ.get('SOLVER_PORT', '8891'))
STATS = {'solved': 0, 'errors': 0, 'lastMs': 0, 'slow': 0, 'busyRejected': 0}
SOLVE_LOCK = threading.Lock()
ACTIVE = {'decision': None, 'cancel': None}
DIAGNOSTICS = os.environ.get('SOLVER_LOG')
SLOW_MS = 6000


def log_diagnostic(req, elapsed, out):
    if DIAGNOSTICS:
        try:
            with open(DIAGNOSTICS, 'a', encoding='utf-8') as f:
                f.write(json.dumps({'at': time.time(), 'ms': elapsed, 'request': req,
                                    'ok': out.get('ok'), 'error': out.get('error'),
                                    'model': out.get('model')}, ensure_ascii=False) + '\n')
        except OSError:
            traceback.print_exc()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    timeout = 30

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        # Close idle Node keep-alive connections after each response.
        self.send_header('Connection', 'close')
        self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # A client may discard an obsolete decision before it finishes.

    def do_GET(self):
        if self.path.startswith('/health'):
            self._send(200, {'ok': True, 'stats': STATS,
                             'busy': SOLVE_LOCK.locked(),
                             'version': PRACTICAL_VERSION if PRACTICAL else '20261027-policy-quality-v5',
                             'mode': 'practical' if PRACTICAL else 'legacy',
                             'python': sys.version.split()[0]})
        else:
            self._send(404, {'ok': False, 'error': 'not found'})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'content-type')
        self.end_headers()

    def do_POST(self):
        if self.path not in ('/solve', '/cancel'):
            self._send(404, {'ok': False, 'error': 'not found'})
            return
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
        except Exception as e:
            self._send(400, {'ok': False, 'error': 'bad json: %s' % e})
            return
        if self.path == '/cancel':
            match = req.get('decisionId') and req.get('decisionId') == ACTIVE['decision']
            if match and ACTIVE['cancel']:
                ACTIVE['cancel'].set()
            self._send(200, {'ok': True, 'cancelled': bool(match)})
            return
        if req.get('fullStreet') and req.get('decisionId') and req['decisionId'] != ACTIVE['decision'] and ACTIVE['cancel']:
            ACTIVE['cancel'].set()
        acquired = SOLVE_LOCK.acquire(timeout=.25) if req.get('fullStreet') else SOLVE_LOCK.acquire(blocking=False)
        if not acquired:
            STATS['busyRejected'] += 1
            self._send(503, {'ok': False, 'busy': True, 'error': '分析服务正在处理另一请求'})
            return
        t0 = time.time()
        cancellation = threading.Event()
        ACTIVE.update(decision=req.get('decisionId'), cancel=cancellation)
        try:
            out = analyze_practical(req,cancel=cancellation) if PRACTICAL else analyze(req, cancel=cancellation) if req.get('fullStreet') else analyze(req)
            counter = 'solved' if out.get('ok') else 'cancelled' if out.get('cancelled') else 'errors'
            STATS[counter] = STATS.get(counter, 0) + 1
        except Exception as e:
            traceback.print_exc()
            STATS['errors'] += 1
            out = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
        finally:
            elapsed = round((time.time() - t0) * 1000, 1)
            STATS['lastMs'] = elapsed
            if elapsed > SLOW_MS:
                STATS['slow'] += 1
            if elapsed > SLOW_MS or not out.get('ok'):
                log_diagnostic(req, elapsed, out)
            ACTIVE.update(decision=None, cancel=None)
            SOLVE_LOCK.release()
        self._send(200, out)


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('[solver] listening on http://127.0.0.1:%d  (POST /solve)' % PORT,
          flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
