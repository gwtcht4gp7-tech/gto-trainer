"""Paired, seat-rotated blueprint regression benchmark; not a Nash certificate."""
import argparse
from contextlib import closing
import json
import math
from pathlib import Path
import random
import sqlite3
import time
from mccfr import Blueprint, pick
from nlhe import new_hand
from review import RealtimePriority


def freeze_model(source, target):
    """SQLite backup includes committed WAL transactions; do not copy an open DB file."""
    if Path(source).resolve()==Path(target).resolve() or Path(target).exists():
        raise ValueError('Snapshot target must be new and distinct from source')
    Path(target).parent.mkdir(parents=True,exist_ok=True)
    temporary=Path(target).with_suffix('.snapshot-tmp')
    if temporary.exists():raise ValueError('Incomplete snapshot exists; inspect before retry')
    with closing(sqlite3.connect(Path(source).resolve().as_uri()+'?mode=ro',uri=True,timeout=2)) as src:
        src.execute('BEGIN')
        src.execute('SELECT value FROM meta LIMIT 1').fetchone()
        with closing(sqlite3.connect(temporary)) as dst:src.backup(dst,pages=256,sleep=.05)
    temporary.replace(target)


def play(state, hero, model, opponent, seed, cancel=None):
    rng=random.Random(seed)
    for _ in range(200):
        while cancel and cancel.is_set():time.sleep(.1)
        if state.terminal:return state.returns()[hero]
        actions=state.actions()
        if state.player==hero:
            info=model.get(state.info_key(actions),len(actions))
            selected=actions[pick(info.mean_policy(),rng)]
        elif opponent=='calling':
            selected=next((a for a in actions if a.label in ('check','call')),actions[0])
        elif opponent=='random':
            selected=rng.choice(actions)
        else:raise ValueError('Unknown benchmark opponent')
        state=state.step(selected)
    raise ValueError('Benchmark action depth exceeded')


def evaluate(candidate, reference, deals=256, seed=7182026, cancel=None):
    if deals<2:raise ValueError('Need at least two independent deals')
    new=Blueprint(candidate,readonly=True,limit=10000)
    old=Blueprint(reference,readonly=True,limit=10000)
    rng=random.Random(seed)
    report={}
    def version(store):
        return store.connection.execute('PRAGMA data_version').fetchone()[0] if store.connection else None
    versions=(version(new),version(old))
    try:
        for opponent in ('calling','random'):
            differences=[]
            for _ in range(deals):
                n=rng.choice([2,3,4,5,6]);depth=rng.choice([20.,50.,100.,300.])
                cards=rng.sample(range(52),n*2+5)
                holes=tuple(tuple(sorted(cards[i*2:i*2+2])) for i in range(n))
                state=new_hand((depth,)*n,0,holes,cards[n*2:])
                paired=[]
                for hero in range(n):
                    deal_seed=rng.randrange(2**32)
                    paired.append(play(state,hero,new,opponent,deal_seed,cancel)-play(state,hero,old,opponent,deal_seed,cancel))
                differences.append(sum(paired)/n)
            mean=sum(differences)/deals
            se=math.sqrt(sum((x-mean)**2 for x in differences)/(deals-1)/deals)
            report[opponent]={'independentDeals':deals,'deltaBB100':mean*100,
                              'standardErrorBB100':se*100,'approx95IntervalBB100':[(mean-1.96*se)*100,(mean+1.96*se)*100]}
        return {'kind':'blueprint_evaluation','at':time.time(),'seed':seed,
                'candidate':str(Path(candidate).resolve()) if candidate else 'uniform',
                'reference':str(Path(reference).resolve()) if reference else 'uniform',
                'opponents':report,'blueprintDiskHits':{'candidate':new.hits,'reference':old.hits},
                'modelsChangedDuringEvaluation':versions!=(version(new),version(old)),
                'promotion':'manual_review_required',
                'notes':['固定发牌和随机种子，遍历各座位；按独立发牌分组计算标准误。',
                         '仅评估基础策略，对手为简单固定策略；不包含实时再搜索，不是完整牌力或多人纳什证明。',
                         '未见信息集使用均匀策略；命中不足时结果主要反映回退行为。',
                         '不依据本报告自动替换线上模型。']}
    finally:new.close();old.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--candidate',required=True);parser.add_argument('--reference',required=True)
    parser.add_argument('--output',required=True);parser.add_argument('--deals',type=int,default=256)
    parser.add_argument('--priority');parser.add_argument('--freeze',action='store_true')
    args=parser.parse_args()
    if args.freeze:freeze_model(args.candidate,args.reference)
    out=evaluate(args.candidate,args.reference,args.deals,cancel=RealtimePriority(args.priority))
    Path(args.output).write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'opponents':out['opponents'],'hits':out['blueprintDiskHits'],'promotion':out['promotion']}))
