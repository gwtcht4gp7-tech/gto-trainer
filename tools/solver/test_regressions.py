import unittest
import json
import subprocess
from pathlib import Path
import numpy as np
import cfr
from eval7 import eval7
from solve_api import analyze
from opponent_model import estimated_range
from ranges import parse_card


class MathRegression(unittest.TestCase):
    def test_evaluator_against_independent_javascript(self):
        rng = np.random.default_rng(43)
        deals = np.array([rng.choice(52, 9, replace=False) for _ in range(3000)])
        a = deals[:, :7]
        b = np.column_stack((deals[:, :5], deals[:, 7:]))
        # Both implementations see the same rank/suit codes; their numerical
        # score formats differ, so compare win/tie/loss rather than raw scores.
        script = "const E=require('./engine/gto-engine');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(([a,b])=>Math.sign(E.eval7(a)-E.eval7(b))))));"
        result = subprocess.run(['node', '-e', script], cwd=Path(__file__).resolve().parents[2],
                                input=json.dumps(list(zip(a.tolist(), b.tolist()))),
                                text=True, capture_output=True, check=True)
        expected = np.array(json.loads(result.stdout))
        np.testing.assert_array_equal(np.sign(eval7(a)-eval7(b)), expected)

    def test_board_full_house_ties_despite_unused_hole_cards(self):
        hands = [[parse_card(c) for c in cards] for cards in
                 [['As','Ah','Ad','Ks','Kh','2s','3s'], ['As','Ah','Ad','Ks','Kh','4d','5d']]]
        self.assertEqual(*eval7(hands))

    def test_terminal_uses_same_board_for_both_players(self):
        n = cfr.Node(cfr.T_TERM); n.term_type = 0
        n.pot_total = 100; n.inv0 = 10; n.inv1 = 20
        n.eq = np.array([[.8]], np.float32)
        ctx = cfr.context(np.array([[.2]], np.float32), np.array([3]), np.array([12]))
        a, b = cfr._walk(n, np.ones(1), np.ones(1), ctx, None, -1)
        self.assertAlmostEqual(float(a[0]), 70, places=4)
        self.assertAlmostEqual(float(b[0]), 0, places=4)
        self.assertAlmostEqual(float(a[0] + b[0]), 70, places=4)

    def test_blockers_apply_to_showdown_and_fold(self):
        n = cfr.Node(cfr.T_TERM); n.term_type = 0; n.pot_total = 100
        ctx = cfr.context(np.array([[1., 0.]], np.float32), np.array([3]), np.array([5, 12]))
        a, _ = cfr._walk(n, np.ones(1), np.ones(2), ctx, None, -1)
        self.assertEqual(a[0], 0)
        n.term_type = 1; n.winner = 0
        a, _ = cfr._walk(n, np.ones(1), np.ones(2), ctx, None, -1)
        self.assertEqual(a[0], 100)

    def test_legal_pair_conditional_ev_and_priors(self):
        cfg = cfr.Config(max_level=2, max_raises=0)
        root, _ = cfr.build_root(cfg, 1, 3, [], 2, 100, [20, 0], 20, 0, False, True,
                                 np.random.default_rng(1))
        eq = np.array([[1, 1, 0]], np.float32)
        # First opponent combo is illegal; legal weights are 1:3.
        ev = cfr.root_action_evs(root, eq, np.array([3]), np.array([5, 12, 48]), 0,
                                villain_weights=np.array([100, 1, 3]))
        self.assertAlmostEqual(ev[root.labels.index('call')], 10, places=4)
        self.assertEqual(ev[root.labels.index('fold')], 0)

    def test_short_call_refunds_uncalled_chips(self):
        cfg = cfr.Config(max_level=2, max_raises=0)
        root, _ = cfr.build_root(cfg, 1, 1, [], 2, 100, [10, 50], 30, 0, False, True,
                                 np.random.default_rng(1))
        leaf = root.children[root.labels.index('call')]
        self.assertEqual(leaf.pot_total, 90)
        self.assertEqual((leaf.inv0, leaf.inv1), (10, 10))

    def test_average_strategy_uses_own_reach(self):
        n = cfr.Node(cfr.T_DEC); n.nact = 2
        n.regret = np.ones((1, 2)); n.stratsum = np.array([[9., 1.]])
        self.assertAlmostEqual(float(cfr.avg_strategy(n)[0, 0]), .9, places=6)

    def test_history_and_habits_condition_ranges(self):
        board = [parse_card(c) for c in ['2s', '7h', 'Jd']]
        player = {'id': 'p', 'pos': 'BTN'}
        arr, base = estimated_range(player, [], board)
        action = [{'playerId': 'p', 'street': 'preflop', 'action': 'raise', 'board': []}]
        _, raised = estimated_range(player, action, board)
        self.assertFalse(np.allclose(base, raised))
        player['profile'] = {'sampleWeight': .8, 'pfrRate': .45, 'hands': 160}
        _, loose = estimated_range(player, action, board)
        self.assertGreater(loose.mean(), raised.mean())
        action += [{'playerId': 'p', 'street': 'flop', 'action': 'bet', 'board': ['2s','7h','Jd']}]
        _, post = estimated_range(player, action, board)
        self.assertFalse(np.allclose(loose, post))

    def test_multiway_joint_split_and_no_fake_frequencies(self):
        req = {'board': ['As','Ks','Qs','Js','Ts'], 'heroCards': ['2h','3d'],
               'street': 'river', 'pot': 100, 'toCall': 10, 'numPlayers': 5, 'samples': 800}
        result = analyze(req)
        self.assertTrue(result['ok']); self.assertEqual(result['model'], 'multiway_equity')
        self.assertAlmostEqual(result['heroEquity'], .2, places=8)
        self.assertEqual(result['opponentCount'], 4)
        self.assertEqual(result['frequencies'], {})

    def test_bad_pot_not_silently_rewritten(self):
        result = analyze({'board': ['As','Ks','Qs','Js','Ts'], 'heroCards': ['2h','3d'],
                          'street': 'river', 'pot': 1, 'toCall': 10})
        self.assertFalse(result['ok'])

    def test_side_pot_does_not_show_total_pot_odds_or_ev(self):
        result = analyze({'board': ['As','Ks','Qs','Js','Ts'], 'heroCards': ['2h','3d'],
                          'street': 'river', 'pot': 100, 'toCall': 10, 'numPlayers': 3,
                          'hasSidePotRisk': True, 'samples': 500})
        self.assertIsNone(result['potOdds'])
        self.assertIsNone(result['callCheckdownEV'])

    def test_heads_up_nuts_no_fold_and_real_stack(self):
        result = analyze({'board': ['Ts','Js','Qs','2h','3d'], 'heroCards': ['As','Ks'],
                          'street': 'river', 'pot': 100, 'toCall': 20, 'heroStack': 800,
                          'opponents': [{'id': 'v', 'pos': 'BB', 'stackBB': 0}],
                          'iterations': 600, 'historyComplete': True})
        self.assertTrue(result['ok'])
        self.assertAlmostEqual(result['heroEquity'], 1., places=6)
        self.assertGreater(result['frequencies']['call'], .99)
        self.assertAlmostEqual(result['evs']['call'], 100., places=4)
        self.assertAlmostEqual(sum(result['frequencies'].values()), 1., places=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
