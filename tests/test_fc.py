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

    def test_client_ip_proxy_trust_has_safe_defaults_and_validated_overrides(self):
        env = {key: value for key, value in os.environ.items()
               if not key.startswith('MYSQL_') and key not in ('REGATHER_FC', 'TRUSTED_PROXY_HOPS')}
        env.update(SECRET_KEY='configuration-test-only', DEBUG='0', TRUST_PROXY='1')
        cases = [({}, '0'), ({**self.env, 'REGATHER_FC': '1'}, '1'),
                 ({**self.env, 'REGATHER_FC': '1', 'TRUSTED_PROXY_HOPS': '0'}, '0'),
                 ({'TRUSTED_PROXY_HOPS': '2'}, '2')]
        for changes, expected in cases:
            with self.subTest(expected=expected, fc=changes.get('REGATHER_FC')):
                result = subprocess.run([sys.executable, '-c',
                    'from config.settings import TRUSTED_PROXY_HOPS; print(TRUSTED_PROXY_HOPS)'],
                    cwd=Path(__file__).resolve().parents[1], env={**env, **changes}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), expected)
        for invalid in ('-1', '9', 'invalid'):
            result = subprocess.run([sys.executable, '-c', 'import config.settings'],
                cwd=Path(__file__).resolve().parents[1], env={**env, 'TRUSTED_PROXY_HOPS': invalid}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('TRUSTED_PROXY_HOPS must be an integer from 0 to 8.', result.stderr)
