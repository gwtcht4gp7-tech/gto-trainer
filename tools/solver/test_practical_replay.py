import ctypes
import json
import os
import subprocess
import sys
from types import SimpleNamespace
import unittest

from opponent_model import joint_equity
from practical_replay import ROOT, audit_action, engine_state, evaluate, guarded_preview, run_case, side_pot_status, terminate_tree, validate
from ranges import parse_card


def request():
    return {'street': 'river', 'heroCards': ['2h', '3d'],
            'board': ['As', 'Ks', 'Qs', 'Js', 'Ts'], 'heroId': 'h', 'heroPos': 'BTN',
            'pot': 100, 'toCall': 10, 'heroStack': 100, 'numPlayers': 3,
            'opponents': [{'id': 'v1', 'pos': 'SB', 'stackBB': 100},
                          {'id': 'v2', 'pos': 'BB', 'stackBB': 100}], 'history': []}


class PracticalReplayTests(unittest.TestCase):
    def test_paired_tied_board_has_exact_shares(self):
        req = request()
        out = joint_equity([parse_card(c) for c in req['heroCards']],
                           [parse_card(c) for c in req['board']], req['opponents'], [],
                           samples=100, seed=8, compare_opponent=1)
        self.assertAlmostEqual(out['heroEquity'], 1/3)
        ref = out['headsUpReference']
        self.assertEqual(ref['equity'], .5)
        self.assertAlmostEqual(ref['pairedEquityDifference'], -1/6)
        self.assertLess(ref['pairedStandardError'], 1e-15)
        self.assertEqual(ref['opponentId'], 'v2')

    def test_deterministic_equity_with_same_seed(self):
        req = request()
        req['board'] = ['As', '7h', 'Jd']
        a = joint_equity([0, 5], [parse_card(c) for c in req['board']], req['opponents'], [],
                         samples=100, seed=9, compare_opponent=0)
        b = joint_equity([0, 5], [parse_card(c) for c in req['board']], req['opponents'], [],
                         samples=100, seed=9, compare_opponent=0)
        self.assertEqual(a, b)
        self.assertLessEqual(a['heroEquity'], a['headsUpReference']['equity'])

    def test_invalid_accounting_is_not_rewritten(self):
        for patch in ({'pot': 1}, {'pot': float('nan')}, {'heroStack': -1},
                      {'numPlayers': 4}, {'heroCards': ['As', '3d']},
                      {'numPlayers': 3.5}, {'pot': '100'}, {'heroStack': True}):
            req = {**request(), **patch}
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate(req)
        req = {**request(), 'pot': 10, 'toCall': 10}
        validate(req)
        self.assertEqual(req['pot'], 10)  # No guessing that this is an exclusive pot.

    def test_future_actions_and_boards_rejected(self):
        req = request()
        req['history'] = [{'street': 'river', 'board': ['As', 'Ks', 'Qs', 'Js', '9s']}]
        with self.assertRaises(ValueError):
            validate(req)
        req['street'], req['board'] = 'flop', ['As', 'Ks', 'Qs']
        req['history'] = [{'street': 'turn', 'board': ['As', 'Ks', 'Qs', 'Js']}]
        with self.assertRaises(ValueError):
            validate(req)

    def test_side_pot_retains_no_actionable_ev(self):
        req = {**request(), 'hasSidePotRisk': True}
        out = evaluate(req, 2, 100)
        self.assertTrue(out['sidePotRisk'])
        self.assertIsNone(out['pairedCheckdownEVDifference'])
        self.assertTrue(all(not v['publishable'] for v in out['variants'].values()))

    def test_unflagged_short_allin_and_unknown_eligibility_detected(self):
        req = request()
        state = SimpleNamespace(committed=[10, 5, 20], stacks=[100, 0, 80], folded=[False] * 3)
        factory = SimpleNamespace(template=state, hero=0)
        risky, why = side_pot_status(req, 10, 100, req['opponents'], factory)
        self.assertTrue(risky)
        self.assertIn('unequal', why)
        self.assertTrue(side_pot_status(req, 10, 100, req['opponents'], None)[0])
        state.committed = [10, 20, 20]
        self.assertFalse(side_pot_status(req, 10, 100, req['opponents'], factory)[0])

    def test_same_street_future_action_and_future_profile_rejected(self):
        req = request()
        req['at'] = '2026-10-28T00:00:00Z'
        req['history'] = [{'street': 'river', 'board': req['board'], 'at': '2026-10-28T00:00:01Z'}]
        with self.assertRaises(ValueError):
            validate(req)
        req['history'] = []
        req['opponents'][0]['profile'] = {'lastSeen': '2026-10-28T00:00:01Z'}
        with self.assertRaises(ValueError):
            validate(req)

    def test_injected_equity_is_used_and_invalid_values_rejected(self):
        script = """const E=require('./engine/gto-engine');
        const s={street:'flop',hero:{cards:['4d','6d'],pos:'BTN'},board:['Ks','Qs','Jh'],pot:10,toCall:2.5};
        const a=E.advise(s,.01),b=E.advise(s,.9);
        if(a.metrics.equity!==.01||b.metrics.equity!==.9)throw Error('equity ignored');
        for(const x of [NaN,Infinity,-.1,1.1,'0.5',null]){
          let rejected=false;try{E.advise(s,x)}catch(e){rejected=true}if(!rejected)throw Error('bad equity accepted');
        }console.log(JSON.stringify([a.action,b.action]));"""
        r = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(r.stdout), ['fold', 'call'])

    def test_deep_allin_is_flagged_without_banning_legal_allins(self):
        req = {**request(), 'pot': 2, 'toCall': 1}
        self.assertIn('unvalidated_deep_commitment', audit_action({'action': 'allin'}, req, 400)['flags'])
        self.assertNotIn('unvalidated_deep_commitment', audit_action({'action': 'allin'}, req, 20)['flags'])

    def test_preflop_depth_preserved_and_raises_from_history(self):
        req = {**request(), 'street': 'preflop', 'board': [], 'heroCards': ['Ac', 'Js']}
        req['history'] = [{'street': 'preflop', 'playerId': 'v2', 'action': 'raise', 'board': []}]
        state = engine_state(req, 396, req['opponents'])
        self.assertEqual(state['raiseCount'], 1)
        self.assertEqual(state['villainOpenPos'], 'BB')
        self.assertGreater(state['effectiveStack'], 30)

    def test_parent_deadline_discards_advice(self):
        out = run_case(request(), 1, 20000, 50)
        self.assertEqual(out['status'], 'timed_out')
        self.assertNotIn('variants', out)

    def test_terminal_sampling_margin_is_not_a_definite_action(self):
        req = request()
        req.update(pot=40, toCall=20)
        for p in req['opponents']:
            p['stackBB'] = 0
        out = guarded_preview({'action': 'raise'}, [], req, 100, False, 1/3, .01)
        self.assertFalse(out['ready'])
        self.assertIsNone(out['action'])
        out = guarded_preview({'action': 'raise'}, [], req, 100, False, .7, .01)
        self.assertEqual((out['action'], out['additionalBB']), ('call', 20))
        self.assertGreater(out['sampling95IntervalBB'][0], 0)

    def test_oversized_heuristic_is_rejected_instead_of_clamped_to_shove(self):
        req = request()
        decision = {'action': 'raise', 'sizing': {'absolute': 119}}
        out = guarded_preview(decision, [decision]*2, req, 65, False, .7, .01)
        self.assertFalse(out['ready'])
        self.assertIsNone(out['action'])

    def test_subminimum_bet_is_legalized_but_sampling_sensitive_action_is_not(self):
        req = {**request(), 'pot': 2, 'toCall': 0, 'minRaiseBB': 1}
        decision = {'action': 'bet', 'sizing': {'absolute': .66}}
        out = guarded_preview(decision, [decision]*2, req, 100, False, .7, .01)
        self.assertEqual((out['action'], out['additionalBB']), ('bet', 1))
        out = guarded_preview(decision, [{'action': 'check'}, decision], req, 100, False, .7, .01)
        self.assertFalse(out['ready'])
        self.assertIn('sampling_interval_changes_heuristic_action', out['reasons'])

    def test_free_check_and_closed_heads_up_river_fallback(self):
        req = {**request(), 'toCall': 0}
        out = guarded_preview({'action': 'fold'}, [], req, 100, False, .1, .01)
        self.assertEqual((out['action'], out['additionalBB']), ('check', 0))
        req.update(numPlayers=2, toCall=35, pot=70)
        req['opponents'] = req['opponents'][:1]
        decision = {'action': 'raise', 'sizing': {'absolute': 119}}
        out = guarded_preview(decision, [decision]*2, req, 83, False, .7, .01)
        self.assertEqual((out['action'], out['additionalBB']), ('call', 35))
        self.assertFalse(out['raisingEvaluated'])

    def test_timeout_cleanup_terminates_owned_node_child(self):
        code = "import subprocess,time;p=subprocess.Popen(['node','-e','setInterval(()=>{},1000)']);print(p.pid,flush=True);time.sleep(60)"
        process = subprocess.Popen([sys.executable, '-u', '-c', code], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=os.name != 'nt')
        child = int(process.stdout.readline())
        handle = None
        try:
            if os.name == 'nt':
                kernel = ctypes.windll.kernel32
                kernel.OpenProcess.restype = ctypes.c_void_p
                kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
                kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                handle = kernel.OpenProcess(0x100000, False, child)
                self.assertTrue(handle)
            terminate_tree(process)
            if handle:
                self.assertEqual(kernel.WaitForSingleObject(handle, 2000), 0)
            self.assertIsNotNone(process.poll())
        finally:
            if process.poll() is None:
                terminate_tree(process)
            if handle:
                kernel.CloseHandle(handle)
            process.stdout.close()
            process.stderr.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
