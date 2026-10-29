# Pokerist practical candidate checkpoints

The backup/pokerist-practical-20261029 branch preserves the offline candidate
and the bridge/solver source it was developed beside. This is not a production
deployment or a claim of full-game GTO correctness. main is left unchanged.

The phase-2 checkpoint precedes subsequent range-model investigations. It has
45 passing Python checks, 300 public-prefix replays, and independent legal
execution of all 300 candidate actions. Detailed limits: practical-phase2.md.
Local source and delivery worklogs retain the complete machine-specific history.
Private logs, player profiles, databases, bytecode, and machine-specific audit
script/default paths are excluded from this public backup.

To inspect or restore a checkpoint without discarding ongoing work, clone this
repository into a NEW folder and check out the desired commit there. Run the
tests in that copy before explicitly deploying. Do not overwrite a running
service's modules and do not reset or remove existing runtime/player data.

Python 3.12, NumPy 2.2.5 and Node.js were used. Public PHH import tests require
the optional pokerkit==0.7.7 dependency in tools/solver/requirements-replay.txt.
From tools/solver run:

    py -3 -B -m unittest test_public_replay test_terminal_benchmark test_practical_replay test_regressions

The separate local Git bundle is another recovery source if GitHub is offline.
Future working stages should be separate commits, so this checkpoint remains
available independently of whether a newer candidate is accepted.
