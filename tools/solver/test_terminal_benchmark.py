import copy
import unittest

import numpy as np

from opponent_model import joint_equity
from terminal_benchmark import benchmark_case, exact_reference, generate_cases, parse_case, stress_cases, summarize


def tied_case():
    return {'id': 'tie', 'group': 'stress', 'board': ['As', 'Ks', 'Qs', 'Js', 'Ts'],
            'heroCards': ['2h', '3d'], 'heroCommittedBB': 0., 'heroStackBB': 100.,
            'toCallBB': 10., 'deadPotBB': 0., 'potBB': 20., 'referenceOpponent': 0,
            'opponents': [{'id': 'v0', 'stackBB': 0., 'committedBB': 10.,
                           'range': [{'cards': ['4h', '5d'], 'weight': 1.}]},
                          {'id': 'v1', 'stackBB': 0., 'committedBB': 10.,
                           'range': [{'cards': ['6h', '7d'], 'weight': 1.}]}]}


class TerminalBenchmarkTests(unittest.TestCase):
    def test_full_board_tie_exact_call_ev_zero(self):
        case = tied_case()
        result = benchmark_case(case, [1], samples=100, holdout=100)
        self.assertAlmostEqual(result['exactEquity'], 1/3)
        self.assertAlmostEqual(result['exactCallEVBB'], 0)
        self.assertAlmostEqual(result['rows'][0]['jointRegretBB'], 0)

    def test_invalid_financial_domains_rejected(self):
        for patch in ({'potBB': 30.}, {'heroStackBB': 5.}, {'toCallBB': -1.}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                parse_case({**tied_case(), **patch})
        case = tied_case()
        case['opponents'][0]['committedBB'] = 5
        with self.assertRaises(ValueError):
            parse_case(case)
        case = tied_case()
        case['opponents'][0]['stackBB'] = 1
        with self.assertRaises(ValueError):
            parse_case(case)

    def test_weighted_joint_rejects_entire_conflicting_deal(self):
        case = tied_case()
        case['board'] = ['2s', '3c', '7h', '9d', 'Jc']
        case['heroCards'] = ['4h', '5h']
        case['opponents'][0]['range'] = [
            {'cards': ['As', 'Ah'], 'weight': 1}, {'cards': ['Ks', 'Kh'], 'weight': 3}]
        case['opponents'][1]['range'] = [
            {'cards': ['As', 'Ad'], 'weight': 2}, {'cards': ['Qs', 'Qh'], 'weight': 5}]
        hero, board, estimates = parse_case(case)
        shares, weights = exact_reference(case, hero, board, estimates)
        self.assertEqual(len(weights), 3)
        np.testing.assert_allclose(weights, np.array([5, 6, 15]) / 26)
        mc = joint_equity(hero, board, case['opponents'], [], samples=100, seed=3,
                          range_estimates=estimates, compare_opponent=0)
        self.assertEqual(mc['heroEquity'], 0.)

    def test_headsup_control_uses_identical_actions_and_regret(self):
        for case in generate_cases(count=4):
            if len(case['opponents']) == 1:
                result = benchmark_case(case, [1, 2], samples=100, holdout=100)
                for row in result['rows']:
                    self.assertEqual(row['headsUpAction'], row['jointAction'])
                    self.assertEqual(row['exactPairedGainBB'], 0)

    def test_cohort_frozen_before_outcomes_and_contains_each_player_count(self):
        a, b = generate_cases(count=48), generate_cases(count=48)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 48)
        self.assertEqual({len(c['opponents']) + 1 for c in a}, {2, 3, 5, 6})
        for case in a:
            parse_case(case)

    def test_summary_clusters_by_scenario_not_heldout_hands(self):
        results = [{'rows': [{'exactPairedGainBB': 1, 'headsUpRegretBB': 1,
                              'jointRegretBB': 0, 'headsUpAction': 'call', 'jointAction': 'fold',
                              'inProcessEstimateAndDecisionMs': 10}] * 3},
                   {'rows': [{'exactPairedGainBB': 3, 'headsUpRegretBB': 3,
                              'jointRegretBB': 0, 'headsUpAction': 'call', 'jointAction': 'fold',
                              'inProcessEstimateAndDecisionMs': 10}] * 3}]
        out = summarize(results)
        self.assertEqual(out['scenarios'], 2)
        self.assertEqual(out['scenarioMeanExactPairedGainBB'], 2)
        self.assertAlmostEqual(out['scenarioClusterSE'], 1)

    def test_explicit_ranges_reject_invalid_weights_and_cards(self):
        case = tied_case()
        hero, board, estimates = parse_case(case)
        estimates[0] = (np.array([[8, 8]]), np.array([1.]))
        with self.assertRaises(ValueError):
            joint_equity(hero, board, case['opponents'], [], samples=100, range_estimates=estimates)

    def test_nonconstant_payoffs_detect_wrong_joint_sampling_weights(self):
        case = tied_case()
        case['board'] = ['2s', '3c', '7h', '9d', 'Jc']
        case['heroCards'] = ['As', 'Ah']
        case['opponents'][0]['range'] = [
            {'cards': ['Js', 'Jh'], 'weight': 1}, {'cards': ['Ks', 'Kh'], 'weight': 3}]
        case['opponents'][1]['range'] = [
            {'cards': ['Js', 'Jd'], 'weight': 2}, {'cards': ['Qs', 'Qh'], 'weight': 5}]
        hero, board, estimates = parse_case(case)
        shares, weights = exact_reference(case, hero, board, estimates)
        # Js collision excludes the 1*2 losing deal; only KK/QQ wins: 15/26.
        self.assertAlmostEqual(float(shares @ weights), 15/26)
        mc = joint_equity(hero, board, case['opponents'], [], samples=20000, seed=8,
                          range_estimates=estimates, compare_opponent=0)
        self.assertLess(abs(mc['heroEquity'] - 15/26), .015)

    def test_stress_cases_have_independently_derived_threshold_values(self):
        for case, weight in zip(stress_cases(), [1.01, 1., .99]):
            hero, board, estimates = parse_case(case)
            shares, probabilities = exact_reference(case, hero, board, estimates)
            self.assertAlmostEqual(float(shares @ probabilities), 1/(1 + 2*weight))


if __name__ == '__main__':
    unittest.main(verbosity=2)
