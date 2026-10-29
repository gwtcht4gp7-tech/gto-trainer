"""Apply offline candidate actions to PokerKit's actual prefix state.

This checks legality only, not strategy quality or real-money profitability.
"""
import argparse
import json
from pathlib import Path

from pokerkit import HandHistory
from pokerkit.notation import parse_action


def verify_preview(text, step, preview):
    hh = HandHistory.loads(text)
    state = hh.create_state()
    for action in hh.actions[:step]:
        if state.can_burn_card():
            state.burn_card('??')
        parse_action(state, action, hh.parse_value)
    if state.can_burn_card():
        state.burn_card('??')
    actor = state.actor_index
    if actor is None:
        raise ValueError('No actor at supplied decision prefix')
    action, amount = preview['action'], preview['additionalBB'] * hh.min_bet
    player = f'p{actor+1}'
    if action == 'check':
        if state.checking_or_calling_amount or amount:
            raise ValueError('Check while facing a bet')
        command = player + ' cc'
    elif action == 'call':
        if abs(amount - state.checking_or_calling_amount) > 1e-6:
            raise ValueError('Call amount differs from actual legal call')
        command = player + ' cc'
    elif action == 'fold':
        if amount:
            raise ValueError('Fold with extra commitment')
        command = player + ' f'
    else:
        target = state.bets[actor] + amount
        if action == 'allin' and amount <= state.checking_or_calling_amount:
            command = player + ' cc'
        else:
            command = player + ' cbr ' + str(target)
    parse_action(state, command, hh.parse_value)


def audit(sources, results):
    by_name = {s['name']: s['content'] for s in sources}
    checked, held, failures = 0, 0, []
    for row in results['rows']:
        if row['status'] != 'ok':
            continue
        name, step = row['caseId'].rsplit(':', 1)
        preview = row['variants']['joint_equity_correction']['guardedPreview']
        if not preview['ready']:
            held += 1
            continue
        try:
            verify_preview(by_name[name], int(step), preview)
            checked += 1
        except (ValueError, KeyError, IndexError) as error:
            failures.append(dict(caseId=row['caseId'], seed=row['seed'], error=str(error), preview=preview))
    return dict(scope='PokerKit action legality only; no policy strength certification',
                legal=checked, held=held, failures=failures)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--sources', type=Path, required=True)
    ap.add_argument('--results', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    result = audit(json.loads(args.sources.read_text(encoding='utf-8')),
                   json.loads(args.results.read_text(encoding='utf-8')))
    args.out.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
