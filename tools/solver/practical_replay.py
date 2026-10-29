"""Offline paired replay. No service, model, player database, or training writes.

Both variants use the SAME heuristic, public history, joint deals and runouts.
Only showdown shares change: one named opponent versus all active opponents.
This measures a modelling difference, not counterfactual profit or GTO strength.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
CARD = re.compile(r'^[2-9TJQKA][shdc]$')


def validate(req):
    """Reject inconsistent inputs; never fill the pot or invent missing players."""
    cards = req.get('heroCards', []) + req.get('board', [])
    if len(req.get('heroCards', [])) != 2 or any(not isinstance(c, str) or not CARD.fullmatch(c) for c in cards):
        raise ValueError('Invalid cards')
    if len(set(cards)) != len(cards):
        raise ValueError('Repeated cards')
    if len(req.get('board', [])) != {'preflop': 0, 'flop': 3, 'turn': 4, 'river': 5}.get(req.get('street')):
        raise ValueError('Street and board disagree')
    pot, call = req['pot'], req.get('toCall', 0)
    stack = req.get('heroStack', req.get('stackBB', req.get('effectiveStack', float('nan'))))
    if any(type(x) not in (int, float) for x in (pot, call, stack)):
        raise ValueError('Money fields must be JSON numbers')
    if not all(math.isfinite(x) for x in (pot, call, stack)) or pot <= 0 or min(call, stack) < 0 or call > pot:
        raise ValueError('Invalid pot, call or stack; pot must already include wagers')
    opponents = req.get('opponents', [])
    if type(req['numPlayers']) is not int or not 2 <= req['numPlayers'] <= 10 or not opponents or len(opponents) != req['numPlayers'] - 1:
        raise ValueError('Active opponent list and player count disagree')
    ids = [str(p['id']) for p in opponents]
    if len(set(ids)) != len(ids) or str(req.get('heroId')) in ids:
        raise ValueError('Repeated player IDs')
    for p in opponents:
        x = p['stackBB']
        if type(x) not in (int, float) or not math.isfinite(x) or x < 0:
            raise ValueError('Invalid opponent stack')
    streets = {'preflop': 0, 'flop': 3, 'turn': 4, 'river': 5}
    for action in req.get('history', []):
        size = streets.get(action.get('street'))
        if size is None or size > len(req['board']):
            raise ValueError('Future or invalid history street')
        if action.get('board', []) != req['board'][:size]:
            raise ValueError('History board is not the observed public board')
        if action.get('at') and req.get('at'):
            from datetime import datetime
            if datetime.fromisoformat(action['at'].replace('Z', '+00:00')) > datetime.fromisoformat(req['at'].replace('Z', '+00:00')):
                raise ValueError('History contains actions after the decision timestamp')
    for player in opponents:
        seen = (player.get('profile') or {}).get('lastSeen')
        if seen and req.get('at'):
            from datetime import datetime
            if datetime.fromisoformat(seen.replace('Z', '+00:00')) > datetime.fromisoformat(req['at'].replace('Z', '+00:00')):
                raise ValueError('Player profile contains future observations')
    factory = None
    if req.get('historyComplete') and req.get('playersContext'):
        # Reuse accounting validation only; do not run MCCFR or open a blueprint.
        from fullstreet import Root
        factory = Root(req, time.perf_counter() + 2)
        people = factory.people
        active = {str(p['id']): p for i, p in enumerate(people)
                  if not factory.template.folded[i] and i != factory.hero}
        if set(ids) != set(active):
            raise ValueError('Active opponents and complete ledger disagree')
        if abs(stack - factory.template.stacks[factory.hero]) > 1e-6:
            raise ValueError('Hero stack and complete ledger disagree')
        if any(abs(p['stackBB'] - active[str(p['id'])]['stackBB']) > 1e-6 for p in opponents):
            raise ValueError('Opponent stack and complete ledger disagree')
    return pot, call, stack, opponents, factory


def side_pot_status(req, call, stack, opponents, factory):
    if req.get('hasSidePotRisk') or call > stack:
        return True, 'reported_or_short_call'
    if factory is None:
        return True, 'eligibility_unknown_without_complete_ledger'
    state = factory.template
    after = list(state.committed)
    after[factory.hero] += min(call, stack)
    active = [i for i, folded in enumerate(state.folded) if not folded]
    unequal = max(after[i] for i in active) - min(after[i] for i in active) > 1e-6
    if max(after) > after[factory.hero] + 1e-6 or (unequal and any(state.stacks[i] == 0 for i in active)):
        return True, 'unequal_allin_or_ineligible_contributions'
    return False, 'complete_ledger_no_detected_side_pot'


def engine_state(req, stack, opponents):
    history = req.get('history') or []
    raises = [a for a in history if a.get('street') == 'preflop' and a.get('action') in ('bet', 'raise')]
    return dict(street=req['street'], board=req['board'], pot=req['pot'], toCall=req.get('toCall', 0),
                hero=dict(cards=req['heroCards'], pos=req.get('heroPos', 'BTN'), stack=stack,
                          invested=req.get('heroWagerBB', 0)),
                effectiveStack=min(stack, max(float(p['stackBB']) + float(req.get('toCall', 0)) for p in opponents)),
                villainPos=opponents[0].get('pos', 'BB'),
                villainOpenPos=next((p.get('pos', 'BB') for p in opponents
                                     if raises and str(p['id']) == str(raises[0]['playerId'])), None),
                raiseCount=len(raises), numPlayers=req['numPlayers'])


def audit_action(decision, req, stack):
    action = decision['action']
    call = float(req.get('toCall', 0))
    flags = []
    amount = 0.
    if action == 'check' and call > 0:
        flags.append('check_facing_bet')
    if action == 'call':
        amount = min(call, stack)
    elif action == 'allin':
        amount = stack
    elif action in ('bet', 'raise', '3bet', '4bet'):
        amount = float((decision.get('sizing') or {}).get('absolute', float('nan')))
        if req['street'] == 'preflop':
            amount -= float(req.get('heroWagerBB', 0))
        if not math.isfinite(amount) or amount <= call or amount > stack + 1e-6:
            flags.append('invalid_or_ambiguous_commitment')
        if req.get('minRaiseBB') is not None and amount - call < float(req['minRaiseBB']) - 1e-6 and amount < stack:
            flags.append('below_minimum_raise')
    elif action not in ('check', 'fold'):
        flags.append('unknown_action')
    if stack > 150 and amount > stack / 2 and float(req['pot']) < stack / 10:
        flags.append('unvalidated_deep_commitment')
    if amount > call and action in ('allin', 'bet', 'raise', '3bet', '4bet') and req.get('canRaise') is False:
        flags.append('raising_not_reopened')
    return {'additionalBB': amount if math.isfinite(amount) else None, 'flags': flags}


def guarded_preview(decision, endpoints, req, stack, side_pot, equity, error):
    """Offline candidate output: legality plus sampling sensitivity, not GTO.

    No bluff frequencies, model confidence scores, or speculative fullstreet EV.
    The terminal call/fold EV is conditional on the supplied public range model.
    """
    out = {'ready': False, 'action': None, 'additionalBB': None,
           'kind': 'approximate_heuristic', 'reasons': []}
    if side_pot:
        out['reasons'] = ['unresolved_pot_eligibility']
        return out
    call = min(float(req.get('toCall', 0)), stack)
    audited = audit_action(decision, req, stack)
    if decision['action'] == 'fold' and call == 0:
        out.update(ready=True, action='check', additionalBB=0., reasons=['free_check_available'])
        return out
    closed_river = req['numPlayers'] == 2 or all(p['stackBB'] == 0 for p in req['opponents'])
    if (req['street'] == 'river' and call > 0 and closed_river
            and (decision['action'] in ('call', 'fold') or audited['flags'] or
                 all(p['stackBB'] == 0 for p in req['opponents']))):
        ev = equity * (req['pot'] + call) - call
        width = 1.96 * error * (req['pot'] + call)
        out.update(kind='closed_river_call_fold', callEVBB=ev, sampling95IntervalBB=[ev-width, ev+width],
                   restrictedActions=['fold', 'call'], raisingEvaluated=False)
        if ev-width <= 0 <= ev+width:
            out['reasons'] = ['sampling_cannot_separate_call_and_fold']
            return out
        out.update(ready=True, action='call' if ev > 0 else 'fold', additionalBB=call if ev > 0 else 0)
        return out
    if any(p['action'] != decision['action'] for p in endpoints):
        out['reasons'] = ['sampling_interval_changes_heuristic_action']
        return out
    if audited['flags'] == ['below_minimum_raise'] and req['street'] != 'preflop':
        # Enforce the legal minimum only; never turn an oversized bet into a shove.
        amount = call + float(req['minRaiseBB'])
        if amount <= stack:
            decision = {**decision, 'sizing': {'absolute': amount}}
            audited = audit_action(decision, req, stack)
            out['reasons'].append('minimum_legal_size_enforced')
    if audited['flags']:
        out['reasons'] += audited['flags']
        return out
    out.update(ready=True, action=decision['action'], additionalBB=audited['additionalBB'])
    return out


def evaluate(req, seed, samples, range_model=None):
    pot, call, stack, opponents, factory = validate(req)
    if factory is not None:
        can_raise = any(a.label!='fold' and a.amount>min(call,stack)+1e-6 for a in factory.template.actions())
        req = {**req,'canRaise':req.get('canRaise',True) and can_raise}
    from opponent_model import joint_equity
    from ranges import parse_card
    history = req.get('history') or []
    estimates = None
    model_hash = None
    if range_model:
        from residual_range import residual_range
        model_path = Path(range_model)
        model = json.loads(model_path.read_text(encoding='utf-8'))
        model_hash = hashlib.sha256(model_path.read_bytes()).hexdigest()
        estimates = [residual_range(p, history, [parse_card(c) for c in req['board']], model) for p in opponents]
    by_id = {str(p['id']): i for i, p in enumerate(opponents)}
    reference = next((by_id[str(a['playerId'])] for a in reversed(history)
                      if str(a.get('playerId')) in by_id and a.get('street') == req['street']
                      and a.get('action') in ('bet', 'raise')), 0)
    t0 = time.perf_counter()
    mc = joint_equity([parse_card(c) for c in req['heroCards']], [parse_card(c) for c in req['board']],
                      opponents, history, samples=samples, seed=seed, compare_opponent=reference,
                      range_estimates=estimates)
    state = engine_state(req, stack, [opponents[reference]] + [p for i, p in enumerate(opponents) if i != reference])
    estimates = [(mc['headsUpReference']['equity'], mc['headsUpReference']['standardError']),
                 (mc['heroEquity'], mc['standardError'])]
    equities = [q for q, _ in estimates]
    equities += [max(0., q - 1.96*se) for q, se in estimates]
    equities += [min(1., q + 1.96*se) for q, se in estimates]
    script = "const E=require('./engine/gto-engine');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const x=JSON.parse(s);console.log(JSON.stringify(x.equities.map(q=>E.advise(x.state,q))))});"
    process = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
                             check=True, timeout=.8,
                             input=json.dumps({'state': state, 'equities': equities}))
    decisions = json.loads(process.stdout)
    baseline, candidate = decisions[:2]
    side_pot, eligibility = side_pot_status(req, call, stack, opponents, factory)
    notes = ['Same public ranges and identical deals/runouts; no opponent hidden cards are inputs.',
             'Equity standard errors describe sampling only, not range or strategy-model errors.',
             'The decision rule is the original heuristic, not a solved multiplayer policy.',
             'Historical continuation actions and final winnings are not counterfactual rewards.']
    if req['street'] == 'preflop':
        notes.append('Preflop heuristic uses its range templates; external equity does not change its action.')
    if side_pot:
        notes.append('Side-pot eligibility is not modelled here: no actionable advice or total-pot EV is published.')
    temporal = {'decisionTimestampPresent': bool(req.get('at')),
                'untimedActions': sum(not a.get('at') for a in history),
                'profilesWithUnknownCutoff': sum(bool((p.get('profile') or {}).get('hands')) and
                                                 not (p.get('profile') or {}).get('lastSeen') for p in opponents)}
    temporal['cutoffVerifiable'] = bool(temporal['decisionTimestampPresent'] and
                                       not temporal['untimedActions'] and not temporal['profilesWithUnknownCutoff'])
    if not temporal['cutoffVerifiable']:
        notes.append('Missing timestamps prevent verification of same-street history/profile cutoff.')
    variants = {}
    for i, (name, decision) in enumerate([('heads_up_reference', baseline), ('joint_equity_correction', candidate)]):
        audit = audit_action(decision, req, stack)
        variants[name] = {'rawDecision': decision, 'actionAudit': audit,
                          'publishable': False,
                          'guardedPreview': guarded_preview(decision, [decisions[2+i], decisions[4+i]],
                                                            req, stack, side_pot, *estimates[i]),
                          'reason': 'Offline experiment; comparative strategy strength not established'}
    return {'status': 'ok', 'rangeModelSha256': model_hash,
            'rangeModel': 'public_size_residual_v2' if range_model else 'legacy',
            'seed': seed, 'samples': samples, 'numPlayers': len(opponents) + 1,
            'street': req['street'], 'heroCards': req['heroCards'], 'board': req['board'],
            'historyActions': len(history), 'historyComplete': bool(req.get('historyComplete')),
            'potBB': pot, 'callBB': call, 'heroStackBB': stack, 'sidePotRisk': side_pot,
            'potEligibility': eligibility,
            'temporalAudit': temporal,
            'equity': mc, 'variants': variants, 'notes': notes,
            'pairedCheckdownEVDifference': None if side_pot else
                (pot + call) * mc['headsUpReference']['pairedEquityDifference'],
            'checkdownEVStandardError': None if side_pot else
                (pot + call) * mc['headsUpReference']['pairedStandardError'],
            'computeMs': round((time.perf_counter() - t0) * 1000, 1)}


def terminate_tree(process):
    """Only terminate the worker process group created by this replay."""
    if os.name == 'nt':
        # Do not spawn taskkill: its own startup exceeded our cleanup deadline
        # under load. Stop this trusted worker first so it cannot launch Node
        # during the following descendant snapshot. Its Node script never forks.
        import ctypes
        from ctypes import wintypes as wt

        class Entry(ctypes.Structure):
            _fields_ = [('size', wt.DWORD), ('usage', wt.DWORD), ('pid', wt.DWORD),
                        ('heap', ctypes.c_size_t), ('module', wt.DWORD), ('threads', wt.DWORD),
                        ('parent', wt.DWORD), ('priority', wt.LONG), ('flags', wt.DWORD),
                        ('exe', wt.WCHAR * 260)]

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
        kernel.CreateToolhelp32Snapshot.restype = wt.HANDLE
        kernel.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(Entry)]
        kernel.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(Entry)]
        kernel.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
        kernel.OpenProcess.restype = wt.HANDLE
        kernel.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
        kernel.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
        kernel.CloseHandle.argtypes = [wt.HANDLE]
        process.kill()
        snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
        if snapshot == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        entries = []
        try:
            entry = Entry()
            entry.size = ctypes.sizeof(entry)
            more = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
            while more:
                entries.append((entry.pid, entry.parent))
                more = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        finally:
            kernel.CloseHandle(snapshot)
        owned = {process.pid}
        while True:
            children = {pid for pid, parent in entries if parent in owned} - owned
            if not children:
                break
            owned.update(children)
        for pid in owned - {process.pid}:
            handle = kernel.OpenProcess(0x100001, False, pid)  # SYNCHRONIZE | TERMINATE
            if not handle:
                if ctypes.get_last_error() == 87:  # Already exited.
                    continue
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                if not kernel.TerminateProcess(handle, 1) and kernel.WaitForSingleObject(handle, 0) != 0:
                    raise ctypes.WinError(ctypes.get_last_error())
                if kernel.WaitForSingleObject(handle, 1000) != 0:
                    raise TimeoutError('Owned replay child did not exit')
            finally:
                kernel.CloseHandle(handle)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=2)


def run_case(req, seed, samples, budget_ms, range_model=None, cancel=None):
    """Wall-clock deadline includes Python startup, validation, equity and Node."""
    t0 = time.perf_counter()
    cleanup_ms = 0.
    try:
        proc = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()), '--worker'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', start_new_session=os.name != 'nt',
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8',
                                     'PYTHONDONTWRITEBYTECODE': '1', 'OPENBLAS_NUM_THREADS': '1'})
        payload = json.dumps(dict(request=req, seed=seed, samples=samples, rangeModel=range_model))
        while True:
            if cancel is not None and cancel.is_set():
                terminate_tree(proc)
                proc.communicate(timeout=2)
                return {'status':'cancelled','seed':seed,'wallMs':round((time.perf_counter()-t0)*1000,1)}
            remaining = budget_ms/1000-(time.perf_counter()-t0)
            if remaining <= 0:
                raise subprocess.TimeoutExpired(proc.args, budget_ms/1000)
            try:
                output, errors = proc.communicate(payload, timeout=min(.05,remaining) if cancel is not None else remaining)
                break
            except subprocess.TimeoutExpired:
                payload = None  # communicate() retains partially written input.
                if cancel is None:
                    raise
        if proc.returncode:
            result = {'status': 'error', 'error': errors[-1500:]}
        else:
            result = json.loads(output)
    except subprocess.TimeoutExpired:
        cleanup_start = time.perf_counter()
        terminate_tree(proc)
        proc.communicate(timeout=2)
        cleanup_ms = (time.perf_counter() - cleanup_start) * 1000
        result = {'status': 'timed_out', 'error': 'Replay deadline exceeded; no advice retained'}
    elapsed = (time.perf_counter() - t0) * 1000
    if elapsed > budget_ms:
        result = {'status': 'timed_out', 'error': 'Replay deadline exceeded; no advice retained'}
    return {**result, 'seed': seed, 'wallMs': round(elapsed, 1), 'budgetMs': budget_ms,
            'cleanupMs': round(cleanup_ms, 1), 'wallDeadlineExceeded': elapsed > budget_ms}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    ap.add_argument('--cases', type=Path)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--seeds', default='20261027,333,777')
    ap.add_argument('--samples', type=int, default=4000)
    ap.add_argument('--budget-ms', type=int, default=3800)
    ap.add_argument('--range-model', type=Path, help='Optional offline v2 candidate; never changes the live solver')
    args = ap.parse_args()
    if args.worker:
        payload = json.load(sys.stdin)
        try:
            result = evaluate(payload['request'], payload['seed'], payload['samples'], payload.get('rangeModel'))
        except subprocess.TimeoutExpired:
            result = {'status': 'timed_out', 'error': 'Node evaluation exceeded its deadline'}
        except (ValueError, KeyError, TypeError, IndexError) as error:
            result = {'status': 'invalid_input', 'error': str(error)}
        print(json.dumps(result, ensure_ascii=True, allow_nan=False))
        return
    if not args.cases or not args.out:
        ap.error('--cases and --out are required')
    if not 100 <= args.samples <= 20000 or not 50 <= args.budget_ms <= 4000:
        ap.error('samples must be 100–20000 and budget-ms 50–4000')
    cases = json.loads(args.cases.read_text(encoding='utf-8'))
    if isinstance(cases, list):
        cases = {str(i): c for i, c in enumerate(cases)}
    seeds = [int(s) for s in args.seeds.split(',')]
    rows = []
    for key, case in cases.items():
        req = case.get('request', case)
        for seed in seeds:
            result = run_case(req, seed, args.samples, args.budget_ms,
                              str(args.range_model.resolve()) if args.range_model else None)
            rows.append({'caseId': key, **result})
            print(json.dumps({'caseId': key, 'seed': seed, 'status': result['status'], 'wallMs': result['wallMs']}), flush=True)
    sources = [Path(__file__), Path(__file__).with_name('opponent_model.py'), ROOT / 'engine/gto-engine.js']
    report = {'scope': 'Offline paired modelling comparison, not strategy-strength certification',
              'inputSha256': hashlib.sha256(args.cases.read_bytes()).hexdigest(),
              'sourceSha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
              'seeds': seeds, 'rows': rows,
              'deadlineScope': 'Target includes worker startup, validation, equity and Node. Timeout cleanup is measured separately and may exceed the target; late advice is discarded.',
              'strategyStrengthEstablished': False,
              'summary': {s: sum(r['status'] == s for r in rows)
                          for s in ('ok', 'invalid_input', 'timed_out', 'error')}}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temp = args.out.with_suffix('.tmp')
    temp.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(temp, args.out)


if __name__ == '__main__':
    main()
