"""Build a Linux/Python 3.12 FC ZIP from Windows, macOS or Linux."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def build(output):
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='fc-build-', dir=output.parent) as directory:
        package = Path(directory)
        # Explicit allowlist: no .env, credentials, databases, VCS or test artifacts.
        for name in ('config', 'gathering'):
            shutil.copytree(ROOT / name, package / name,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        for name in ('manage.py', 'fc_bootstrap.py', 'fc_migrate.py', 'requirements.txt'):
            shutil.copy2(ROOT / name, package / name)
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
                        '--no-compile', '--only-binary=:all:', '--implementation', 'cp',
                        '--python-version', '3.12', '--abi', 'cp312',
                        '--platform', 'manylinux_2_28_x86_64', '--platform', 'manylinux2014_x86_64',
                        '--target', str(package / 'python'), '-r', str(ROOT / 'requirements.txt')], check=True)
        env = os.environ.copy()
        # collectstatic runs with host dependencies, not Linux binary wheels.
        for name in list(env):
            if name.startswith('MYSQL_') or name in ('PYTHONPATH', 'DJANGO_SETTINGS_MODULE', 'REGATHER_FC'):
                env.pop(name)
        env.update(SECRET_KEY='static-build-only-not-a-runtime-secret', DEBUG='0', PYTHONDONTWRITEBYTECODE='1')
        subprocess.run([sys.executable, 'manage.py', 'collectstatic', '--noinput'],
                       cwd=package, env=env, check=True)
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(package.rglob('*')):
                if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
                    archive.write(path, path.relative_to(package).as_posix())
    print(f'Built {output.name}: {output.stat().st_size} bytes; sha256={hashlib.sha256(output.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.fc' / 'code.zip')
    build(parser.parse_args().output)
