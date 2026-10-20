#!/usr/bin/env python3
"""Run the installed Xinling CLI with its own home and packaged pnpm runtime."""
import os
import subprocess
import sys
from pathlib import Path

app = Path('/Applications/薪灵.app/Contents')
executable = app / 'MacOS/薪灵'
bootstrap = app / 'Resources/app.asar/lib/desktop-cli.js'
runtime = Path.home() / 'Library/Application Support/Cinlyn/runtime-commands/generations'
candidates = sorted(runtime.glob('*/bin/pnpm'), key=lambda p: p.stat().st_mtime, reverse=True)
usable = [p for p in candidates if (p.parent.parent / 'private/node-bin/node').is_file()]
if not executable.is_file() or not usable:
    sys.exit('请先启动薪灵客户端，等待初始化完成后重试。未找到薪灵内置运行环境。')
pnpm = usable[0]
node_dir = pnpm.parent.parent / 'private/node-bin'
env = dict(os.environ)
env.update({
    'DSH_HOME': str(Path.home() / '.xsh'),
    'ELECTRON_RUN_AS_NODE': '1',
    'PATH': os.pathsep.join([str(pnpm.parent), str(node_dir), env.get('PATH', '')]),
    'NODE': str(node_dir / 'node'),
})
sys.exit(subprocess.call([str(executable), '--expose-internals', str(bootstrap), *sys.argv[1:]], env=env))
