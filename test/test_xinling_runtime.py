import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from xinling_runtime import xinling_runtime

spec = importlib.util.spec_from_file_location('recruiter_installer', Path(__file__).resolve().parents[1] / 'scripts/install-ai-recruiter.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class CurrentClientRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / '薪灵.app/Contents'
        self.user = self.root / 'user'
        self.executable = self.app / 'MacOS/薪灵'
        self.bootstrap = self.app / 'Resources/app/lib/desktop-cli.js'
        self.pnpm_entry = self.app / 'Resources/app/node_modules/pnpm/bin/pnpm.mjs'
        for filename in [self.executable, self.bootstrap, self.pnpm_entry]:
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_text('current client')
        (self.app / 'Resources/app/package.json').write_text(json.dumps({'version': '2.0.18'}))
        self.query = patch('xinling_runtime.subprocess.check_output', return_value='44.0.0\n').start()
        self.addCleanup(patch.stopall)

    def generation(self, name, target='44.0.0', entry=None):
        directory = self.user / 'Library/Application Support/Cinlyn/runtime-commands/generations' / name
        contents = {
            'bin/pnpm': f"#!/bin/sh\nnpm_config_target='{target}' exec '{self.executable}' '{entry or self.pnpm_entry}'\n",
            'private/node-bin/node': f"#!/bin/sh\nexec '{self.executable}'\n",
            'private/clear-env.cjs': 'delete process.env.ELECTRON_RUN_AS_NODE\n',
        }
        files = []
        for name, text in contents.items():
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            files.append({'path': name, 'sha256': hashlib.sha256(text.encode()).hexdigest()})
        (directory / '.generation.json').write_text(json.dumps({'schemaVersion': 1, 'kind': 'pnpm', 'platform': 'darwin', 'files': files}))
        return directory

    def test_newer_timestamp_cannot_select_an_old_client_runtime(self):
        current = self.generation('a-current')
        old = self.generation('z-previous', entry=self.root / 'previous-client/pnpm.mjs')
        os.utime(old / 'bin/pnpm', (2_000_000_000, 2_000_000_000))
        runtime = xinling_runtime(self.app, self.user)
        self.assertEqual(runtime.bootstrap, self.bootstrap)
        self.assertEqual(runtime.pnpm, current / 'bin/pnpm')
        self.assertEqual(runtime.client_version, '2.0.18')

    def test_electron_target_must_match_the_current_executable(self):
        self.generation('old-electron', target='37.0.0')
        with self.assertRaisesRegex(RuntimeError, 'Electron'):
            xinling_runtime(self.app, self.user)
        current = self.generation('current-electron')
        self.assertEqual(xinling_runtime(self.app, self.user).pnpm, current / 'bin/pnpm')

    def test_old_install_layout_is_rejected_without_probing_it(self):
        self.bootstrap.unlink()
        old = self.app / 'Resources/app.asar/lib/desktop-cli.js'
        old.parent.mkdir(parents=True)
        old.write_text('old client')
        with self.assertRaisesRegex(RuntimeError, '不再支持旧版安装布局'):
            xinling_runtime(self.app, self.user)
        self.query.assert_not_called()

    def test_tampered_runtime_is_not_executed(self):
        directory = self.generation('tampered')
        (directory / 'bin/pnpm').write_text('unrelated command')
        with self.assertRaisesRegex(RuntimeError, '初始化'):
            xinling_runtime(self.app, self.user)

    def test_environment_removes_old_runtime_directories_and_preserves_system_path(self):
        current = self.generation('current')
        runtime = xinling_runtime(self.app, self.user)
        old = current.parent / 'old/bin'
        with patch.dict(os.environ, {'PATH': f'{old}:/usr/bin:/bin', 'DSH_HOME': '/other', 'NODE': '/other/node'}):
            env = runtime.environment()
        self.assertNotIn(str(old), env['PATH'])
        self.assertEqual(env['PATH'].split(os.pathsep)[-2:], ['/usr/bin', '/bin'])
        self.assertEqual(env['NODE'], str(runtime.node))
        self.assertEqual(env['DSH_HOME'], str(self.user / '.xsh'))
        self.assertEqual(runtime.command('--version'), [str(self.executable), '--expose-internals', str(self.bootstrap), '--version'])


class InstalledPackageTests(unittest.TestCase):
    def test_same_version_cache_cannot_pass_content_verification(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive_path = root / 'package.tgz'
            files = {'package.json': b'{"version":"0.1.183"}', 'skills/recruitment-matching/SKILL.md': b'new skill'}
            with tarfile.open(archive_path, 'w:gz') as archive:
                for name, content in files.items():
                    member = tarfile.TarInfo('package/' + name)
                    member.size = len(content)
                    archive.addfile(member, io.BytesIO(content))
            installed = root / 'installed'
            installed.mkdir()
            (installed / 'package.json').write_bytes(files['package.json'])
            self.assertEqual(installer.installation_mismatches(archive_path, installed), ['skills/recruitment-matching/SKILL.md'])
            for name, content in files.items():
                path = installed / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            self.assertEqual(installer.installation_mismatches(archive_path, installed), [])


if __name__ == '__main__':
    unittest.main()
