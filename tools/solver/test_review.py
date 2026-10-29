import json
from pathlib import Path
import tempfile
import threading
import subprocess
import sys
import time
import unittest
from dataclasses import replace
from test_fullstreet import request
from fullstreet import Root, IncompleteState
from mccfr import Interrupted
from review import actual_action, review_decision, RealtimePriority


def observation():
    req=request();req.update(potBB=req['pot'],toCallBB=req['toCall'],handId='t:h')
    return {'decisionId':'d','handId':'t:h','request':req,
            'actual':{'action':'raise','amount':270.,'total':270.},'comparison':{}}


class Review(unittest.TestCase):
    def test_exact_off_menu_amount_is_preserved(self):
        row=observation();root=Root(row['request'],time.perf_counter()+2)
        state,_=root.deal(fixed_hero=True)
        action=actual_action(state,row)
        self.assertTrue(action.label.startswith('actual@'));self.assertAlmostEqual(action.amount,2.7)
        changed=replace(state,extra_root_action=action)
        self.assertIn(action,changed.actions())
        after=changed.step(action)
        self.assertAlmostEqual(after.committed[root.hero],state.committed[root.hero]+2.7)
        self.assertNotIn(action,after.actions(),'extra action is confined to the observed decision')

    def test_illegal_record_is_excluded(self):
        row=observation();state,_=Root(row['request'],time.perf_counter()+2).deal(True)
        row['actual']['amount']=150.
        with self.assertRaises(IncompleteState):actual_action(state,row)

    def test_no_showdown_or_profit_leak(self):
        row=observation()
        first=review_decision(row,budget_ms=500,sample_limit=8)
        row['outcome']={'netChips':999999999,'showdown':[['As','Ad']]}
        a=Root(row['request'],time.perf_counter()+2)
        b=Root({**row['request'],'outcome':row['outcome']},time.perf_counter()+2)
        self.assertEqual(a.deal(True),b.deal(True),'post-hand result must not change chance deals')
        self.assertNotIn('outcome',first)
        self.assertIn('actual@2.7',first['evs']);self.assertGreaterEqual(first['samplesPerAction'],2)
        self.assertIn('pairedStandardErrorBB',first['comparison'])

    def test_realtime_lease_interrupts_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease=Path(tmp)/'lease';lease.write_text(str(time.time()+5),encoding='utf-8')
            cancel=RealtimePriority(lease)
            self.assertTrue(cancel.is_set())
            with self.assertRaises(Interrupted):review_decision(observation(),budget_ms=500,cancel=cancel)

    def test_mid_search_realtime_lease_is_observed(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease=Path(tmp)/'lease';cancel=RealtimePriority(lease)
            timer=threading.Timer(.08,lambda:lease.write_text(str(time.time()+5),encoding='utf-8'))
            started=time.perf_counter();timer.start()
            try:
                with self.assertRaises(Interrupted):review_decision(observation(),budget_ms=2000,cancel=cancel)
                self.assertLess(time.perf_counter()-started,.6)
            finally:timer.join()

    def test_worker_waits_for_settlement_and_resumes_without_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);obs=root/'obs';out=root/'out';status=root/'status';priorities=root/'priorities'
            row={'kind':'decision_action',**observation()}
            obs.write_text(json.dumps(row)+'\n',encoding='utf-8')
            command=[sys.executable,str(Path(__file__).with_name('review.py')),'--observations',str(obs),
                     '--output',str(out),'--status',str(status),'--priorities',str(priorities),'--budget-ms','300','--once']
            subprocess.run(command,check=True,capture_output=True)
            self.assertFalse(out.exists(),'do not review while a hand is still being played')
            with obs.open('a',encoding='utf-8') as f:f.write(json.dumps({'kind':'hand_result','handId':'t:h'})+'\n')
            subprocess.run(command,check=True,capture_output=True)
            self.assertEqual(len(out.read_text(encoding='utf-8').splitlines()),1)
            result=json.loads(out.read_text(encoding='utf-8'))
            self.assertEqual(result['status'],'reviewed')
            self.assertFalse(result['quality']['ready'])
            self.assertEqual(result['comparison']['verdict'],'unsupported_model')
            self.assertFalse(priorities.exists(),'unvalidated EV must not become a learning target')
            subprocess.run(command,check=True,capture_output=True)
            self.assertEqual(len(out.read_text(encoding='utf-8').splitlines()),1)


if __name__=='__main__':unittest.main()
