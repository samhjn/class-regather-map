import json

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.test import Client, TestCase, override_settings

from gathering.models import Classroom, Member
from gathering.services import issue_claim

FAST_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']


@override_settings(PASSWORD_HASHERS=FAST_HASHERS, SECURE_SSL_REDIRECT=False)
class MemberPasswordRuleTests(TestCase):
    """Members need six characters without complexity rules; staff keep Django validators."""

    def setUp(self):
        self.room = Classroom.objects.create(slug='one', name='一班', unlock_password=make_password('class-password'))
        self.user = get_user_model().objects.create_user('member', password='personal-password')
        self.admin = get_user_model().objects.create_user('manager', password='admin-password-long')
        self.member = Member.objects.create(classroom=self.room, name='张同学', student_code='001', user=self.user)
        self.manager = Member.objects.create(classroom=self.room, name='班长', student_code='000', user=self.admin, is_admin=True)
        self.unclaimed = Member.objects.create(classroom=self.room, name='李同学', student_code='002')
        self.base = '/c/one/api/'

    def post(self, route, data, client=None):
        return (client or self.client).post(self.base + route, data=json.dumps(data), content_type='application/json')

    def claim(self, password):
        code, _ = issue_claim(self.unclaimed, self.admin)
        self.post('unlock', {'password': 'class-password'})
        return self.post('claim', {'name': self.unclaimed.name, 'claim_code': code, 'password': password})

    def test_member_claim_accepts_six_digit_password(self):
        self.assertEqual(self.claim('123456').status_code, 200)
        fresh = Client()
        self.assertEqual(self.post('login', {'name': self.unclaimed.name, 'password': '123456'}, fresh).status_code, 200)
        self.assertEqual(fresh.get(self.base + 'snapshot').status_code, 200)

    def test_member_password_change_accepts_six_digits(self):
        self.client.force_login(self.user)
        self.assertEqual(self.post('password', {'old_password': 'personal-password', 'password': '123456'}).status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('123456'))

    def test_short_password_change_preserves_existing_password(self):
        self.client.force_login(self.user)
        for password in ('', '7', '12', '123', '1234', '12345'):
            with self.subTest(length=len(password)):
                response = self.post('password', {'old_password': 'personal-password', 'password': password})
                self.assertEqual(response.status_code, 400)
                self.assertIn('至少需要 6 位', response.json()['error'])
                self.user.refresh_from_db()
                self.assertTrue(self.user.check_password('personal-password'))

    def test_short_claim_password_does_not_claim_member_or_consume_code(self):
        code, _ = issue_claim(self.unclaimed, self.admin)
        self.post('unlock', {'password': 'class-password'})
        payload = {'name': self.unclaimed.name, 'claim_code': code}
        for password in ('', '7', '12', '123', '1234', '12345'):
            with self.subTest(length=len(password)):
                response = self.post('claim', payload | {'password': password})
                self.assertEqual(response.status_code, 400)
                self.assertIn('至少需要 6 位', response.json()['error'])
                self.unclaimed.refresh_from_db()
                self.assertIsNone(self.unclaimed.user_id)
                self.assertTrue(self.unclaimed.claim_hash)
        self.assertEqual(self.post('claim', payload | {'password': '123456'}).status_code, 200)

    def test_admin_still_uses_django_validators(self):
        self.client.force_login(self.admin)
        self.assertEqual(self.post('password', {'old_password': 'admin-password-long', 'password': '12'}).status_code, 400)

    def test_login_throttle_still_applies(self):
        fresh = Client()
        fresh.post(self.base + 'unlock', data=json.dumps({'password': 'class-password'}), content_type='application/json')
        codes = [self.post('login', {'name': self.member.name, 'password': f'wrong-{i}'}, fresh).status_code for i in range(20)]
        self.assertIn(429, codes)
