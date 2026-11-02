#!/usr/bin/env python3
"""Read-only production-path smoke checks against an isolated FC staging class.

Prompts for the viewing password. Never prints cookies, tokens, names or API data.
If ESA origin authentication is enabled, use the public ESA hostname: ESA adds
the origin token and real-client-IP headers on the way to FC.
"""
import argparse
from getpass import getpass
from http.cookiejar import CookieJar
import json
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener


class Smoke:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.jar = CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.jar))

    def fetch(self, path, *, method='GET', headers=None, data=None, opener=None):
        request = Request(self.base + '/' + path.lstrip('/'), method=method,
                          headers=headers or {},
                          data=json.dumps(data).encode() if data is not None else None)
        try:
            with (opener or self.opener).open(request, timeout=30) as response:
                return response.status, response.read(65536)
        except HTTPError as error:
            return error.code, error.read(65536)

    def expect(self, label, path, expected, **options):
        status, body = self.fetch(path, **options)
        if status != expected:
            raise RuntimeError(f'{label}: expected HTTP {expected}, got HTTP {status}')
        print(f'PASS {label}: HTTP {status}')
        return body

    def json_ok(self, label, path, **options):
        body = self.expect(label, path, 200, **options)
        try:
            data = json.loads(body)
        except (ValueError, UnicodeDecodeError) as error:
            raise RuntimeError(f'{label}: response is not JSON') from error
        if not isinstance(data, dict):
            raise RuntimeError(f'{label}: response is not a JSON object')
        return data

    def service_ok(self, label, path):
        data = self.json_ok(label, path)
        if str(data.get('status')) != '1':
            raise RuntimeError(f'{label}: upstream did not report successful AMap status')
        print(f'PASS {label}: AMap status=1')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='HTTPS public staging URL (ESA if enabled)')
    parser.add_argument('--class-slug', default='our-class', help='isolated preview class slug')
    parser.add_argument('--direct-fc-url', help='optional public FC verification URL, must deny direct access')
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.path not in ('', '/') or parsed.query:
        parser.error('--url must be a bare HTTPS origin, without path or query')
    if not args.class_slug or not all(char.isalnum() or char == '-' for char in args.class_slug):
        parser.error('--class-slug must be a simple Django slug')
    smoke = Smoke(args.url)
    root = f'c/{args.class_slug}/'
    api = root + 'api/'
    origin = f'{parsed.scheme}://{parsed.netloc}'

    health = smoke.json_ok('database health through public HTTPS', 'healthz/')
    if health.get('status') != 'ok':
        raise RuntimeError('database health returned an unexpected status')
    smoke.expect('class page and CSRF cookie', root, 200)
    token = next((cookie.value for cookie in smoke.jar if cookie.name == 'csrftoken'), '')
    if not token:
        raise RuntimeError('missing csrf cookie on class page')
    password = getpass('Isolated staging class viewing password: ')
    unlocked = smoke.json_ok('unlock test class', api + 'unlock', method='POST',
                             headers={'Content-Type': 'application/json', 'X-CSRFToken': token,
                                      'Origin': origin}, data={'password': password})
    del password
    if unlocked.get('ok') is not True:
        raise RuntimeError('class unlock did not succeed')
    boot = smoke.json_ok('unlocked bootstrap', api + 'bootstrap')
    if boot.get('unlocked') is not True:
        raise RuntimeError('class bootstrap is still locked')
    snapshot = smoke.json_ok('authenticated snapshot', api + 'snapshot',
                             headers={'Origin': origin})
    if not isinstance(snapshot.get('members'), list):
        raise RuntimeError('class snapshot has no member list')
    smoke.expect('credentialed cross-origin rejection', api + 'snapshot', 403,
                 headers={'Origin': 'https://other.example.invalid'})
    smoke.expect('originless cross-site subresource rejection', api + 'snapshot', 403,
                 headers={'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors'})

    anon = build_opener(HTTPCookieProcessor(CookieJar()))
    smoke.expect('anonymous map proxy rejection', '_AMapService/v3/config/district', 403,
                 opener=anon)
    smoke.expect('unlisted AMap path rejection', '_AMapService/v3/place/text', 400)
    smoke.service_ok('AMap district API', '_AMapService/v3/config/district?' +
                     urlencode({'keywords': '杭州', 'subdistrict': '0'}))
    smoke.service_ok('AMap GPS conversion API', '_AMapService/v3/assistant/coordinate/convert?' +
                     urlencode({'locations': '116.3,39.9', 'coordsys': 'gps'}))

    if args.direct_fc_url:
        direct = Smoke(args.direct_fc_url)
        direct.expect('direct FC URL denied without ESA origin token', 'healthz/', 403)

    print('PASS HTTP smoke checks; still verify map rendering/GPS in a real browser and edge IP buckets.')


if __name__ == '__main__':
    main()
