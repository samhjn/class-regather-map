import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from threading import Barrier
from pathlib import Path
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.db import close_old_connections, connection
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from gathering.models import AuditEvent, Classroom, Location, Member, RateBucket
from gathering.services import Problem, import_rows, issue_claim, location_values, parse_import, save_location, throttle

FAST_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']


def stay(**changes):
    return dict(country_code='CHN', province_code='330000', city_code='330100', city_name='杭州市',
                started_on='2020-01-01', longitude='120.155070', latitude='30.274084', **changes)


@override_settings(PASSWORD_HASHERS=FAST_HASHERS, SECURE_SSL_REDIRECT=False)
class AppTests(TestCase):
    def setUp(self):
        self.room = Classroom.objects.create(slug='one', name='一班', unlock_password=make_password('class-password'))
        self.other = Classroom.objects.create(slug='two', name='二班', unlock_password=make_password('another-password'))
        self.user = get_user_model().objects.create_user('member', password='personal-password')
        self.admin = get_user_model().objects.create_user('manager', password='admin-password')
        self.member = Member.objects.create(classroom=self.room, name='张同学', student_code='001', user=self.user)
        self.manager = Member.objects.create(classroom=self.room, name='班长', student_code='000', user=self.admin, is_admin=True)
        self.unclaimed = Member.objects.create(classroom=self.room, name='李同学', student_code='002')
        self.foreign = Member.objects.create(classroom=self.other, name='隔壁班', student_code='001')
        self.base = '/c/one/api/'

    def post(self, route, data=None, client=None, method='post'):
        return getattr(client or self.client, method)(self.base + route, data=json.dumps(data or {}), content_type='application/json')

    def auth(self, admin=False):
        self.client.force_login(self.admin if admin else self.user)

    def test_locked_class_leaks_neither_roster_nor_map_key(self):
        boot = self.client.get(self.base + 'bootstrap').json()
        self.assertFalse(boot['unlocked'])
        self.assertNotIn('countries', boot)
        self.assertNotIn('map', boot)
        self.assertEqual(self.client.get(self.base + 'snapshot').status_code, 403)
        self.assertEqual(self.client.get(self.base + f'members/{self.member.pk}').status_code, 403)

    def test_gate_rotation_revokes_existing_guest_sessions(self):
        self.assertEqual(self.post('unlock', {'password': 'class-password'}).status_code, 200)
        self.assertEqual(self.client.get(self.base + 'snapshot').status_code, 200)
        manager = Client(); manager.force_login(self.admin)
        self.post('admin/settings', {'name': '一班', 'password': 'fresh-password'}, manager, 'patch')
        self.assertEqual(self.client.get(self.base + 'snapshot').status_code, 403)
        self.assertEqual(self.post('unlock', {'password': 'fresh-password'}).status_code, 200)

    def test_gate_cannot_be_shared_between_classes(self):
        self.post('unlock', {'password': 'class-password'})
        self.assertEqual(self.client.get('/c/two/api/snapshot').status_code, 403)

    def test_public_mode_does_not_grant_write_access(self):
        self.room.unlock_password = ''; self.room.save()
        self.assertEqual(self.client.get(self.base + 'snapshot').status_code, 200)
        self.assertEqual(self.post(f'members/{self.member.pk}/locations', stay()).status_code, 403)
        self.assertEqual(self.post('admin/import', {'rows': [{'student_code': '003', 'name': 'X'}]}).status_code, 403)

    def test_public_roster_hides_account_identifiers_and_claim_hashes(self):
        self.room.unlock_password = ''; self.room.save()
        rows = self.client.get(self.base + 'snapshot').json()['members']
        self.assertTrue(all('student_code' not in row for row in rows))
        detail = self.client.get(self.base + f'members/{self.unclaimed.pk}').json()['member']
        self.assertNotIn('student_code', detail)
        self.assertNotIn('claim_hash', detail)

    def test_csrf_required_for_unlock_and_claim(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(self.post('unlock', {'password': 'class-password'}, client).status_code, 403)
        client.get('/c/one/')
        token = client.cookies['csrftoken'].value
        response = client.post(self.base + 'unlock', data=json.dumps({'password': 'class-password'}), content_type='application/json', HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 200)

    def test_claim_is_one_time_and_does_not_use_name_as_proof(self):
        code, _ = issue_claim(self.unclaimed, self.admin)
        self.unclaimed.refresh_from_db()
        self.assertNotEqual(code, self.unclaimed.claim_hash)
        self.post('unlock', {'password': 'class-password'})
        payload = {'student_code': '002', 'claim_code': code, 'password': 'my-own-password'}
        self.assertEqual(self.post('claim', payload).status_code, 200)
        self.unclaimed.refresh_from_db(); self.assertIsNotNone(self.unclaimed.user_id)
        self.assertEqual(self.unclaimed.claim_hash, '')
        self.assertEqual(self.post('claim', payload).status_code, 403)

    def test_expired_claim_rejected(self):
        code, _ = issue_claim(self.unclaimed, self.admin)
        Member.objects.filter(pk=self.unclaimed.pk).update(claim_expires_at=timezone.now() - timedelta(seconds=1))
        self.post('unlock', {'password': 'class-password'})
        self.assertEqual(self.post('claim', {'student_code': '002', 'claim_code': code, 'password': 'my-own-password'}).status_code, 403)

    def test_login_with_member_code_and_password(self):
        self.assertEqual(self.post('login', {'student_code': '001', 'password': 'wrong'}).status_code, 403)
        self.assertEqual(self.post('login', {'student_code': '001', 'password': 'personal-password'}).status_code, 200)
        self.assertEqual(self.client.get(self.base + 'bootstrap').json()['me']['id'], self.member.pk)
        self.assertEqual(self.client.get('/c/two/api/snapshot').status_code, 403)

    def test_login_with_name_and_password_without_view_code(self):
        self.assertEqual(self.post('login', {'name': ' 张同学 ', 'password': 'personal-password'}).status_code, 200)
        self.assertEqual(self.client.get(self.base + 'bootstrap').json()['me']['id'], self.member.pk)
        self.assertEqual(self.client.get('/c/two/api/snapshot').status_code, 403)

    def test_duplicate_name_login_requires_explicit_code(self):
        twin = get_user_model().objects.create_user('twin', password='personal-password')
        Member.objects.create(classroom=self.room, name=self.member.name, student_code='004', user=twin)
        response = self.post('login', {'name': self.member.name, 'password': 'personal-password'})
        self.assertEqual(response.status_code, 403)
        self.assertIn('同名', response.json()['error'])
        self.assertEqual(self.post('login', {'student_code': '001', 'password': 'personal-password'}).status_code, 200)
        self.assertEqual(self.client.get(self.base + 'bootstrap').json()['me']['id'], self.member.pk)

    def test_same_name_in_other_class_does_not_interfere(self):
        self.foreign.name = self.member.name; self.foreign.save()
        self.assertEqual(self.post('login', {'name': self.member.name, 'password': 'personal-password'}).status_code, 200)

    def test_name_claim_uses_token_to_disambiguate_and_accepts_six_digits(self):
        twin = Member.objects.create(classroom=self.room, name=self.unclaimed.name, student_code='004')
        wrong_code, _ = issue_claim(self.unclaimed, self.admin)
        code, _ = issue_claim(twin, self.admin)
        self.post('unlock', {'password': 'class-password'})
        self.assertEqual(self.post('claim', {'name': twin.name, 'password': '123456'}).status_code, 403)
        payload = {'name': ' ' + twin.name + ' ', 'claim_code': code, 'password': '123456'}
        self.assertEqual(self.post('claim', payload).status_code, 200)
        twin.refresh_from_db(); self.unclaimed.refresh_from_db()
        self.assertIsNone(self.unclaimed.user_id)
        self.assertTrue(twin.user.check_password('123456'))
        self.assertEqual(self.client.get(self.base + 'bootstrap').json()['me']['id'], twin.pk)
        self.assertEqual(self.post('claim', payload).status_code, 403)
        self.assertEqual(self.post('claim', {'name': '不存在', 'claim_code': wrong_code, 'password': '123456'}).status_code, 403)

    def test_claim_still_needs_class_access_and_token_scope(self):
        code, _ = issue_claim(self.unclaimed, self.admin)
        payload = {'name': self.unclaimed.name, 'claim_code': code, 'password': '123456'}
        self.assertEqual(self.post('claim', payload).status_code, 403)
        self.post('unlock', {'password': 'class-password'})
        foreign_code, _ = issue_claim(self.foreign, self.admin)
        self.assertEqual(self.post('claim', payload | {'claim_code': foreign_code}).status_code, 403)
        self.assertEqual(self.post('claim', payload | {'password': '12345'}).status_code, 400)
        self.assertEqual(self.post('claim', payload).status_code, 200)

    def test_member_password_change_accepts_simple_six_characters(self):
        self.auth()
        self.assertEqual(self.post('password', {'old_password': 'personal-password', 'password': '12345'}).status_code, 400)
        self.assertEqual(self.post('password', {'old_password': 'personal-password', 'password': '123456'}).status_code, 200)
        self.user.refresh_from_db(); self.assertTrue(self.user.check_password('123456'))
        self.assertEqual(self.client.get(self.base + 'bootstrap').json()['me']['id'], self.member.pk)

    def test_admin_and_view_password_rules_remain_strong(self):
        self.auth(admin=True)
        self.assertEqual(self.post('password', {'old_password': 'admin-password', 'password': '123456'}).status_code, 400)
        self.assertEqual(self.post('admin/settings', {'name': self.room.name, 'password': '123456'}, method='patch').status_code, 400)
        code, _ = issue_claim(self.manager, self.admin, reset=True)
        self.client.logout()
        self.post('unlock', {'password': 'class-password'})
        self.assertEqual(self.post('claim', {'name': self.manager.name, 'claim_code': code, 'password': '123456'}).status_code, 400)

    def test_identity_cannot_mix_name_and_code(self):
        self.assertEqual(self.post('login', {'name': self.member.name, 'student_code': '001', 'password': 'personal-password'}).status_code, 400)
        self.assertEqual(self.post('login', {'password': 'personal-password'}).status_code, 400)

    def test_query_prefill_survives_home_redirect_without_authentication(self):
        with override_settings(DEFAULT_CLASS_SLUG='one'):
            response = self.client.get('/?view_code=class-password&name=张同学')
        self.assertEqual(response.status_code, 302)
        self.assertIn('view_code=class-password', response['Location'])
        self.assertFalse(self.client.get(self.base + 'bootstrap').json()['unlocked'])

    def test_password_whitespace_preserved(self):
        self.user.set_password('  personal-password  '); self.user.save()
        self.assertEqual(self.post('login', {'student_code': '001', 'password': '  personal-password  '}).status_code, 200)

    def test_reset_revokes_sessions_and_old_password(self):
        self.auth()
        issue_claim(self.member, self.admin, reset=True)
        self.assertEqual(self.client.get(self.base + 'snapshot').status_code, 403)
        self.assertEqual(self.post('login', {'student_code': '001', 'password': 'personal-password'}).status_code, 403)

    def test_member_cannot_edit_another_member_or_admin_settings(self):
        self.auth()
        self.assertEqual(self.post(f'members/{self.unclaimed.pk}/locations', stay()).status_code, 403)
        self.assertEqual(self.post('admin/settings', {'name': 'hijack'}, method='patch').status_code, 403)
        self.assertEqual(self.post(f'admin/members/{self.unclaimed.pk}/invite').status_code, 403)

    def test_class_admin_is_scoped_to_class(self):
        self.auth(admin=True)
        self.assertEqual(self.post(f'members/{self.foreign.pk}/locations', stay()).status_code, 404)
        self.assertEqual(self.client.get('/c/two/api/admin/settings').status_code, 403)

    def test_current_snapshot_uses_effective_dates_not_write_date(self):
        self.auth()
        old = stay(ended_on='2021-01-01')
        save_location(self.member, old, self.user)
        newer = stay(); newer.update(started_on='2021-01-01', city_code='330200', city_name='宁波市')
        save_location(self.member, newer, self.user)
        before = self.client.get(self.base + 'snapshot?at=2020-12-31').json()
        on_move = self.client.get(self.base + 'snapshot?at=2021-01-01').json()
        find = lambda result: next(row for row in result['members'] if row['id'] == self.member.pk)['location']
        self.assertEqual(find(before)['city_name'], '杭州市')
        self.assertEqual(find(on_move)['city_name'], '宁波市')
        self.assertIsNone(find(self.client.get(self.base + 'snapshot?at=2019-01-01').json()))
        self.assertEqual(before['timeline_start'], '2020-01-01')

    def test_move_closes_previous_interval_atomically(self):
        old = save_location(self.member, stay(), self.user)
        newer = stay(); newer.update(started_on='2022-01-01', close_previous=True)
        save_location(self.member, newer, self.user)
        old.refresh_from_db(); self.assertEqual(old.ended_on, date(2022, 1, 1))
        self.assertEqual(self.member.locations.count(), 2)

    def test_overlapping_backfill_rejected_without_mutation(self):
        old = save_location(self.member, stay(), self.user)
        newer = stay(); newer.update(started_on='2022-01-01')
        with self.assertRaises(Problem): save_location(self.member, newer, self.user)
        old.refresh_from_db(); self.assertIsNone(old.ended_on)
        self.assertEqual(self.member.locations.count(), 1)

    def test_conflicting_move_rolls_back_automatic_close(self):
        old = save_location(self.member, stay(), self.user)
        newer = stay(); newer.update(started_on='2019-01-01', ended_on='2020-06-01', close_previous=True)
        with self.assertRaises(Problem): save_location(self.member, newer, self.user)
        old.refresh_from_db(); self.assertIsNone(old.ended_on)

    def test_optimistic_edit_and_delete_protection(self):
        self.auth()
        loc = save_location(self.member, stay(), self.user)
        route = f'members/{self.member.pk}/locations/{loc.pk}'
        self.assertEqual(self.post(route, stay(), method='patch').status_code, 409)
        payload = stay(); payload.update(version=loc.updated_at.isoformat(), note='更新')
        self.assertEqual(self.post(route, payload, method='patch').status_code, 200)
        self.assertEqual(self.post(route, {'version': loc.updated_at.isoformat()}, method='delete').status_code, 409)
        loc.refresh_from_db()
        self.assertEqual(self.post(route, {'version': loc.updated_at.isoformat()}, method='delete').status_code, 200)

    def test_location_id_cannot_cross_members(self):
        self.auth()
        loc = save_location(self.unclaimed, stay(), self.admin)
        self.assertEqual(self.post(f'members/{self.member.pk}/locations/{loc.pk}', {'version': loc.updated_at.isoformat()}, method='delete').status_code, 404)

    def test_coordinates_dates_and_regions_are_validated(self):
        invalid = [{'latitude': '91'}, {'longitude': 'NaN'}, {'latitude': ''}, {'coordinate_system': 'wgs84'},
                   {'province_code': '990000'}, {'city_code': '110100'}, {'city_code': '330106'},
                   {'started_on': '2020-02-30'}, {'ended_on': '2019-01-01'}, {'started_on': '2099-01-01'}, {'country_code': 'XYZ'}]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(Problem):
                location_values(stay() | changes)

    def test_china_aliases_and_municipalities_are_normalized(self):
        values = location_values(stay() | {'country_code': 'HKG', 'city_code': '', 'city_name': ''})
        self.assertEqual((values['country_code'], values['province_code'], values['city_code']), ('CHN', '810000', '810000'))
        values = location_values(stay() | {'province_code': '110000', 'city_code': '110100'})
        self.assertEqual(values['city_code'], '110000')

    def test_province_only_and_overseas_locations_without_points(self):
        values = location_values(stay() | {'city_code': '', 'city_name': '', 'longitude': '', 'latitude': ''})
        self.assertIsNone(values['longitude'])
        values = location_values({'country_code': 'JPN', 'city_name': 'Tokyo', 'started_on': '2020-01-01'})
        self.assertEqual(values['province_code'], '')
        self.assertEqual(values['coordinate_system'], 'wgs84')

    def test_import_preview_rolls_back_and_commit_is_idempotent(self):
        self.auth(admin=True)
        rows = [{'student_code': '003', 'name': '王同学'} | stay(ended_on='2021-01-01')]
        preview = self.post('admin/import', {'rows': rows})
        self.assertEqual(preview.status_code, 200, preview.content)
        self.assertFalse(self.room.members.filter(student_code='003').exists())
        payload = {'rows': rows, 'commit': True, 'preview_token': preview.json()['preview_token']}
        self.assertEqual(self.post('admin/import', payload).status_code, 200)
        self.assertEqual(self.post('admin/import', payload).status_code, 200)
        self.assertEqual(self.room.members.get(student_code='003').locations.count(), 1)

    def test_import_changed_content_requires_preview(self):
        self.auth(admin=True)
        rows = [{'student_code': '003', 'name': '王同学'}]
        preview = self.post('admin/import', {'rows': rows}).json()
        rows[0]['name'] = '新内容'
        self.assertEqual(self.post('admin/import', {'rows': rows, 'commit': True, 'preview_token': preview['preview_token']}).status_code, 400)

    def test_import_bad_row_rolls_back_entire_batch(self):
        rows = [{'student_code': '003', 'name': '王同学'}, {'student_code': '004', 'name': '赵同学'} | stay() | {'latitude': '999'}]
        with self.assertRaises(Problem): import_rows(self.room, rows, self.admin)
        self.assertFalse(self.room.members.filter(student_code__in=['003', '004']).exists())

    def test_import_rejects_duplicate_dates_and_unknown_columns(self):
        row = {'student_code': '003', 'name': '王同学'} | stay()
        with self.assertRaises(Problem): import_rows(self.room, [row, row], self.admin)
        with self.assertRaises(Problem): parse_import({'csv': 'student_code,name,user_id\n1,甲,99'})
        with self.assertRaises(Problem): parse_import({'csv': 'student_code,name\n1,甲,多余列'})
        with self.assertRaises(Problem): parse_import({'csv': 'student_code,name,name\n1,甲,乙'})

    def test_rate_limits_persist_and_do_not_log_secrets(self):
        for _ in range(2): throttle('test', 'private-identity', 2)
        with self.assertRaises(Problem) as error: throttle('test', 'private-identity', 2)
        self.assertEqual(error.exception.status, 429)
        self.assertNotIn('private-identity', RateBucket.objects.first().key)
        code, _ = issue_claim(self.unclaimed, self.admin)
        self.assertNotIn(code, json.dumps(list(AuditEvent.objects.values('detail'))))

    def test_no_store_headers_and_safe_page_escaping(self):
        self.room.name = '<script>alert(1)</script>'; self.room.save()
        response = self.client.get('/c/one/')
        self.assertContains(response, '&lt;script&gt;')
        self.assertIn('no-store', response['Cache-Control'])
        self.assertEqual(response['X-Robots-Tag'], 'noindex, nofollow, noarchive')

    def test_mutations_reject_get_and_malformed_json(self):
        self.assertEqual(self.client.get(self.base + 'unlock').status_code, 405)
        self.assertEqual(self.client.post(self.base + 'unlock', data='[]', content_type='application/json').status_code, 400)
        self.assertEqual(self.client.post(self.base + 'unlock', data='broken', content_type='application/json').status_code, 400)

    def test_too_short_password_cannot_be_claimed(self):
        code, _ = issue_claim(self.unclaimed, self.admin)
        self.post('unlock', {'password': 'class-password'})
        self.assertEqual(self.post('claim', {'student_code': '002', 'claim_code': code, 'password': '12345'}).status_code, 400)

    def test_class_admin_can_edit_known_location(self):
        self.auth(admin=True)
        response = self.post(f'members/{self.unclaimed.pk}/locations', stay())
        self.assertEqual(response.status_code, 200, response.content)

    def test_health_endpoint(self):
        self.assertEqual(self.client.get('/healthz/').json(), {'status': 'ok'})

    def test_documented_import_example_is_usable(self):
        room = Classroom.objects.create(slug='example', name='模板验证')
        rows = parse_import({'csv': (Path(__file__).resolve().parents[1] / 'docs/import-example.csv').read_text(encoding='utf-8')})
        result = import_rows(room, rows, self.admin)
        self.assertEqual(result['created'], 3)
        self.assertEqual(result['locations'], 3)


@skipUnless(connection.vendor == 'mysql', 'MySQL row locks are exercised by the MySQL CI job')
@override_settings(PASSWORD_HASHERS=FAST_HASHERS)
class MySQLConcurrencyTests(TransactionTestCase):
    def test_concurrent_location_creates_cannot_overlap(self):
        room = Classroom.objects.create(slug='concurrent', name='班级')
        user = get_user_model().objects.create_user('concurrent')
        member = Member.objects.create(classroom=room, name='同学', student_code='1', user=user)
        barrier = Barrier(2)

        def write():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                save_location(Member.objects.get(pk=member.pk), stay(), get_user_model().objects.get(pk=user.pk))
                return 'saved'
            except Problem:
                return 'conflict'
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: write(), range(2)))
        self.assertCountEqual(results, ['saved', 'conflict'])
        self.assertEqual(member.locations.count(), 1)

    def test_concurrent_claim_cannot_bind_two_users(self):
        room = Classroom.objects.create(slug='claim-race', name='班级')
        member = Member.objects.create(classroom=room, name='同学', student_code='1')
        admin = get_user_model().objects.create_user('manager')
        code, _ = issue_claim(member, admin)
        barrier = Barrier(2)

        def claim():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                response = Client().post('/c/claim-race/api/claim', data=json.dumps({
                    'name': '同学', 'claim_code': code, 'password': 'concurrent-passphrase',
                }), content_type='application/json')
                return response.status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: claim(), range(2)))
        self.assertCountEqual(results, [200, 403])
        self.assertEqual(get_user_model().objects.count(), 2)
