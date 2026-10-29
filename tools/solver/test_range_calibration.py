import copy
import math
import unittest
import numpy as np

from opponent_model import estimated_range
from range_calibration import log_score, predict, score, summarize
from ranges import parse_card
from test_public_replay import HAND
from public_replay import prefixes


class RangeCalibrationTests(unittest.TestCase):
    def test_analytic_weighted_density_and_blockers(self):
        arr = np.array([[1, 2], [3, 4], [5, 6]])
        self.assertAlmostEqual(log_score(arr, [1, 2, 3], [4, 3], {5}), math.log(2/3))
        with self.assertRaises(ValueError):
            log_score(arr, [1, 2, 3], [5, 6], {5})

    def test_labels_change_score_but_never_prediction(self):
        req = next(r['request'] for r in prefixes(HAND) if r['request']['street'] == 'flop')
        before = copy.deepcopy(req)
        priors = predict(req)
        a = score(req, priors, {'p4': [parse_card('Ah'), parse_card('4h')]})
        b = score(req, priors, {'p4': [parse_card('3s'), parse_card('2c')]})
        self.assertEqual(req, before)
        repeated = predict(req)
        for key in priors:
            np.testing.assert_array_equal(priors[key][1], repeated[key][1])
        self.assertEqual(len(a), len(b))
        self.assertNotEqual(a[0]['modelLogScore'], b[0]['modelLogScore'])

    def test_uniform_log_gain_is_exactly_zero(self):
        req = prefixes(HAND)[0]['request']
        priors = predict(req)
        uniform = {key: (arr, np.ones(len(w))) for key, (arr, w) in priors.items()}
        rows = score(req, uniform, {'p1': [parse_card('Tc'), parse_card('Qc')]})
        self.assertAlmostEqual(rows[0]['gainNats'], 0)

    def test_cluster_not_repeated_snapshot_count(self):
        rows = [dict(hand='a', gainNats=1)]*100 + [dict(hand='b', gainNats=-1)]
        out = summarize(rows)
        self.assertEqual(out['meanHandGainNats'], 0)
        self.assertAlmostEqual(out['handClusterSE'], 1)

    def test_current_model_size_blindness_is_documented(self):
        # Diagnostic regression, not a requirement for future range models.
        player = {'id': 'v', 'pos': 'BB'}
        board = [parse_card(c) for c in ['As', '7h', '2c']]
        small = [dict(playerId='v', action='bet', street='flop', board=['As', '7h', '2c'], amountBB=1)]
        large = copy.deepcopy(small)
        large[0]['amountBB'] = 100
        a, b = estimated_range(player, small, board), estimated_range(player, large, board)
        np.testing.assert_array_equal(a[1], b[1])


if __name__ == '__main__':
    unittest.main(verbosity=2)
