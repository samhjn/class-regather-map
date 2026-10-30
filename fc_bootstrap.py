"""FC custom runtime entrypoint. Migrations run separately through fc_migrate."""
import os
import sys


def command(environ):
    required = ('SECRET_KEY', 'MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD')
    missing = [name for name in required if not environ.get(name)]
    if missing:
        raise RuntimeError('Missing FC configuration: ' + ', '.join(missing))
    if environ.get('DEBUG', '0') != '0':
        raise RuntimeError('FC must run with DEBUG=0.')
    port = int(environ.get('PORT', '9000'))
    threads = int(environ.get('GUNICORN_THREADS', '4'))
    if not 1 <= port <= 65535 or not 1 <= threads <= 32:
        raise RuntimeError('Invalid PORT or GUNICORN_THREADS.')
    return [sys.executable, '-m', 'gunicorn', 'config.wsgi:application',
            '--bind', f'0.0.0.0:{port}', '--workers', '1', '--worker-class', 'gthread',
            '--threads', str(threads), '--worker-tmp-dir', '/tmp', '--timeout', '60',
            '--graceful-timeout', '30', '--keep-alive', '86400',
            '--forwarded-allow-ips', '*', '--access-logfile', '-', '--error-logfile', '-',
            # Do not log query strings, cookies, or credentials.
            '--access-logformat', '%(h)s %(m)s %(U)s %(s)s %(L)s']


if __name__ == '__main__':
    os.environ.setdefault('REGATHER_FC', '1')
    os.environ.setdefault('MYSQL_CONN_MAX_AGE', '0')
    args = command(os.environ)
    os.execv(args[0], args)
