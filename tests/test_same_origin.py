"""FC's default CORS echo must never expose authenticated class data."""
from django.contrib.auth.hashers import make_password
from django.test import TestCase, override_settings

from gathering.models import Classroom


@override_settings(SECURE_SSL_REDIRECT=False,
                   PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class SameOriginTests(TestCase):
    def setUp(self):
        self.room = Classroom.objects.create(slug='map', name='Test map',
                                             unlock_password=make_password('view-password'))
        self.client.post('/c/map/api/unlock', {'password': 'view-password'},
                         content_type='application/json')
        self.url = '/c/map/api/snapshot'
        self.assertEqual(self.client.get(self.url).status_code, 200)

    def test_cross_origin_is_denied_even_with_valid_session(self):
        for origin in ('http://evil.example', 'http://other.testserver', 'null', ''):
            with self.subTest(origin=origin):
                response = self.client.get(self.url, HTTP_ORIGIN=origin)
                self.assertEqual(response.status_code, 403)
                self.assertNotIn(b'members', response.content)
                self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertEqual(self.client.get(self.url, HTTP_ORIGIN='http://testserver').status_code, 200)

    def test_same_site_subdomain_is_not_a_same_origin(self):
        with self.settings(ALLOWED_HOSTS=['class.shadowmov.com']):
            bad = self.client.get(self.url, secure=True, HTTP_HOST='class.shadowmov.com',
                                  HTTP_ORIGIN='https://other.shadowmov.com')
            self.assertEqual(bad.status_code, 403)
            good = self.client.get(self.url, secure=True, HTTP_HOST='class.shadowmov.com',
                                   HTTP_ORIGIN='https://class.shadowmov.com')
            self.assertEqual(good.status_code, 200)

    def test_fetch_metadata_blocks_originless_cross_site_subresources(self):
        for site in ('cross-site', 'same-site'):
            with self.subTest(site=site):
                response = self.client.get(self.url, HTTP_SEC_FETCH_SITE=site,
                                           HTTP_SEC_FETCH_MODE='no-cors')
                self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get(self.url, HTTP_SEC_FETCH_SITE='same-origin',
                                         HTTP_SEC_FETCH_MODE='cors').status_code, 200)
        self.assertEqual(self.client.get('/_AMapService/v3/config/district',
                                         HTTP_SEC_FETCH_SITE='same-site',
                                         HTTP_SEC_FETCH_MODE='cors').status_code, 403)

    def test_external_links_still_open_the_class_page(self):
        response = self.client.get('/c/map/', HTTP_SEC_FETCH_SITE='cross-site',
                                   HTTP_SEC_FETCH_MODE='navigate')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get('/admin/', HTTP_ORIGIN='http://evil.example').status_code, 403)
