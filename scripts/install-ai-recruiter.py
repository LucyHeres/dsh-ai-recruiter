#!/usr/bin/env python3
"""把 AI 招聘助手装进薪灵当前 profile，并在安装前做前置条件自检。

不做的事：不修改用户的 cordis.patch.yml（插件所有配置都有可用默认值），
不启动浏览器、不调用任何业务接口、不触碰 ~/.xsh 以外的东西。

用法：
    python3 scripts/install-ai-recruiter.py            # 安装并自检
    python3 scripts/install-ai-recruiter.py --check    # 只自检，不安装
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
TGZ = ROOT / 'artifacts' / f'dsh-ai-recruiter-{VERSION}.tgz'
PROFILE = 'desktop'
APP = Path('/Applications/薪灵.app/Contents')


def xinling_runtime():
    """定位薪灵内置的 Node 与 pnpm（与 scripts/xinling-dsh.py 同一套）。"""
    generations = Path.home() / 'Library/Application Support/Cinlyn/runtime-commands/generations'
    pnpm = [p for p in sorted(generations.glob('*/bin/pnpm'), key=lambda p: p.stat().st_mtime, reverse=True)
            if (p.parent.parent / 'private/node-bin/node').is_file()]
    if not (APP / 'MacOS/薪灵').is_file() or not pnpm:
        return None
    return pnpm[0], pnpm[0].parent.parent / 'private/node-bin/node'


def check_gateway(node):
    path = ROOT / 'browser-agent-gateway/mcp-server.js'
    return ('插件内置网关', str(path)) if path.is_file() else (None, None)


def main():
    check_only = '--check' in sys.argv
    ok = True

    runtime = xinling_runtime()
    if not runtime:
        print('✗ 未找到薪灵内置运行环境。请先启动薪灵客户端，等初始化完成后再试。')
        return 1
    pnpm, node = runtime
    print(f'✓ 薪灵运行环境：{node}')

    label, path = check_gateway(node)
    if path:
        print(f'✓ 薪招网关 MCP 入口（{label}）：{path}')
    else:
        ok = False
        print('✗ 未找到薪招网关 mcp-server.js。安装包不完整，请重新构建，')
        print('  或在配置里显式指定 browserMcpArgs。')

    if not TGZ.is_file():
        print(f'✗ 缺少安装包 {TGZ}。先运行 npm run pack。')
        return 1
    print(f'✓ 安装包：{TGZ.name}（{TGZ.stat().st_size // 1024} KiB）')

    if not ok:
        print('前置检查未通过，未安装。')
        return 1

    if check_only:
        print('\n自检结束（未安装）。')
        return 0 if ok else 1

    env = dict(os.environ)
    env.update({
        'DSH_HOME': str(Path.home() / '.xsh'),
        'ELECTRON_RUN_AS_NODE': '1',
        'PATH': os.pathsep.join([str(pnpm.parent), str(node.parent), env.get('PATH', '')]),
        'NODE': str(node),
    })
    print(f'\n安装到 profile「{PROFILE}」…')
    code = subprocess.call(
        [str(APP / 'MacOS/薪灵'), '--expose-internals', str(APP / 'Resources/app.asar/lib/desktop-cli.js'),
         'plugin', '--profile', PROFILE, 'add', str(TGZ)],
        env=env,
    )
    if code:
        print('✗ 安装失败。')
        return code

    print('\n✓ 已安装。接下来：')
    print('  1) 完全退出并重开薪灵（插件在启动时挂载）。')
    print('  2) 首次使用先运行 node browser-agent-gateway/manage.cjs setup，')
    print('     在薪招扩展设置中导入生成的配对文件，结束已有任务后重新加载扩展。')
    print('  3) 新建会话，调用 ai_recruit_help，确认：')
    print('       browser.available = true（包内 MCP 工具可发现）')
    print('       browser.ready = true 才表示网关与扩展已连接')
    print('       browser.gatewaySource 显示自动探测到的路径')
    print('       浏览器自动化可独立使用；简历入库另需 authorization.available = true')
    print('  4) 调用 ai_recruit_browser_tools 发现工具，用 ai_recruit_browser_call 执行浏览器任务。')
    print('  5) 简历入库前调用 ai_recruit_auth_check，确认 authenticated 和 recruitmentReady 都为 true。')
    print('\n  卸载：薪灵插件管理移除 dsh-ai-recruiter，或')
    print('        python3 scripts/xinling-dsh.py plugin --profile desktop remove dsh-ai-recruiter')
    return 0


if __name__ == '__main__':
    sys.exit(main())
