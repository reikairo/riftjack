import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'check_target.py'
spec = importlib.util.spec_from_file_location('check_target', SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
FIXTURES = SCRIPT.parents[1] / 'fixtures'


class TargetChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'index.md'
        self.source.write_text('source', encoding='utf-8')
        (self.root / 'guide.md').write_text('# Installation', encoding='utf-8')

    def check(self, destination):
        return checker.check_target(str(self.source), destination)

    def test_present_and_missing(self):
        self.assertEqual(self.check('guide.md')['file'], 'present')
        self.assertEqual(self.check('missing.md')['file'], 'missing')

    def test_nested_unicode_space(self):
        nested = self.root / 'sub'
        nested.mkdir()
        (nested / 'пример file.md').write_text('', encoding='utf-8')
        self.assertEqual(self.check('sub/пример file.md')['file'], 'present')

    def test_counterexample(self):
        reports = [checker.check_target(str(FIXTURES / phase / 'index.md'),
                                       'guide.md#installation')
                   for phase in ('before', 'after')]
        for report in reports:
            self.assertEqual(report, {'file': 'present', 'fragment': 'not_checked',
                                      'reason': 'regular_file_exists'})
        self.assertEqual(reports[0], reports[1])

    def test_unsupported(self):
        for value in ('https://example.org', '//example.org/a', '/tmp/a',
                      '#part', '', 'a%20b', 'a?q', 'a\\b', '<a>', 'a\x00'):
            with self.subTest(value=value):
                self.assertEqual(self.check(value)['file'], 'not_checked')

    def test_outside_and_symlink(self):
        self.assertEqual(self.check('../outside')['file'], 'not_checked')
        (self.root / 'escape').symlink_to(self.root.parent, target_is_directory=True)
        self.assertEqual(self.check('escape/file')['reason'], 'outside_document_tree')
        (self.root / 'inside').symlink_to(self.root / 'guide.md')
        self.assertEqual(self.check('inside')['file'], 'present')

    def test_directory(self):
        (self.root / 'directory').mkdir()
        self.assertEqual(self.check('directory'), {'file': 'not_checked', 'fragment': 'absent',
                                          'reason': 'target_not_regular_file'})

    def test_unnormalized_paths(self):
        for value in ("guide.md/", "guide.md/.", "missing/../guide.md", "guide.md/../guide.md"):
            with self.subTest(value=value):
                self.assertEqual(self.check(value)["file"], "not_checked")

    def test_source_error(self):
        self.assertEqual(checker.check_target(str(self.root / 'absent'), 'a')['file'], 'error')
        self.assertEqual(checker.check_target(str(self.root), 'a')['file'], 'error')

    def test_metadata_permission_error(self):
        original = Path.stat
        def guarded(path, *args, **kwargs):
            if path.name == 'guide.md':
                raise PermissionError('fixture')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'stat', guarded):
            self.assertEqual(self.check('guide.md')['file'], 'error')

    def test_cli(self):
        for destination, expected in [('guide.md#installation', 'present'),
                                      ('absent.md', 'missing')]:
            run = subprocess.run([sys.executable, str(SCRIPT), str(self.source), destination],
                                 cwd='/', capture_output=True, text=True)
            self.assertEqual(run.returncode, 0)
            self.assertEqual(json.loads(run.stdout)['file'], expected)
        run = subprocess.run([sys.executable, str(SCRIPT), str(self.root / 'absent'), 'x'],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(json.loads(run.stdout)['file'], 'error')
        run = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True)
        self.assertEqual(run.returncode, 2)


if __name__ == '__main__':
    unittest.main()
