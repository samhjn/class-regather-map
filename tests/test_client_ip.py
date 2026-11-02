from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings

from gathering.client_ip import client_ip
from gathering.models import Classroom, Member
from gathering.services import throttle


class ClientIPTests(SimpleTestCase):
    def address(self, forwarded='', peer='10.0.0.10'):
        return client_ip(RequestFactory().get('/', REMOTE_ADDR=peer, HTTP_X_FORWARDED_FOR=forwarded))

    @override_settings(TRUSTED_PROXY_HOPS=0)
    def test_direct_deployment_ignores_spoofed_forwarding_headers(self):
        self.assertEqual(self.address('203.0.113.99'), '10.0.0.10')

    @override_settings(TRUSTED_PROXY_HOPS=1)
    def test_only_gateway_added_suffix_is_used(self):
        for prefix in ('198.51.100.1', 'invalid', '198.51.100.2, 198.51.100.3'):
            self.assertEqual(self.address(prefix + ', 203.0.113.10'), '203.0.113.10')

    @override_settings(TRUSTED_PROXY_HOPS=2)
    def test_multiple_trusted_proxies_and_short_or_malformed_chains(self):
        self.assertEqual(self.address('spoofed, 203.0.113.10, 10.0.0.20'), '203.0.113.10')
        for forwarded in ('203.0.113.10', '203.0.113.10, invalid', ', 10.0.0.20'):
            self.assertEqual(self.address(forwarded), '10.0.0.10')

    @override_settings(TRUSTED_PROXY_HOPS=1)
    def test_missing_invalid_or_oversized_header_falls_back_to_peer(self):
        for forwarded in ('', 'unknown', '203.0.113.10:80', '[2001:db8::1]', 'fe80::1%eth0', 'x' * 8193):
            self.assertEqual(self.address(forwarded), '10.0.0.10')

    @override_settings(TRUSTED_PROXY_HOPS=1)
    def test_equivalent_ipv6_and_ipv4_mapped_addresses_share_identity(self):
        self.assertEqual(self.address(' 2001:0db8:0000:0000:0000:0000:0000:0001 '), '2001:db8::1')
        self.assertEqual(self.address('::ffff:203.0.113.10'), '203.0.113.10')

    @override_settings(TRUSTED_PROXY_HOPS=1, ESA_ORIGIN_SECRET='unit-test-edge-token-0123456789-abcdefgh')
    def test_authenticated_esa_identity_overrides_all_xff_data(self):
        request = RequestFactory().get('/', REMOTE_ADDR='10.0.0.10',
            HTTP_X_FORWARDED_FOR='198.51.100.23, 10.0.0.20',
            HTTP_X_REGATHER_CLIENT_IP='203.0.113.41',
            HTTP_X_REGATHER_ORIGIN_TOKEN='unit-test-edge-token-0123456789-abcdefgh')
        self.assertEqual(client_ip(request), '203.0.113.41')
        request.META['HTTP_X_REGATHER_ORIGIN_TOKEN'] = 'forged'
        # The attacker-supplied true-client header is untrusted without the token.
        self.assertEqual(client_ip(request), '10.0.0.10')
        request.META['HTTP_X_REGATHER_ORIGIN_TOKEN'] = 'unit-test-edge-token-0123456789-abcdefgh'
        request.META['HTTP_X_REGATHER_CLIENT_IP'] = 'not-an-ip'
        self.assertEqual(client_ip(request), '10.0.0.10')


@override_settings(TRUSTED_PROXY_HOPS=1, SECURE_SSL_REDIRECT=False,
                   PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class ProxyThrottleTests(TestCase):
    def setUp(self):
        self.room = Classroom.objects.create(slug='proxy', name='代理测试', unlock_password=make_password('view-password'))
        self.first = Client(REMOTE_ADDR='10.0.0.10', HTTP_X_FORWARDED_FOR='203.0.113.10')
        self.second = Client(REMOTE_ADDR='10.0.0.10', HTTP_X_FORWARDED_FOR='203.0.113.20')

    def unlock(self, client, password='view-password', **headers):
        return client.post('/c/proxy/api/unlock', {'password': password}, content_type='application/json', **headers)

    def test_one_clients_failures_do_not_block_another_on_the_same_gateway(self):
        for _ in range(60):
            self.assertEqual(self.unlock(self.first, 'wrong').status_code, 403)
        self.assertEqual(self.unlock(self.first).status_code, 429)
        self.assertEqual(self.unlock(self.second).status_code, 200)
        # Changing the untrusted prefix cannot reset the attacker's bucket.
        self.assertEqual(self.unlock(self.first, HTTP_X_FORWARDED_FOR='198.51.100.99, 203.0.113.10').status_code, 429)

    def test_account_limit_still_applies_across_different_client_ips(self):
        user = get_user_model().objects.create_user('member', password='member-password')
        Member.objects.create(classroom=self.room, user=user, student_code='001', name='同学')
        for index in range(15):
            response = self.first.post('/c/proxy/api/login', {'name': '同学', 'password': 'wrong'},
                content_type='application/json', HTTP_X_FORWARDED_FOR=f'203.0.113.{index + 1}')
            self.assertEqual(response.status_code, 403)
        response = self.second.post('/c/proxy/api/login', {'name': '同学', 'password': 'member-password'}, content_type='application/json')
        self.assertEqual(response.status_code, 429)

    def test_admin_login_uses_the_same_client_identity(self):
        for _ in range(20):
            throttle('system-admin-login', '203.0.113.10', 20)
        self.assertEqual(self.first.post('/admin/login/', {}).status_code, 429)
        self.assertEqual(self.second.post('/admin/login/', {}).status_code, 200)
