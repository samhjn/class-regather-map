import os
from pathlib import Path
import subprocess
import sys
from unittest import TestCase

from fc_bootstrap import command


class FunctionComputeTests(TestCase):
    def setUp(self):
        self.env = {name: 'test-only' for name in
                    ('SECRET_KEY', 'MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD')}

    def test_startup_refuses_ephemeral_database_or_debug(self):
        with self.assertRaisesRegex(RuntimeError, 'MYSQL_HOST'):
            command({key: value for key, value in self.env.items() if key != 'MYSQL_HOST'})
        with self.assertRaisesRegex(RuntimeError, 'DEBUG=0'):
            command({**self.env, 'DEBUG': '1'})

    def test_server_uses_fc_port_and_writable_temp_without_query_logs(self):
        args = command({**self.env, 'PORT': '9001', 'GUNICORN_THREADS': '2'})
        self.assertEqual(args[args.index('--bind') + 1], '0.0.0.0:9001')
        self.assertEqual(args[args.index('--worker-tmp-dir') + 1], '/tmp')
        self.assertNotIn('%(q)', args[args.index('--access-logformat') + 1])
        self.assertNotIn('migrate', args)

    def test_django_fc_configuration_cannot_fall_back_to_sqlite(self):
        env = {key: value for key, value in os.environ.items() if not key.startswith('MYSQL_')}
        env.update(REGATHER_FC='1', SECRET_KEY='configuration-test-only', DEBUG='0')
        result = subprocess.run([sys.executable, '-c', 'import config.settings'],
                                cwd=Path(__file__).resolve().parents[1],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FC requires MYSQL_HOST', result.stderr)
