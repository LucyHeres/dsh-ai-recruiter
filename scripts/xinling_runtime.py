"""Resolve the current installed Xinling desktop CLI and its own command runtime."""
import hashlib
import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

APP = Path('/Applications/薪灵.app/Contents')


@dataclass(frozen=True)
class XinlingRuntime:
    executable: Path
    bootstrap: Path
    pnpm: Path
    node: Path
    user_directory: Path
    client_version: str

    def command(self, *args):
        return [str(self.executable), '--expose-internals', str(self.bootstrap), *args]

    def environment(self):
        env = dict(os.environ)
        runtime_root = self.user_directory / 'Library/Application Support/Cinlyn/runtime-commands'
        # An inherited PATH may still refer to generations from an earlier app.
        inherited = [entry for entry in env.get('PATH', '').split(os.pathsep)
                     if entry and not Path(entry).is_relative_to(runtime_root)]
        env.update({
            'DSH_HOME': str(self.user_directory / '.xsh'),
            'ELECTRON_RUN_AS_NODE': '1',
            'PATH': os.pathsep.join([str(self.pnpm.parent), str(self.node.parent), *inherited]),
            'NODE': str(self.node),
        })
        return env


def _verified_generation(directory):
    """Check the current client's immutable runtime ownership manifest."""
    try:
        manifest = json.loads((directory / '.generation.json').read_text())
        if (manifest.get('schemaVersion'), manifest.get('kind'), manifest.get('platform')) != (1, 'pnpm', 'darwin'):
            return False
        expected = {'bin/pnpm', 'private/node-bin/node', 'private/clear-env.cjs'}
        files = manifest.get('files', [])
        if {item['path'] for item in files} != expected:
            return False
        return all(not (directory / item['path']).is_symlink()
                   and hashlib.sha256((directory / item['path']).read_bytes()).hexdigest() == item['sha256']
                   for item in files)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def xinling_runtime(app=APP, user_directory=None):
    user_directory = user_directory or Path.home()
    executable = app / 'MacOS/薪灵'
    package = app / 'Resources/app'
    bootstrap = package / 'lib/desktop-cli.js'
    pnpm_entry = package / 'node_modules/pnpm/bin/pnpm.mjs'
    for path in [executable, bootstrap, pnpm_entry, package / 'package.json']:
        if not path.is_file():
            raise RuntimeError(f'当前薪灵客户端文件缺失：{path}。请安装当前客户端；不再支持旧版安装布局。')
    try:
        client_version = json.loads((package / 'package.json').read_text())['version']
        env = dict(os.environ, ELECTRON_RUN_AS_NODE='1')
        electron_version = subprocess.check_output(
            [str(executable), '-p', 'process.versions.electron'], env=env, text=True, timeout=10,
        ).strip()
        if not electron_version or electron_version == 'undefined':
            raise ValueError('缺少 Electron 版本')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        raise RuntimeError(f'无法读取当前薪灵客户端运行环境：{error}') from error

    generations = user_directory / 'Library/Application Support/Cinlyn/runtime-commands/generations'
    for directory in sorted(generations.glob('*')):
        if directory.is_symlink() or not _verified_generation(directory):
            continue
        pnpm, node = directory / 'bin/pnpm', directory / 'private/node-bin/node'
        try:
            pnpm_args = shlex.split(pnpm.read_text())
            node_args = shlex.split(node.read_text())
        except (OSError, ValueError):
            continue
        if (str(executable) in pnpm_args and str(pnpm_entry) in pnpm_args
                and f'npm_config_target={electron_version}' in pnpm_args
                and str(executable) in node_args):
            return XinlingRuntime(executable, bootstrap, pnpm, node, user_directory, client_version)
    raise RuntimeError('未找到与当前薪灵路径和 Electron 版本一致的运行环境。请启动当前薪灵完成初始化后重试。')
