"""Isolated localhost inference preview. No game connection or production writes.

POST /preview accepts {decisionId, request}; it NEVER approves live publication.
The optional model is fixed by the launcher, not selected by HTTP input.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import threading
import time
from practical_replay import run_case


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body):
        payload = json.dumps(body, ensure_ascii=True, allow_nan=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.send(200 if self.path == '/health' else 404,
                  dict(mode='isolated_preview', publishable=False, model=bool(self.server.range_model)))

    def do_POST(self):
        started = time.perf_counter()
        if self.path != '/preview':
            self.send(404, dict(error='Unknown endpoint'))
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 262144:
                raise ValueError('Invalid body length')
            self.connection.settimeout(2)
            body = json.loads(self.rfile.read(length))
            decision_id, req = body['decisionId'], body['request']
            if not isinstance(decision_id, str) or not decision_id or not isinstance(req, dict):
                raise ValueError('Expected decisionId string and request object')
            deadline = req.get('deadlineEpochMs')
            if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
                raise ValueError('Invalid deadline')
            if deadline is not None and deadline <= time.time()*1000:
                self.send(409, dict(status='expired', decisionId=decision_id, publishable=False))
                return
        except (ValueError, KeyError, TypeError, TimeoutError):
            self.send(400, dict(error='Invalid preview request', publishable=False))
            return
        if not self.server.busy.acquire(blocking=False):
            self.send(429, dict(status='busy', decisionId=decision_id, publishable=False))
            return
        try:
            budget = 3700-(time.perf_counter()-started)*1000
            if deadline is not None:
                budget = min(budget, deadline-time.time()*1000-100)
            if budget < 50:
                result = dict(status='timed_out')
            else:
                result = run_case(req, 20261027, 4000, budget, self.server.range_model)
            out = dict(status=result['status'], decisionId=decision_id,
                       publishable=False, recommendationReady=False,
                       mode='isolated_preview', httpTotalMs=(time.perf_counter()-started)*1000)
            if result['status'] == 'ok':
                out.update(preview=result['variants']['joint_equity_correction']['guardedPreview'],
                           equity=result['equity'], rangeModel=result['rangeModel'],
                           rangeModelSha256=result['rangeModelSha256'],
                           historyActions=result['historyActions'])
            else:
                out['error'] = result.get('error', 'No preview')
            # Never return a result which finished after the caller's deadline.
            if (time.perf_counter()-started)*1000 > 3800 or deadline is not None and time.time()*1000 >= deadline:
                out = dict(status='timed_out', decisionId=decision_id, publishable=False,
                           recommendationReady=False)
            self.send(200, out)
        finally:
            self.server.busy.release()


def make_server(port=0, model=None):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.range_model = str(Path(model).resolve()) if model else None
    server.busy = threading.Lock()
    return server


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--port', type=int, default=8894)
    ap.add_argument('--range-model', type=Path)
    args = ap.parse_args()
    if args.range_model and not args.range_model.is_file():
        ap.error('Model file does not exist')
    with make_server(args.port, args.range_model) as server:
        print('Isolated preview listening on 127.0.0.1:' + str(server.server_port), flush=True)
        server.serve_forever()
