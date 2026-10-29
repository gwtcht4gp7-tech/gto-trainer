"""Service regressions adapted from the reviewed WorkBuddy improvements."""
import concurrent.futures
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch
import numpy as np
import cfr
import server


class ServiceRegression(unittest.TestCase):
    def test_new_decision_cancels_old_search_without_waiting_full_budget(self):
        entered=threading.Event()
        def analyze(req,cancel=None):
            if req['decisionId']=='new':return {'ok':True}
            entered.set()
            self.assertTrue(cancel.wait(2))
            return {'ok':False,'cancelled':True}
        httpd=ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        def post(id_):
            req=urllib.request.Request('http://127.0.0.1:%d/solve'%httpd.server_port,
                data=json.dumps({'fullStreet':True,'decisionId':id_}).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=3) as response:return json.load(response)
        try:
            with patch.object(server,'analyze',analyze),concurrent.futures.ThreadPoolExecutor() as pool:
                old=pool.submit(post,'old');self.assertTrue(entered.wait(1))
                self.assertTrue(post('new')['ok'])
                self.assertTrue(old.result(timeout=1)['cancelled'])
        finally:
            httpd.shutdown();httpd.server_close();thread.join(2)

    def test_health_responds_during_solve_and_second_solve_is_rejected(self):
        entered, release = threading.Event(), threading.Event()

        def solve(req):
            entered.set()
            if not release.wait(3):
                raise TimeoutError('test release missing')
            return {'ok': True, 'model': 'test'}

        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True); worker.start()
        url = 'http://127.0.0.1:%d' % httpd.server_port

        def post():
            req = urllib.request.Request(url + '/solve', data=b'{}', headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=4) as response:
                return json.load(response)

        try:
            with patch.object(server, 'analyze', solve), concurrent.futures.ThreadPoolExecutor() as pool:
                task = pool.submit(post)
                try:
                    self.assertTrue(entered.wait(1))
                    with urllib.request.urlopen(url + '/health', timeout=1) as response:
                        health = json.load(response)
                    self.assertTrue(health['ok']); self.assertTrue(health['busy'])
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        post()
                    self.assertEqual(caught.exception.code, 503)
                finally:
                    release.set()
                self.assertTrue(task.result(timeout=2)['ok'])
                with urllib.request.urlopen(url + '/health', timeout=1) as response:
                    self.assertFalse(json.load(response)['busy'])
        finally:
            release.set(); httpd.shutdown(); httpd.server_close(); worker.join(2)

    def test_tree_budget_stops_construction(self):
        cfg = cfr.Config(max_level=2); cfg.max_nodes = 1
        with self.assertRaises(cfr.TreeTooBig):
            cfr.build_root(cfg, 2, 2, [], 2, 100, [100, 100], 10, 0, False, True,
                           np.random.default_rng(1))


if __name__ == '__main__':
    unittest.main(verbosity=2)
