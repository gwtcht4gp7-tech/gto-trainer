# Public-action range audit, 2026-10-29

Baseline checkpoint: c365c3e on backup/pokerist-practical-20261029. Production
code and services were not changed for this audit.

Added range_calibration.py, which freezes predictions from each public decision
prefix BEFORE using the actual dealt opponent cards as held-out labels. Other
hole cards never enter predict(). Scores measure probability density assigned
to observed cards, not action EV, optimality, win rate or a full joint prior.
Each hand is one statistical cluster because its same cards appear repeatedly.

Ten consecutive public Pluribus PHH hands provide 235 single-opponent labels.
The mean per-hand log-density improvement over a uniform legal-card prior is
0.3358 nats (descriptive normal interval 0.2369..0.4347). This small convenience
cohort does NOT establish general calibration or multiplayer strategy strength;
the river subset has only three hand clusters. The results show that discarding
the existing public-action range model wholesale is not justified by this test.

One important limitation was verified separately: changing an otherwise identical
postflop bet from 1bb to 100bb leaves the entire estimated range exactly unchanged.
The current model handles action types and accumulated history, but no bet-size
likelihood or check likelihood. Thus seed stability cannot diagnose this model
bias. The regression explicitly documents this legacy limitation, not a desired
property for future models.

No arbitrary size multipliers were added and no parameters were fitted on these
ten hands. A future size-aware candidate must be evaluated on a separate, larger
cohort with train/test split by session or match, using the same prefix inputs,
card blockers and original baseline; simple hand frequency or chosen-action
agreement is insufficient. Tests of likelihood math, label isolation, uniform
control and hand clustering were added. The focused Python suite now passes 50
tests. Existing phase-2 timing and legality evidence still describe that frozen
version, not a newly deployed solver.

Reproduce with Python/NumPy and optional PokerKit 0.7.7:

    py -3 -B tools/solver/range_calibration.py --sources SOURCE_BUNDLE.json --out RESULT.json

SOURCE_BUNDLE.json is a list of objects with name, url and content. The source
manifest and aggregate results are in validation/range-calibration-20261029.json.
The full raw scoring output is retained locally with the offline replay evidence.
