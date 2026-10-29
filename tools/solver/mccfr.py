"""Outcome-sampling MCCFR and versioned SQLite blueprints.

Importance-weighted regret/average updates follow outcome-sampling MCCFR;
reference: OpenSpiel python/algorithms/outcome_sampling_mccfr.py (Apache-2.0).
This implementation stages updates until a complete sampled episode finishes.
Multiplayer/hand abstractions do NOT supply a full-game Nash guarantee.
"""
from dataclasses import dataclass
import json
import math
from pathlib import Path
import random
import sqlite3
import time

VERSION = 'nlhe-os-v1'


class Interrupted(Exception):
    pass


@dataclass
class Info:
    regret: list
    average: list
    visits: int = 0

    def policy(self):
        positive = [max(0., x) for x in self.regret]
        total = sum(positive)
        return [x / total for x in positive] if total > 1e-20 else [1. / len(positive)] * len(positive)

    def mean_policy(self):
        total = sum(self.average)
        return [x / total for x in self.average] if total > 1e-20 else self.policy()


class Blueprint:
    def __init__(self, path=None, readonly=False, limit=50000):
        self.nodes = {}
        self.dirty = set()
        self.readonly = readonly
        self.limit = limit
        self.hits = 0
        self.prior_visits = {}
        self.fallback_keys = {}
        self.prior_source = {}
        self.allow_new = True
        self.connection = None
        if path and (not readonly or Path(path).exists()):
            if not readonly:
                Path(path).parent.mkdir(parents=True, exist_ok=True)
            try:
                self.connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=.05) if readonly else sqlite3.connect(path, timeout=.2)
                if not readonly:
                    self.connection.execute('PRAGMA journal_mode=WAL')
                    self.connection.execute('CREATE TABLE IF NOT EXISTS policy (key TEXT PRIMARY KEY, data TEXT NOT NULL)')
                    self.connection.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
                    self.connection.execute('INSERT OR IGNORE INTO meta VALUES (?,?)', ('version', VERSION))
                    self.connection.commit()
                version = self.connection.execute('SELECT value FROM meta WHERE key=?', ('version',)).fetchone()
                if version != (VERSION,):
                    raise ValueError('Incompatible blueprint version')
            except sqlite3.Error:
                if self.connection:
                    self.connection.close()
                self.connection = None

    def get(self, key, actions):
        if key in self.nodes:
            return self.nodes[key]
        result = Info([0.] * actions, [0.] * actions)
        known = False
        if self.connection:
            row = self.connection.execute('SELECT data FROM policy WHERE key=?', (key,)).fetchone()
            source = 'exact'
            if row is None and self.readonly and key in self.fallback_keys:
                row = self.connection.execute('SELECT data FROM policy WHERE key=?', (self.fallback_keys[key],)).fetchone()
                source = 'bucket'
            if row:
                known = True
                data = json.loads(row[0])
                if len(data['regret']) == actions:
                    result = Info(data['regret'], data['average'], data['visits'])
                    self.hits += 1
                    if self.readonly:
                        self.prior_visits[key] = result.visits
                        self.prior_source[key] = source
                        policy = result.mean_policy()
                        result = Info([p * 8 for p in policy], [p * 8 for p in policy])
        if len(self.nodes) < self.limit and (self.allow_new or known):
            self.nodes[key] = result
        return result

    def checkpoint(self, episodes=0):
        if self.readonly or not self.connection:
            return
        rows = [(key, json.dumps(vars(self.nodes[key]), separators=(',', ':'))) for key in self.dirty if key in self.nodes]
        with self.connection:
            self.connection.executemany('INSERT OR REPLACE INTO policy VALUES (?,?)', rows)
            self.connection.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('episodes', str(episodes)))
        self.dirty.clear()

    def close(self):
        if self.connection:
            self.connection.close()


def pick(probabilities, rng):
    target, cumulative = rng.random(), 0.
    for i, p in enumerate(probabilities):
        cumulative += p
        if target < cumulative:
            return i
    return len(probabilities) - 1


class OutcomeSampling:
    def __init__(self, store, seed=20261027):
        self.store = store
        self.rng = random.Random(seed)
        self.episodes = 0
        self.street_visits = [0, 0, 0, 0]

    def episode(self, state, updating, deadline=math.inf, cancel=None, chance_weight=1.):
        frames = []
        own_reach, other_reach, sampled_reach = 1., 1., 1.
        normalizer = max(1., sum(state.stacks) / state.n + state.pot / state.n)
        while not state.terminal:
            if len(frames) >= 200:
                raise ValueError('Unexpected action depth')
            if time.perf_counter() >= deadline or cancel is not None and cancel.is_set():
                raise Interrupted()
            actions = state.actions()
            key = state.info_key(actions)
            if getattr(state, 'exact_root_player', -1) == state.player and len(state.history) == state.exact_root_depth:
                self.store.fallback_keys[key] = state.info_key(actions, exact=False)
            info = self.store.get(key, len(actions))
            policy = info.policy()
            actor = state.player
            behavior = [p * .4 + .6 / len(actions) for p in policy] if actor == updating else policy
            a = pick(behavior, self.rng)
            frames.append((key, info, policy, behavior[a], a, own_reach, other_reach, sampled_reach, actor == updating, state.street))
            if actor == updating:
                own_reach *= policy[a]
            else:
                other_reach *= policy[a]
            sampled_reach *= behavior[a]
            state = state.step(actions[a])
        utility = state.returns()[updating] / normalizer
        changes = []
        for key, info, policy, behavior_prob, action, own, other, sampled, update, street in reversed(frames):
            chosen = utility / behavior_prob
            utility = policy[action] * chosen
            if update:
                factor = chance_weight * other / max(sampled, 1e-250)
                regret = [factor * ((chosen if i == action else 0.) - utility) for i in range(len(policy))]
                average = [chance_weight * own * p / max(sampled, 1e-250) for p in policy]
                if not all(math.isfinite(x) for x in regret + average):
                    raise ValueError('Nonfinite MCCFR importance weight')
                changes.append((key, info, regret, average, street))
        # No mutations from an interrupted or invalid half-episode.
        for key, info, regret, average, street in changes:
            for i in range(len(regret)):
                info.regret[i] += regret[i]
                info.average[i] += average[i]
            info.visits += 1
            self.store.dirty.add(key)
            self.street_visits[street] += 1
        self.episodes += 1
        return state
