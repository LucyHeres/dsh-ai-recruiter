#!/usr/bin/env python3
"""Run the current Xinling desktop CLI using its matching command runtime."""
import subprocess
import sys
from xinling_runtime import xinling_runtime

def main():
    try:
        runtime = xinling_runtime()
    except RuntimeError as error:
        print(f'✗ {error}', file=sys.stderr)
        return 1
    return subprocess.call(runtime.command(*sys.argv[1:]), env=runtime.environment())


if __name__ == '__main__':
    sys.exit(main())
