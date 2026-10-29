from pathlib import Path
import os
import tempfile
import unittest
from evaluate import evaluate,freeze_model
from mccfr import Blueprint


class Evaluation(unittest.TestCase):
    def test_relative_readonly_model_path(self):
        previous=Path.cwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                store=Blueprint('relative.sqlite');store.close()
                readonly=Blueprint('relative.sqlite',readonly=True)
                self.assertIsNotNone(readonly.connection);readonly.close()
            finally:os.chdir(previous)

    def test_identical_policies_have_zero_paired_difference(self):
        report=evaluate(None,None,deals=8)
        for value in report['opponents'].values():
            self.assertEqual(value['deltaBB100'],0)
            self.assertEqual(value['standardErrorBB100'],0)
        self.assertEqual(report['promotion'],'manual_review_required')

    def test_snapshot_includes_committed_wal(self):
        with tempfile.TemporaryDirectory() as tmp:
            a,b=Path(tmp)/'a.sqlite',Path(tmp)/'b.sqlite'
            store=Blueprint(a);info=store.get('known',2);info.regret[:]=[3.,1.]
            store.dirty.add('known');store.checkpoint(9)
            freeze_model(a,b)
            frozen=Blueprint(b,readonly=True)
            self.assertEqual(frozen.get('known',2).mean_policy(),[.75,.25])
            self.assertEqual(frozen.connection.execute("SELECT value FROM meta WHERE key='episodes'").fetchone()[0],'9')
            with self.assertRaises(ValueError):freeze_model(a,b)
            frozen.close();store.close()


if __name__=='__main__':unittest.main()
