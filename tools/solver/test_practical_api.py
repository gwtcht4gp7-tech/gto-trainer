import threading
import time
import unittest
import json
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from practical_api import analyze_practical, VERSION
from practical_replay import run_case
from public_replay import prefixes
from test_public_replay import HAND


class PracticalApiTests(unittest.TestCase):
    def test_actual_request_uses_simple_model_and_exact_amount(self):
        req=prefixes(HAND)[1]['request']
        req['heroCards']=['As','Ad']
        out=analyze_practical(req)
        self.assertTrue(out['ok'])
        self.assertEqual(out['version'],VERSION)
        self.assertEqual(out['model'],'practical_heuristic_v1')
        self.assertEqual(out['frequencies'],{})
        self.assertEqual(out['evs'],{})
        self.assertTrue(out['recommendationReady'])
        self.assertIn(out['recommendation'],('raise','call'))
        self.assertIn(out['recommendation'],out['actionAmounts'])
        self.assertTrue(out['reasoning']['headline'])
        self.assertEqual(len(out['reasoning']['keyPoints']),3)
        self.assertIn('翻前',out['reasoning']['limitations'][0])
        req['stackBB']=req.pop('heroStack')
        self.assertTrue(analyze_practical(req)['ok'],'archived stackBB aliases remain accepted')

    def test_invalid_money_and_expired_requests_have_no_action(self):
        req=prefixes(HAND)[0]['request']
        for r in ({**req,'pot':1},{**req,'deadlineEpochMs':1}):
            out=analyze_practical(r)
            self.assertFalse(out['ok'])
            self.assertNotIn('recommendation',out)

    def test_cancellation_terminates_owned_worker_and_discards_advice(self):
        req=prefixes(HAND)[0]['request']
        cancel=threading.Event()
        timer=threading.Timer(.02,cancel.set)
        timer.start()
        start=time.perf_counter()
        try:
            out=run_case(req,1,20000,3000,cancel=cancel)
        finally:
            timer.cancel()
        self.assertEqual(out['status'],'cancelled')
        self.assertLess(time.perf_counter()-start,1.5)
        self.assertNotIn('variants',out)

    def test_unproven_learned_model_is_never_passed_to_worker(self):
        with patch('practical_api.run_case',return_value={'status':'cancelled','wallMs':1}) as run:
            analyze_practical({'rangeModel':'anything','heroStack':100})
        self.assertNotIn('range_model',run.call_args.kwargs)

    def test_guarded_action_explanation_does_not_claim_original_raise_reason(self):
        req=prefixes(HAND)[0]['request']
        fake=dict(status='ok',street='river',numPlayers=2,sidePotRisk=False,samples=4000,
          historyActions=4,historyComplete=True,equity={'heroEquity':.6,'standardError':.01},
          variants={'joint_equity_correction':{'rawDecision':{'action':'raise','reasons':['原始加注理由不应沿用']},
          'guardedPreview':{'ready':True,'action':'call','additionalBB':1,'reasons':[],'kind':'closed_river_call_fold'}}})
        with patch('practical_api.run_case',return_value=fake):
            out=analyze_practical(req)
        self.assertEqual(out['recommendation'],'call')
        self.assertEqual(out['reasoning']['details'],[])
        self.assertIn('跟注',out['reasoning']['headline'])

    def test_actual_production_http_route_selects_practical_mode(self):
        import server
        req=prefixes(HAND)[0]['request']
        req.update(fullStreet=True,decisionId='http-practical',deadlineEpochMs=time.time()*1000+3400)
        httpd=ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True)
        thread.start()
        try:
            with patch.object(server,'PRACTICAL',True), patch.object(server,'analyze',side_effect=AssertionError('old solver used')):
                request=urllib.request.Request('http://127.0.0.1:%d/solve'%httpd.server_port,
                    data=json.dumps(req).encode(),headers={'Content-Type':'application/json'})
                with urllib.request.urlopen(request,timeout=4) as response:
                    result=json.load(response)
            self.assertEqual(result['model'],'practical_heuristic_v1')
            self.assertTrue(result['ok'])
            self.assertLess(result['totalMs'],3400)
        finally:
            httpd.shutdown();httpd.server_close();thread.join(2)


if __name__=='__main__':
    unittest.main(verbosity=2)
