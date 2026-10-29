"""Independent poker benchmark: exact enumerated best responses in Kuhn poker."""
import itertools
import json
from pathlib import Path
import random
import time
import unittest
from mccfr import Blueprint, OutcomeSampling
from nlhe import Action


class Kuhn:
    n=2;stacks=(1,1);pot=2;street=0
    def __init__(self,cards,history=''):
        self.cards,self.history=cards,history
        self.terminal=history in ('pp','bf','bc','pbf','pbc')
    @property
    def player(self):return len(self.history)%2 if not self.terminal else -1
    def actions(self):
        return tuple(Action(a) for a in ('fc' if self.history.endswith('b') else 'pb'))
    def info_key(self,actions=None):return f'kuhn:{self.cards[self.player]}:{self.history}'
    def step(self,a):return Kuhn(self.cards,self.history+a.label)
    def returns(self):
        if self.history=='bf':value=1
        elif self.history=='pbf':value=-1
        else:value=(1 if self.cards[0]>self.cards[1] else -1)*(2 if self.history.endswith('c') else 1)
        return value,-value


DEALS=list(itertools.permutations(range(3),2))


def expected(state,policy,br_player=None,pure=None):
    if state.terminal:return state.returns()[0]
    key=state.info_key();actions=state.actions()
    probabilities=([1. if i==pure[key] else 0. for i in range(2)]
                   if state.player==br_player else policy.get(key,[.5,.5]))
    return sum(p*expected(state.step(a),policy,br_player,pure) for a,p in zip(actions,probabilities))


def exact_metrics(policy):
    ev=sum(expected(Kuhn(deal),policy) for deal in DEALS)/6
    responses=[]
    for player,histories in [(0,('', 'pb')),(1,('p','b'))]:
        keys=[f'kuhn:{card}:{h}' for card in range(3) for h in histories]
        values=[]
        for choices in itertools.product(range(2),repeat=6):
            pure=dict(zip(keys,choices))
            value=sum(expected(Kuhn(deal),policy,player,pure) for deal in DEALS)/6
            values.append(value if player==0 else -value)
        responses.append(max(values))
    return {'player0EV':ev,'nashValue':-1/18,'bestResponseValues':responses,
            'exploitability':sum(responses)/2}


def benchmark(seed,episodes=100000):
    rng=random.Random(seed);store=Blueprint();search=OutcomeSampling(store,seed)
    started=time.perf_counter()
    for i in range(episodes):search.episode(Kuhn(rng.choice(DEALS)),i%2)
    metrics=exact_metrics({k:node.mean_policy() for k,node in store.nodes.items()})
    return {'seed':seed,'episodes':episodes,'ms':round((time.perf_counter()-started)*1000,1),**metrics}


class IndependentPoker(unittest.TestCase):
    def test_exact_evaluator_recovers_equilibrium_and_value(self):
        policy={}
        for card in range(3):
            bet=[1/3,0.,1.][card];call=[0.,2/3,1.][card]
            policy[f'kuhn:{card}:']=[1-bet,bet]
            policy[f'kuhn:{card}:pb']=[1-call,call]
            bet=[1/3,0.,1.][card];call=[0.,1/3,1.][card]
            policy[f'kuhn:{card}:p']=[1-bet,bet]
            policy[f'kuhn:{card}:b']=[1-call,call]
        metrics=exact_metrics(policy)
        self.assertAlmostEqual(metrics['player0EV'],-1/18)
        self.assertAlmostEqual(metrics['exploitability'],0)

    def test_known_kuhn_equilibrium_with_exact_best_response(self):
        result=benchmark(12,60000)
        self.assertLess(result['exploitability'],.04,result)
        self.assertLess(abs(result['player0EV']+1/18),.025,result)


if __name__=='__main__':
    import sys
    if len(sys.argv)>1 and sys.argv[1]=='--audit':
        rows=[benchmark(seed) for seed in [12,333,777]]
        for row in rows:print(json.dumps(row),flush=True)
        assert all(r['exploitability']<.04 and abs(r['player0EV']+1/18)<.025 for r in rows)
        if len(sys.argv)>2:Path(sys.argv[2]).write_text(json.dumps(rows,indent=2),encoding='utf-8')
    else:unittest.main()
