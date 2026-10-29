import copy
import unittest
import subprocess
import sys
import numpy as np

from opponent_model import estimated_range
from residual_range import FEATURES, VERSION, features, fit_residual, objective, residual_range
from sized_range import EVENTS, event_name, fit, history_context, sized_range
from ranges import parse_card


class SizedRangeTests(unittest.TestCase):
    def test_context_uses_incremental_raise_after_matching_call(self):
        h = [dict(playerId='a',street='preflop',board=[],action='blind',amountBB=5),
             dict(playerId='b',street='preflop',board=[],action='blind',amountBB=5),
             dict(playerId='a',street='flop',board=['As','7h','2c'],action='bet',amountBB=5),
             dict(playerId='b',street='flop',board=['As','7h','2c'],action='raise',amountBB=15)]
        events = list(history_context(h))
        self.assertEqual(events[0][2], 'bet_1')  # 5 / 10
        self.assertEqual(events[1][2], 'raise_1')  # (15-5)/(15+5)
        self.assertEqual(events[1][-2:], (15, 5))

    def test_training_likelihoods_are_normalized_and_smoothed(self):
        b = [parse_card(c) for c in ['As','7h','2c']]
        m = fit([(b,[parse_card('Ah'),parse_card('Ad')],'bet_0')])
        table = np.array(m['likelihood'])
        np.testing.assert_allclose(table.sum(axis=2), 1)
        self.assertTrue((table>0).all())

    def test_short_call_uses_actual_payment_like_pokerkit_training(self):
        h = [dict(playerId='a',street='preflop',board=[],action='blind',amountBB=5),
             dict(playerId='b',street='preflop',board=[],action='blind',amountBB=5),
             dict(playerId='a',street='flop',board=['As','7h','2c'],action='bet',amountBB=10),
             dict(playerId='b',street='flop',board=['As','7h','2c'],action='call',amountBB=3,moneyLeftBB=0)]
        last = list(history_context(h))[-1]
        self.assertEqual(last[-1],3)
        self.assertEqual(last[2],event_name('call',3,20,3))

    def test_residual_gradient_against_finite_difference(self):
        x = np.array([[1.,0,0,0,0],[-1.,1,0,0,0]])
        examples = [(np.array([.3,.7]), x, x[0], 1.)]
        theta = np.array([.2,-.1,0,0,0])
        _, gradient = objective(theta, examples)
        for i in range(5):
            d = np.eye(5)[i]*1e-5
            numerical = (objective(theta+d,examples)[0]-objective(theta-d,examples)[0])/2e-5
            self.assertAlmostEqual(gradient[i], numerical, places=7)

    def test_fit_improves_known_conditional_label(self):
        x = np.array([[1.,0,0,0,0],[-1.,0,0,0,0]])
        m = fit_residual([(np.array([.5,.5]),x,x[0],1.)])
        self.assertGreater(m['theta'][0],0)
        self.assertLess(m['finalObjective'],m['initialObjective'])
        self.assertLessEqual(max(abs(t) for t in m['theta']),2)

    def test_zero_correction_preserves_original_probabilities(self):
        p = dict(id='a',pos='BB')
        b = [parse_card(c) for c in ['As','7h','2c']]
        a,w = estimated_range(p,[],b)
        aa,ww = residual_range(p,[],b,dict(version=VERSION,features=FEATURES,theta=[0]*5))
        np.testing.assert_array_equal(a,aa)
        np.testing.assert_allclose(w/w.sum(),ww/ww.sum(),rtol=1e-6)

    def test_sizes_change_candidate_but_do_not_mutate_history(self):
        p = dict(id='a',pos='BB')
        b = [parse_card(c) for c in ['As','7h','2c']]
        h = [dict(playerId='a',street='preflop',board=[],action='blind',amountBB=5),
             dict(playerId='b',street='preflop',board=[],action='blind',amountBB=5),
             dict(playerId='a',street='flop',board=['As','7h','2c'],action='bet',amountBB=1)]
        large = copy.deepcopy(h)
        large[-1]['amountBB'] = 100
        frozen = copy.deepcopy(h)
        m = dict(version=VERSION,features=FEATURES,theta=[1,0,0,0,0])
        a,w = residual_range(p,h,b,m)
        aa,ww = residual_range(p,large,b,m)
        self.assertEqual(h,frozen)
        self.assertFalse(np.allclose(w/w.sum(),ww/ww.sum()))
        self.assertFalse(np.isin(a,b).any())

    def test_bad_model_fails_instead_of_inventing_range(self):
        with self.assertRaises(ValueError):
            residual_range(dict(id='a',pos='BB'),[],[],dict(version=VERSION,features=FEATURES,theta=[float('nan')]*5))

    def test_inference_does_not_import_training_or_pokerkit(self):
        result = subprocess.run([sys.executable,'-B','-c',
                                 "import residual_range,sys; assert 'pokerkit' not in sys.modules; assert 'train_sized_range' not in sys.modules"],
                                capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
