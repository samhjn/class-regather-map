from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from django.contrib.auth.hashers import make_password
from django.test import TestCase, override_settings

from gathering.models import Classroom


@override_settings(SECURE_SSL_REDIRECT=False, AMAP_PROXY_ENABLED=True,
                   AMAP_JS_KEY='test-js-key', AMAP_PROXY_SECURITY_CODE='server-only-security',
                   AMAP_SECURITY_JS_CODE='', PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class AMapProxyTests(TestCase):
    def setUp(self):
        self.room = Classroom.objects.create(slug='map', name='地图测试', unlock_password=make_password('view-password'))
        self.url = '/_AMapService/v3/config/district'
        self.mock = patch('gathering.amap_proxy.http.client.HTTPSConnection').start()
        self.addCleanup(patch.stopall)
        response = self.mock.return_value.getresponse.return_value
        response.status = 200
        response.read.return_value = b'{"status":"1"}'
        response.getheader.side_effect = lambda name, default=None: {'Content-Type': 'application/json'}.get(name, default)

    def unlock(self):
        self.client.post('/c/map/api/unlock', {'password': 'view-password'}, content_type='application/json')
        return self.client.get('/c/map/api/bootstrap')

    def test_proxy_requires_current_class_access(self):
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.client.get('/c/map/api/bootstrap')
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.mock.assert_not_called()
        boot = self.unlock()
        self.assertNotContains(boot, 'server-only-security')
        self.assertEqual(self.client.get(self.url).status_code, 200)
        self.mock.reset_mock()
        self.room.gate_version += 1
        self.room.save()
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.mock.assert_not_called()

    def test_disabled_or_incomplete_configuration_is_unavailable(self):
        for changes in ({'AMAP_PROXY_ENABLED': False}, {'AMAP_PROXY_SECURITY_CODE': ''}, {'AMAP_JS_KEY': ''}):
            with self.settings(**changes):
                self.assertEqual(self.client.get(self.url).status_code, 503)
        self.mock.assert_not_called()

    def test_upstream_routes_and_server_secret_cannot_be_overridden(self):
        self.unlock()
        for resource, host in [('v4/map/styles', 'webapi.amap.com'), ('v3/vectormap', 'fmap01.amap.com'),
                               ('v3/config/district', 'restapi.amap.com'), ('v3/geocode/geo', 'restapi.amap.com')]:
            response = self.client.get('/_AMapService/' + resource,
                {'key': 'test-js-key', 'jscode': ['malicious', 'duplicate'], 'JSCODE': 'mixed-case', 'keywords': '杭州'},
                HTTP_AUTHORIZATION='Bearer private-token')
            self.assertEqual(response.status_code, 200)
            self.mock.assert_called_with(host, timeout=10)
            args, kwargs = self.mock.return_value.request.call_args
            self.assertEqual(args[0], 'GET')
            self.assertEqual(urlsplit(args[1]).path, '/' + resource)
            query = parse_qs(urlsplit(args[1]).query)
            self.assertEqual(query['jscode'], ['server-only-security'])
            self.assertEqual(query['key'], ['test-js-key'])
            self.assertNotIn('JSCODE', query)
            self.assertEqual(kwargs['headers'], {'Accept': '*/*', 'Accept-Encoding': 'identity'})
            self.assertNotContains(response, 'server-only-security')
            self.assertEqual(response['Cache-Control'], 'private, no-store')

    def test_invalid_paths_keys_and_callbacks_never_reach_upstream(self):
        self.unlock()
        for path, query in [('https://example.com/v3/config/district', {}), ('v3/../admin', {}),
                            ('v3//config/district', {}), ('v3/config/district', {'key': 'wrong'}),
                            ('v3/config/district', {'key': ['test-js-key', 'test-js-key']}),
                            ('v3/config/district', {'callback': 'alert(1)'}),
                            ('v3/config/district', {'keywords': 'x' * 17000})]:
            with self.subTest(path=path, query=list(query)):
                self.assertEqual(self.client.get('/_AMapService/' + path, query).status_code, 400)
        self.assertEqual(self.client.post(self.url).status_code, 405)
        self.mock.assert_not_called()

    def test_jsonp_has_executable_content_type_with_nosniff(self):
        self.unlock()
        response = self.client.get(self.url, {'callback': 'AMap._callback42'})
        self.assertEqual(response['Content-Type'], 'application/javascript; charset=utf-8')
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')

    def test_upstream_failure_redirect_and_oversized_body_are_not_exposed(self):
        self.unlock()
        upstream = self.mock.return_value
        upstream.request.side_effect = TimeoutError('https://restapi.amap.com/?jscode=server-only-security')
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 502)
        self.assertNotContains(response, 'server-only-security', status_code=502)
        upstream.close.assert_called()
        upstream.request.side_effect = None
        upstream.getresponse.return_value.status = 302
        self.assertEqual(self.client.get(self.url).status_code, 502)
        upstream.getresponse.return_value.status = 200
        with patch('gathering.amap_proxy.MAX_RESPONSE_BYTES', 2):
            self.assertEqual(self.client.get(self.url).status_code, 502)
