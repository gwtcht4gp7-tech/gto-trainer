import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
from practical_preview_server import make_server
from public_replay import prefixes
from test_public_replay import HAND


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.server = make_server()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port) + '/preview'
        self.req = prefixes(HAND)[0]['request']

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def post(self, body):
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(),
                                         headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def test_real_http_inference_is_bounded_and_never_live_approved(self):
        start = time.perf_counter()
        result = self.post(dict(decisionId='preview-1',request=self.req))
        self.assertEqual(result['status'],'ok')
        self.assertEqual(result['decisionId'],'preview-1')
        self.assertFalse(result['publishable'])
        self.assertFalse(result['recommendationReady'])
        self.assertLess(time.perf_counter()-start,4)
        self.assertNotIn('frequency',result['preview'])

    def test_expired_and_busy_requests_have_no_advice(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post(dict(decisionId='old', request={**self.req,'deadlineEpochMs':1}))
        self.assertEqual(caught.exception.code,409)
        self.server.busy.acquire()
        try:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post(dict(decisionId='busy',request=self.req))
            self.assertEqual(caught.exception.code,429)
        finally:
            self.server.busy.release()

    def test_malformed_and_timeout_do_not_contain_actions(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post({'request':self.req})
        self.assertEqual(caught.exception.code,400)
        with patch('practical_preview_server.run_case',return_value={'status':'timed_out'}):
            result = self.post(dict(decisionId='late',request=self.req))
        self.assertNotIn('preview',result)


if __name__ == '__main__':
    unittest.main(verbosity=2)
