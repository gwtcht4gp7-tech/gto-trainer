import json
import random
import tempfile
import threading
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path
import unittest
import numpy as np
from eval7 import eval7
from ranges import parse_card
from nlhe import Action, State, new_hand, rank7
from mccfr import Blueprint, OutcomeSampling, Interrupted
from fullstreet import Root, IncompleteState, analyze_full


def request():
    return {'street':'preflop','board':[],'heroCards':['As','Kh'], 'heroId':'hero',
            'pot':1.5,'toCall':1.,'minRaiseBB':1.,'dealerSeat':9,'numPlayers':3,
            'historyComplete':True,'bbChips':100,
            'playersContext':[
                {'id':'sb','seat':1,'pos':'SB','stackBB':99.5,'wagerBB':.5,'folded':False},
                {'id':'bb','seat':3,'pos':'BB','stackBB':99.,'wagerBB':1.,'folded':False},
                {'id':'hero','seat':9,'pos':'BTN','stackBB':100.,'wagerBB':0.,'folded':False}],
            'history':[{'playerId':'sb','street':'preflop','action':'blind','amountBB':.5},
                       {'playerId':'bb','street':'preflop','action':'blind','amountBB':1.}]}


class Rules(unittest.TestCase):
    def test_confirmed_live_entry_blind_can_check(self):
        req=request();req['pot']=2.5;req['toCall']=0
        req['playersContext'][2].update(stackBB=99.,wagerBB=1.)
        req['history'].append({'playerId':'hero','street':'preflop','action':'ante','amountBB':1.,
                              'liveAmountBB':1.,'liveEvidence':'captured_pre_action_wager'})
        root=Root(req,time.perf_counter()+2);state,_=root.deal(True)
        self.assertEqual(state.bets[root.hero],1.)
        self.assertEqual(state.committed[root.hero],1.)
        self.assertEqual(state.actions()[0].label,'check')
        req['history'][-1]['liveAmountBB']=0
        with self.assertRaises(IncompleteState):Root(req,time.perf_counter()+2)

    def test_true_dead_ante_does_not_reduce_call(self):
        req=request();req['pot']=2.5
        req['playersContext'][2]['stackBB']=99.
        req['history'].append({'playerId':'hero','street':'preflop','action':'ante','amountBB':1.,'liveAmountBB':0.})
        root=Root(req,time.perf_counter()+2);state,_=root.deal(True)
        self.assertEqual(state.bets[root.hero],0.)
        self.assertEqual(state.committed[root.hero],1.)
        self.assertEqual(next(a.amount for a in state.actions() if a.label=='call'),1.)

    def test_live_post_cannot_exceed_investment(self):
        req=request();req['history'].append({'playerId':'hero','street':'preflop','action':'ante',
                                           'amountBB':0.,'liveAmountBB':1.})
        with self.assertRaises(IncompleteState):Root(req,time.perf_counter()+2)

    def test_fast_evaluator_agrees_with_vector_evaluator(self):
        rng=random.Random(18)
        a=[tuple(sorted(rng.sample(range(52),7))) for _ in range(3000)]
        b=[tuple(sorted(rng.sample(range(52),7))) for _ in range(3000)]
        actual=[(rank7(x)>rank7(y))-(rank7(x)<rank7(y)) for x,y in zip(a,b)]
        np.testing.assert_array_equal(actual,np.sign(eval7(a)-eval7(b)))

    def terminal(self, paid, folded=(False,False,False)):
        board=tuple(parse_card(c) for c in ['2h','3d','7s','9c','Jd'])
        holes=tuple(tuple(parse_card(c) for c in hand) for hand in [('Kc','Qh'),('Ac','Ad'),('Js','Jh')])
        return State((0,0,0),tuple(paid),(0,0,0),folded,0,3,(),0,1,(-1,-1,-1),False,board,board,holes,terminal=True)

    def test_layered_side_pots_and_uncalled_refund(self):
        s=self.terminal([100,50,20])
        self.assertEqual(s.payouts(),[50,60,60])
        self.assertEqual(s.returns(),(-50,10,40))
        self.assertAlmostEqual(sum(s.returns()),0)

    def test_folded_player_cannot_win_contested_pot(self):
        s=self.terminal([100,50,20],(False,False,True))
        self.assertEqual(s.payouts(),[50,120,0])

    def test_royal_board_five_way_split(self):
        board=tuple(parse_card(c) for c in ['As','Ks','Qs','Js','Ts'])
        holes=((1,2),(3,4),(5,6),(7,8),(9,10))
        s=State((0,)*5,(10,)*5,(0,)*5,(False,)*5,0,3,(),0,1,(-1,)*5,False,board,board,holes,terminal=True)
        self.assertEqual(s.payouts(),[10]*5)

    def test_hu_preflop_and_postflop_order(self):
        s=new_hand((100,100),0,((0,1),(2,3)),(4,5,6,7,8))
        self.assertEqual(s.player,0)
        s=s.step(next(a for a in s.actions() if a.label=='call'))
        s=s.step(next(a for a in s.actions() if a.label=='check'))
        self.assertEqual(s.street,1);self.assertEqual(s.player,1)

    def test_short_allin_does_not_reopen_but_cumulative_raise_does(self):
        s=self.terminal([10,10,10])
        s=replace(s,terminal=False,pending=(0,1,2),stacks=(100,100,100),bets=(10,15,15),
                  street=2,price=15,min_raise=10,acted_price=(10,-1,-1),full_bet=True)
        self.assertEqual([a.label for a in s.actions()],['fold','call'])
        s=replace(s,price=20,bets=(10,20,20))
        self.assertTrue(any(a.label.startswith('raise') for a in s.actions()))

    def test_bets_cannot_exceed_largest_callable_opponent_stack(self):
        s=new_hand((1000,10),0,((0,1),(2,3)),(4,5,6,7,8))
        self.assertLessEqual(max(a.amount for a in s.actions()),9.5)

    def test_raise_over_short_opening_adds_a_full_minimum_increment(self):
        s=self.terminal([0,.5,0])
        s=replace(s,terminal=False,pending=(0,2),stacks=(100,0,100),bets=(0,.5,0),
                  street=1,price=.5,min_raise=1,acted_price=(-1,-1,-1),full_bet=False)
        action=next(a for a in s.actions() if a.label.startswith('raise'))
        self.assertAlmostEqual(action.amount,1.5)
        following=s.step(action)
        self.assertAlmostEqual(following.min_raise,1.)

    def test_information_key_hides_opponent_cards_and_future_runout(self):
        s=new_hand((100,)*3,0,((0,1),(2,3),(4,5)),(6,7,8,9,10))
        p=s.player
        holes=list(s.holes);holes[(p+1)%3]=(20,21)
        t=replace(s,holes=tuple(holes),runout=(30,31,32,33,34))
        self.assertEqual(s.info_key(),t.info_key())

    def test_random_full_games_conserve_chips(self):
        rng=random.Random(7); streets=set()
        for n in range(2,7):
            for _ in range(100):
                cards=rng.sample(range(52),2*n+5)
                stacks=tuple(rng.choice([.3,2,20,100,1000]) for _ in range(n))
                s=new_hand(stacks,0,[tuple(cards[2*i:2*i+2]) for i in range(n)],cards[2*n:])
                for depth in range(200):
                    streets.add(s.street)
                    self.assertAlmostEqual(sum(s.stacks)+s.pot,sum(stacks),places=5)
                    if s.terminal:break
                    s=s.step(rng.choice(s.actions()))
                self.assertTrue(s.terminal)
                self.assertAlmostEqual(sum(s.payouts()),s.pot,places=5)
                self.assertAlmostEqual(sum(s.returns()),0.,places=5)
        self.assertEqual(streets,{0,1,2,3})


class MatchingPennies:
    n=3;stacks=(1,1,1);pot=0;street=0
    def __init__(self,moves=()):self.moves=moves;self.terminal=len(moves)==3
    @property
    def player(self):return len(self.moves)
    def actions(self):return (Action('left'),Action('right'))
    def info_key(self,actions=None):return 'hidden-penny-'+str(self.player)
    def step(self,action):return MatchingPennies(self.moves+(action.label,))
    def returns(self):
        reward=1 if self.moves[0]==self.moves[1] else -1
        return (reward,-reward,0)


class Learning(unittest.TestCase):
    def test_three_player_sampling_converges_on_known_small_game(self):
        store=Blueprint();trainer=OutcomeSampling(store,seed=12)
        for i in range(30000):trainer.episode(MatchingPennies(),i%3)
        for p in [0,1]:
            probability=store.nodes['hidden-penny-'+str(p)].mean_policy()[0]
            self.assertLess(abs(probability-.5),.08)

    def test_checkpoint_resume_and_bounded_warm_start(self):
        with tempfile.TemporaryDirectory() as directory:
            file=str(Path(directory)/'blueprint.sqlite')
            store=Blueprint(file);node=store.get('example',2)
            node.regret[:]=[4,0];node.average[:]=[9,1];node.visits=20
            store.dirty.add('example');store.checkpoint(500);store.close()
            resumed=Blueprint(file)
            self.assertEqual(resumed.get('example',2).visits,20);resumed.close()
            inference=Blueprint(file,readonly=True)
            self.assertAlmostEqual(inference.get('example',2).mean_policy()[0],.9)
            self.assertEqual(inference.prior_visits['example'],20);inference.close()

    def test_bad_ledger_is_rejected(self):
        req=request();req['pot']=20
        with self.assertRaises(IncompleteState):Root(req,time.perf_counter()+1)

    def test_root_uses_actual_private_cards_not_only_a_hand_bucket(self):
        factory=Root(request(),time.perf_counter()+1)
        state,_=factory.deal(fixed_hero=True)
        holes=list(state.holes);holes[state.player]=(parse_card('Ah'),parse_card('Kc'))
        alternative=replace(state,holes=tuple(holes))
        self.assertNotEqual(state.info_key(),alternative.info_key())
        self.assertEqual(state.info_key(exact=False),alternative.info_key(exact=False))

    def test_offline_training_resumes_and_yields_to_realtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);model=root/'model.sqlite';status=root/'status.json';priority=root/'priority'
            command=[sys.executable,str(Path(__file__).with_name('train.py')),'--model',str(model),
                     '--status',str(status),'--priority',str(priority),'--seconds','.6']
            subprocess.run(command,check=True,capture_output=True,timeout=5)
            first=json.loads(status.read_text())['episodes']
            self.assertGreater(first,0)
            subprocess.run(command,check=True,capture_output=True,timeout=5)
            second=json.loads(status.read_text())['episodes']
            self.assertGreater(second,first)
            priority.write_text(str(time.time()+5))
            subprocess.run(command,check=True,capture_output=True,timeout=5)
            self.assertEqual(json.loads(status.read_text())['episodes'],second)

    def test_interruption_does_not_update_half_episode(self):
        store=Blueprint();trainer=OutcomeSampling(store)
        with self.assertRaises(Interrupted):trainer.episode(MatchingPennies(),0,deadline=0)
        self.assertEqual(trainer.episodes,0)
        self.assertFalse(any(n.visits for n in store.nodes.values()))

    def test_live_search_is_bounded_and_returns_fullstreet_diagnostics(self):
        req=request();req['timeBudgetMs']=250
        start=time.perf_counter();result=analyze_full(req)
        self.assertLess(time.perf_counter()-start,1.)
        self.assertTrue(result['ok']);self.assertGreater(result['iterations'],0)
        self.assertEqual(result['model'],'multiplayer_fullstreet_mccfr_approx')
        self.assertGreater(result['evSamplesPerAction'],0)
        if not result['recommendationReady']:
            self.assertIsNone(result['bestAction'])
            self.assertIsNone(result['bestEv'])
            self.assertFalse(result['evs'])
            self.assertFalse(result['frequencies'])
            self.assertTrue(result['diagnostics']['evs'])
        if result['frequencies']:
            self.assertAlmostEqual(sum(result['frequencies'].values()),1.,places=6)


if __name__=='__main__':unittest.main(verbosity=2)
