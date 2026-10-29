"""Strict PHH prefix adapter for offline replay; requires pokerkit==0.7.7.

Uses PokerKit rules, but not its repair-capable state_actions iterator. Never
exports other players' hole cards, future actions/boards, or finishing stacks.
Only standard six-seat NLHE with zero antes, SB/BB and one board is supported.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import tomllib

from pokerkit import HandHistory
from pokerkit.notation import parse_action
from practical_replay import validate

# Existing bridge/range tables call the six-max hijack "MP".
POSITIONS = ['SB', 'BB', 'UTG', 'MP', 'CO', 'BTN']
STREETS = ['preflop', 'flop', 'turn', 'river']


def prefixes(text):
    raw = tomllib.loads(text)
    n = len(raw['starting_stacks'])
    bb = raw['min_bet']
    if (raw['variant'] != 'NT' or n != 6 or bb <= 0
            or any(raw['antes']) or raw['blinds_or_straddles'] != [bb/2, bb] + [0]*(n-2)):
        raise ValueError('Unsupported PHH variant, antes or blind order')
    hh = HandHistory.loads(text)
    state = hh.create_state()
    history = [dict(playerId=f'p{i+1}', action='blind', amountBB=b/bb,
                    street='preflop', board=[]) for i, b in enumerate(state.bets) if b]
    result = []
    for step, action in enumerate(raw['actions']):
        words = action.split()
        if state.can_burn_card():
            state.burn_card('??')
        betting = len(words) in (2, 3) and words[0].startswith('p') and words[1] in ('f', 'cc', 'cbr')
        if not (betting or words[:2] in (['d', 'dh'], ['d', 'db'])
                or len(words) in (2, 3) and words[0].startswith('p') and words[1] == 'sm'):
            raise ValueError('Unsupported PHH action')
        if betting:
            hero = int(words[0][1:]) - 1
            if state.actor_index != hero:
                raise ValueError('PHH actor out of order; no repair permitted')
            street = STREETS[state.street_index]
            board = list(map(repr, state.get_board_cards(0)))
            call = state.checking_or_calling_amount
            old_bet, old_stack = state.bets[hero], state.stacks[hero]
            people = [dict(id=f'p{i+1}', seat=i, pos=POSITIONS[i], stackBB=s/bb,
                           wagerBB=state.bets[i]/bb, folded=not state.statuses[i])
                      for i, s in enumerate(state.stacks)]
            req = dict(street=street, heroCards=list(map(repr, state.hole_cards[hero])), board=board,
                       heroId=f'p{hero+1}', heroPos=POSITIONS[hero], heroStack=old_stack/bb,
                       heroWagerBB=old_bet/bb, pot=state.total_pot_amount/bb, toCall=call/bb,
                       numPlayers=sum(state.statuses),
                       opponents=[p.copy() for i, p in enumerate(people) if i != hero and state.statuses[i]],
                       playersContext=people, dealerSeat=n-1,
                       history=copy.deepcopy(history), historyComplete=True, bbChips=bb,
                       minRaiseBB=max(bb, state.completion_betting_or_raising_amount)/bb,
                       canRaise=state.can_complete_bet_or_raise_to())
            validate(req)
            # Record the real action only outside the decision request.
            result.append({'prefixActionIndex': step, 'request': req, 'observedAction': action})
        # Strict parse_action checks turn, amount, cards and legal raise sizes.
        parse_action(state, action, hh.parse_value)
        if betting:
            label = {'f': 'fold', 'cc': 'call' if call else 'check',
                     'cbr': 'raise' if call else 'bet'}[words[1]]
            amount = (min(call, old_stack) if words[1] == 'cc' else
                      float(words[2]) - old_bet if words[1] == 'cbr' else 0)
            history.append(dict(playerId=f'p{hero+1}', action=label, street=street,
                                board=board, amountBB=amount/bb, moneyLeftBB=(old_stack-amount)/bb))
    return result


def import_sources(sources):
    cases, manifest = {}, []
    for source in sources:
        digest = hashlib.sha256(source['content'].encode()).hexdigest()
        entry = dict(name=source['name'], url=source['url'], sha256=digest)
        try:
            rows = prefixes(source['content'])
            for row in rows:
                cases[source['name'] + ':' + str(row['prefixActionIndex'])] = row
            entry.update(status='ok', decisions=len(rows))
        except (ValueError, KeyError, IndexError, TypeError) as error:
            entry.update(status='rejected', error=str(error))
        manifest.append(entry)
    return cases, manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--sources', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    cases, manifest = import_sources(json.loads(args.sources.read_text(encoding='utf-8')))
    args.out.write_text(json.dumps(cases, indent=2), encoding='utf-8')
    args.out.with_name(args.out.stem + '-manifest.json').write_text(
        json.dumps({'scope': 'Prefix/accounting replay; observed actions are not optimal policy labels',
                    'pokerkitVersion': '0.7.7', 'sources': manifest}, indent=2), encoding='utf-8')
    print(json.dumps({'hands': len(manifest), 'accepted': sum(s['status'] == 'ok' for s in manifest),
                      'decisions': len(cases), 'rejections': [s for s in manifest if s['status'] != 'ok']}))


if __name__ == '__main__':
    main()
