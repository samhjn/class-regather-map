"""Update and maintain an existing FC deployment without public admin endpoints."""
import argparse
import base64
import getpass
import io
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit
import uuid

from alibabacloud_credentials.client import Client as Credentials
from alibabacloud_fc20230330.client import Client
from alibabacloud_fc20230330 import models as fc
from alibabacloud_tea_openapi.models import Config
from alibabacloud_tea_util.models import RuntimeOptions

ROOT = Path(__file__).resolve().parents[1]


def wait_ready(client, name):
    for _ in range(24):
        info = client.get_function(name, fc.GetFunctionRequest()).body
        if info.state == 'Failed' or info.last_update_status == 'Failed':
            raise RuntimeError('FC initialization failed; inspect the function console.')
        # Some FC regions omit both status fields. A successful invocation below
        # is the readiness proof; do not wait forever for an omitted field.
        if info.state not in ('Pending', 'Creating', 'Updating') and info.last_update_status != 'InProgress':
            return info
        time.sleep(5)
    raise TimeoutError('FC is still updating; inspect the function console before retrying.')


def maintenance(client, source, code, action, extra_env=None):
    name = source.function_name[:40] + '-ops-' + uuid.uuid4().hex[:8]
    env = dict(source.environment_variables)
    env.update(extra_env or {})
    body = fc.CreateFunctionInput(
        function_name=name, description='Temporary IAM-only class-regather-map maintenance',
        runtime='python3.12', handler='fc_migrate.handler', code=fc.InputCodeLocation(zip_file=code),
        environment_variables=env, cpu=0.5, memory_size=512, disk_size=512, timeout=180,
        instance_concurrency=1, internet_access=False, vpc_config=source.vpc_config)
    created = False
    try:
        client.create_function(fc.CreateFunctionRequest(body=body))
        created = True
        wait_ready(client, name)
        response = client.invoke_function_with_options(
            name, fc.InvokeFunctionRequest(body=io.BytesIO(json.dumps({'action': action}).encode())),
            fc.InvokeFunctionHeaders(x_fc_invocation_type='Sync'),
            RuntimeOptions(connect_timeout=10000, read_timeout=190000))
        result = json.loads(response.body.read())
        if result.get('status') != 'ok' or not result.get('write_read_rollback'):
            raise RuntimeError('Maintenance validation failed.')
        return result
    finally:
        if created:
            try:
                client.delete_function(name)
            except Exception:
                # Never hide a cleanup failure: the caller must remove this named resource.
                print(f'Cleanup needed: delete temporary function {name}.')
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('create', 'update', 'migrate', 'check', 'bootstrap'))
    parser.add_argument('--account', required=True, help='Alibaba Cloud account ID (not an AccessKey)')
    parser.add_argument('--region', required=True)
    parser.add_argument('--function', default='class-regather-map')
    parser.add_argument('--zip', type=Path, default=ROOT / '.fc/code.zip')
    parser.add_argument('--config', type=Path, help='Function JSON configuration, for create only')
    parser.add_argument('--public-http', action='store_true', help='Explicitly create the public HTTP trigger')
    parser.add_argument('--prompt-credentials', action='store_true', help='Read AK/SK without echo; keep them in memory')
    args = parser.parse_args()
    if args.prompt_credentials:
        os.environ['ALIBABA_CLOUD_ACCESS_KEY_ID'] = getpass.getpass('AccessKey ID: ')
        os.environ['ALIBABA_CLOUD_ACCESS_KEY_SECRET'] = getpass.getpass('AccessKey Secret: ')
    client = Client(Config(credential=Credentials(),
                           endpoint=f'{args.account}.{args.region}.fc.aliyuncs.com',
                           connect_timeout=10000, read_timeout=60000))
    archive = args.zip.read_bytes()
    if len(archive) > 50 * 1024 * 1024:
        raise ValueError('The inline code ZIP exceeds 50 MiB.')
    code = base64.b64encode(archive).decode()
    if args.action == 'create':
        if not args.config or not args.public_http:
            parser.error('create requires --config and --public-http; database provisioning is separate.')
        config = json.loads(args.config.read_text(encoding='utf-8'))
        config['functionName'] = args.function
        config['code'] = {'zipFile': code}
        env = config['environmentVariables']
        env['SECRET_KEY'] = os.getenv('SECRET_KEY') or secrets.token_urlsafe(64)
        env['MYSQL_PASSWORD'] = os.getenv('MYSQL_PASSWORD') or getpass.getpass('RDS application account password: ')
        client.create_function(fc.CreateFunctionRequest(body=fc.CreateFunctionInput().from_map(config)))
    source = wait_ready(client, args.function)
    if source.runtime != 'custom.debian11' or source.environment_variables.get('REGATHER_FC') != '1':
        raise ValueError('The target is not a class-regather-map FC deployment.')
    extra = {}
    if args.action == 'bootstrap':
        extra['DJANGO_SUPERUSER_USERNAME'] = input('Administrator username [class-admin]: ').strip() or 'class-admin'
        extra['DJANGO_SUPERUSER_PASSWORD'] = getpass.getpass('Administrator password: ')
        extra['CLASS_UNLOCK_PASSWORD'] = getpass.getpass('Class viewing password: ')
        extra['CLASS_NAME'] = input('Class name [我们的班级]: ').strip() or '我们的班级'
    result = maintenance(client, source, code, 'migrate' if args.action in ('create', 'update') else args.action, extra)
    if args.action == 'create':
        trigger = client.create_trigger(args.function, fc.CreateTriggerRequest(body=fc.CreateTriggerInput(
            trigger_name='web', trigger_type='http', qualifier='LATEST',
            trigger_config=json.dumps({'authType': 'anonymous', 'methods': ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']})
        ))).body
        url = trigger.http_trigger.url_internet
        env = dict(source.environment_variables)
        env.update(ALLOWED_HOSTS=urlsplit(url).hostname,
                   CSRF_TRUSTED_ORIGINS='https://' + urlsplit(url).netloc)
        client.update_function(args.function, fc.UpdateFunctionRequest(body=fc.UpdateFunctionInput(environment_variables=env)))
        client.put_concurrency_config(args.function, fc.PutConcurrencyConfigRequest(
            body=fc.PutConcurrencyInput(reserved_concurrency=8)))
        wait_ready(client, args.function)
        print('HTTP verification URL: ' + url)
    if args.action == 'update':
        client.update_function(args.function, fc.UpdateFunctionRequest(body=fc.UpdateFunctionInput(
            code=fc.InputCodeLocation(zip_file=code))))
        wait_ready(client, args.function)
    print(json.dumps({'function': args.function, 'operation': args.action, **result}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SDK errors may include submitted parameters. Do not dump them or credentials.
        print(f'FC operation failed: {getattr(error, "code", type(error).__name__)}')
        raise SystemExit(1)
