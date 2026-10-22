#!/usr/bin/env python3
"""把 AI 招聘助手装进薪灵当前 profile，并在安装前做前置条件自检。

不做的事：不修改用户的 cordis.patch.yml（插件所有配置都有可用默认值），
不启动浏览器、不调用任何业务接口、不触碰 ~/.xsh 以外的东西。

用法：
    python3 scripts/install-ai-recruiter.py            # 安装并自检
    python3 scripts/install-ai-recruiter.py --check    # 只自检，不安装
"""
import json
import subprocess
import sys
import tarfile
from pathlib import Path
from xinling_runtime import xinling_runtime

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
TGZ = ROOT / 'artifacts' / f'dsh-ai-recruiter-{VERSION}.tgz'
PROFILE = 'desktop'


def check_gateway():
    path = ROOT / 'browser-agent-gateway/mcp-server.js'
    return ('插件内置网关', str(path)) if path.is_file() else (None, None)


def installation_mismatches(archive_path, installed):
    """Compare package contents, including same-version local tarball replacements."""
    mismatches = []
    with tarfile.open(archive_path) as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            path = Path(member.name)
            if path.parts[0] != 'package' or '..' in path.parts:
                raise RuntimeError('安装包包含无效路径')
            relative = Path(*path.parts[1:])
            filename = installed / relative
            if not filename.is_file() or filename.read_bytes() != archive.extractfile(member).read():
                mismatches.append(str(relative))
    return mismatches


def main():
    check_only = '--check' in sys.argv
    ok = True

    try:
        runtime = xinling_runtime()
    except RuntimeError as error:
        print(f'✗ {error}')
        return 1
    print(f'✓ 当前薪灵客户端：{runtime.client_version}')
    print(f'✓ 客户端 CLI：{runtime.bootstrap}')
    print(f'✓ 客户端运行环境：{runtime.node}')

    label, path = check_gateway()
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

    installed = runtime.user_directory / '.xsh/profiles' / PROFILE / 'node_modules/dsh-ai-recruiter'
    manifest = installed / 'package.json'
    if manifest.is_file() and json.loads(manifest.read_text()).get('version') == VERSION:
        if installation_mismatches(TGZ, installed):
            print('✗ 同版本安装包内容已变化，请递增插件版本并重新打包后安装，避免复用旧缓存。')
            return 1
        print('\n✓ 当前版本已安装，全部文件与安装包一致，无需重复安装。')
        return 0
    print(f'\n安装到 profile「{PROFILE}」…')
    code = subprocess.call(
        runtime.command('plugin', '--profile', PROFILE, 'add', str(TGZ)),
        env=runtime.environment(),
    )
    if code:
        print('✗ 安装失败。')
        return code

    mismatches = installation_mismatches(TGZ, installed)
    if mismatches:
        print('✗ 安装后文件与安装包不一致：' + '、'.join(mismatches[:5]))
        return 1
    print('\n✓ 已安装，全部文件与安装包一致。接下来：')
    print('  1) 完全退出并重开薪灵（插件在启动时挂载）。')
    print('  2) 安装并启用正式版薪招扩展，插件启动后自动注册本机桥接并连接。')
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
