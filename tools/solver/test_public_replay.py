import copy
import json
import unittest

from practical_replay import audit_action, validate
from public_replay import prefixes

HAND = """variant = 'NT'
ante_trimming_status = true
antes = [0, 0, 0, 0, 0, 0]
blinds_or_straddles = [50, 100, 0, 0, 0, 0]
min_bet = 100
starting_stacks = [10000, 10000, 10000, 10000, 10000, 10000]
actions = ['d dh p1 TcQc', 'd dh p2 8s4c', 'd dh p3 9c3d', 'd dh p4 Ah4h', 'd dh p5 Th5s', 'd dh p6 6c7s', 'p3 f', 'p4 cbr 210', 'p5 f', 'p6 f', 'p1 cc', 'p2 f', 'd db 7d5h9d', 'p1 cc', 'p4 cc', 'd db 7c', 'p1 cc', 'p4 cc', 'd db Qh', 'p1 cbr 230', 'p4 f']
"""


class PublicReplayTests(unittest.TestCase):
    def test_amounts_are_prefix_only_and_include_wagers(self):
        rows = prefixes(HAND)
        self.assertEqual(len(rows), 12)
        first = rows[0]['request']
        self.assertEqual((first['pot'], first['toCall'], first['heroStack'], first['numPlayers']), (1.5, 1, 100, 6))
        self.assertEqual(rows[1]['request']['heroPos'], 'MP')
        small_blind = next(r['request'] for r in rows if r['prefixActionIndex'] == 10)
        self.assertEqual((small_blind['pot'], small_blind['toCall'], small_blind['heroWagerBB']), (3.6, 1.6, .5))
        river = next(r['request'] for r in rows if r['prefixActionIndex'] == 19)
        self.assertAlmostEqual(river['pot'], 5.2)
        self.assertEqual(river['board'], ['7d', '5h', '9d', '7c', 'Qh'])
        self.assertEqual(river['toCall'], 0)
        self.assertEqual(river['history'][-1]['street'], 'turn')

    def test_future_board_other_holes_and_results_do_not_change_earlier_input(self):
        changed = HAND.replace('p1 TcQc', 'p1 8s4c').replace('p2 8s4c', 'p2 TcQc').replace('d db Qh', 'd db Qd')
        changed += '\nfinishing_stacks = [99999, 1, 1, 1, 1, 1]\n'
        a, b = prefixes(HAND)[0], prefixes(changed)[0]
        self.assertEqual(a['request'], b['request'])
        self.assertNotIn('observedAction', a['request'])
        self.assertNotIn('finishing_stacks', json.dumps(a['request']))
        self.assertTrue(all('cards' not in p and 'heroCards' not in p for p in a['request']['playersContext']))

    def test_illegal_order_and_raise_never_repaired(self):
        for changed in (HAND.replace("'p3 f'", "'p4 f'"), HAND.replace('p4 cbr 210', 'p4 cbr 150')):
            with self.assertRaises(ValueError):
                prefixes(changed)

    def test_nonstandard_blinds_rejected(self):
        with self.assertRaises(ValueError):
            prefixes(HAND.replace('[50, 100, 0, 0, 0, 0]', '[50, 100, 200, 0, 0, 0]'))

    def test_short_small_blind_records_actual_posted_amount(self):
        short = HAND.replace('starting_stacks = [10000,', 'starting_stacks = [25,')
        # Only the initial legal prefix: the original SB's later call is no
        # longer legal after changing that player to an all-in blind.
        short = short[:short.index(", 'p4 cbr 210'")] + ']\n'
        req = prefixes(short)[0]['request']
        self.assertEqual(req['pot'], 1.25)
        self.assertEqual(req['history'][0]['amountBB'], .25)
        self.assertEqual(req['playersContext'][0]['stackBB'], 0)

    def test_heads_up_not_silently_imported_as_six_seat_format(self):
        with self.assertRaises(ValueError):
            prefixes(HAND.replace('starting_stacks = [10000, 10000, 10000, 10000, 10000, 10000]',
                                  'starting_stacks = [10000, 10000]'))

    def test_complete_context_must_match_active_opponents_and_stacks(self):
        base = prefixes(HAND)[0]['request']
        for patch in ('id', 'stack', 'hero'):
            req = copy.deepcopy(base)
            if patch == 'id':
                req['opponents'][0]['id'] = 'someone_else'
            elif patch == 'stack':
                req['opponents'][0]['stackBB'] -= 1
            else:
                req['heroStack'] -= 1
            with self.assertRaises(ValueError):
                validate(req)

    def test_closed_raise_is_flagged_even_for_allin(self):
        req = {**prefixes(HAND)[0]['request'], 'canRaise': False}
        self.assertIn('raising_not_reopened', audit_action({'action': 'allin'}, req, 100)['flags'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
