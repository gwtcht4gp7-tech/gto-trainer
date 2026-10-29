import random
import time
import unittest
from fullstreet import policy_quality, rollout
from mccfr import Blueprint
from nlhe import Action, new_hand


class Quality(unittest.TestCase):
    def quality(self, values, frequencies, coverage=None, visits=100):
        return policy_quality([Action(k, 1 if k=='call' else 0) for k in frequencies],
                              values, frequencies, visits,
                              coverage or {'decisions':100,'untrained':0,'underSampled':0})

    def test_known_terminal_comparisons_are_not_blanket_disabled(self):
        q=self.quality([[0]*64,[1]*64],{'fold':0,'call':1})
        self.assertTrue(q['ready'])

    def test_root_coverage_does_not_prove_continuation_coverage(self):
        q=self.quality([[52]*64,[186]*64],{'call':.75,'allin':.25},
                       {'decisions':100,'untrained':95,'underSampled':99},visits=10000)
        self.assertFalse(q['ready']);self.assertIn('unsupported_continuations',q['reasons'])

    def test_free_check_cannot_be_optimal_with_huge_guaranteed_future_loss(self):
        q=self.quality([[-140]*64,[-129]*64],{'check':.907,'bet50':.093})
        self.assertIn('worse_than_check_fold_baseline',q['reasons'])

    def test_call_cost_is_not_the_loss_bound_of_a_bad_future_strategy(self):
        q=self.quality([[0]*64,[-142]*64],{'fold':1,'call':0})
        self.assertIn('worse_than_check_fold_baseline',q['reasons'])

    def test_paired_difference_detects_gap_hidden_by_shared_variance(self):
        noise=[100 if i%2 else -100 for i in range(64)]
        q=self.quality([noise,[x+10 for x in noise]],{'check':1,'bet50':0})
        self.assertIn('policy_value_disagreement',q['reasons'])
        self.assertEqual(q['pairedPolicyGap']['standardErrorBB'],0)

    def test_small_samples_and_root_sample_shortage_are_rejected(self):
        q=self.quality([[0]*2,[1]*2],{'fold':0,'call':1},visits=0)
        self.assertIn('ev_sample_shortage',q['reasons'])
        self.assertIn('root_sample_shortage',q['reasons'])

    def test_rollout_measures_actual_untrained_decisions(self):
        state=new_hand((10,10),0,((0,1),(2,3)),(4,5,6,7,8))
        coverage={'decisions':0,'untrained':0,'underSampled':0}
        rollout(state,Blueprint(),random.Random(1),time.perf_counter()+1,None,coverage)
        self.assertGreater(coverage['decisions'],0)
        self.assertEqual(coverage['untrained'],coverage['decisions'])

    def test_positive_warm_start_regret_does_not_freeze_learning(self):
        from mccfr import Info, OutcomeSampling
        from test_fullstreet import MatchingPennies
        store=Blueprint()
        store.nodes['hidden-penny-0']=Info([7.2,.8],[7.2,.8])
        before=list(store.nodes['hidden-penny-0'].regret)
        trainer=OutcomeSampling(store,seed=12)
        for _ in range(100):trainer.episode(MatchingPennies(),0)
        self.assertNotEqual(store.nodes['hidden-penny-0'].regret,before)
        self.assertGreater(store.nodes['hidden-penny-0'].visits,0)

if __name__=='__main__':unittest.main()
