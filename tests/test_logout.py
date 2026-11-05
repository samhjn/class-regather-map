import json

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.test import Client, TestCase, override_settings

from gathering.models import Classroom, Member

FAST_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']


@override_settings(PASSWORD_HASHERS=FAST_HASHERS, SECURE_SSL_REDIRECT=False)
class LogoutKeepsTheViewCodeTests(TestCase):
    """退出 ends who you are, not that this device already entered the class view code."""

    def setUp(self):
        self.room = Classroom.objects.create(slug='one', name='一班', unlock_password=make_password('class-password'))
        self.user = get_user_model().objects.create_user('member', password='personal-password')
        Member.objects.create(classroom=self.room, name='张同学', student_code='001', user=self.user)
        self.base = '/c/one/api/'

    def post(self, route, data=None, client=None):
        return (client or self.client).post(self.base + route, data=json.dumps(data or {}), content_type='application/json')

    def boot(self, client=None):
        return (client or self.client).get(self.base + 'bootstrap').json()

    def test_logging_out_after_unlocking_keeps_the_class_open(self):
        self.post('unlock', {'password': 'class-password'})
        self.post('login', {'name': '张同学', 'password': 'personal-password'})
        self.assertEqual(self.post('logout').status_code, 200)
        boot = self.boot()
        self.assertIsNone(boot['me'])
        self.assertTrue(boot['unlocked'])

    def test_a_member_who_never_entered_the_code_is_locked_again_after_logout(self):
        self.post('login', {'name': '张同学', 'password': 'personal-password'})
        self.assertTrue(self.boot()['unlocked'])
        self.post('logout')
        self.assertFalse(self.boot()['unlocked'])

    def test_a_changed_view_code_still_locks_a_kept_unlock(self):
        self.post('unlock', {'password': 'class-password'})
        self.post('login', {'name': '张同学', 'password': 'personal-password'})
        self.room.unlock_password = make_password('new-password'); self.room.gate_version += 1; self.room.save()
        self.post('logout')
        self.assertFalse(self.boot()['unlocked'])
