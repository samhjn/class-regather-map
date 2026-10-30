import importlib
import json
from datetime import datetime, timedelta

import django.apps
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.test import TestCase, override_settings
from django.utils import timezone

from gathering.models import AuditEvent, Classroom, Location, Member
from gathering.services import import_rows, save_location

FAST_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']


def stay(**changes):
    return dict(country_code='CHN', province_code='330000', city_code='330100', city_name='杭州市',
                started_on='2020-01-01', longitude='120.155070', latitude='30.274084', **changes)


def backfill_confirmed_at(apps, schema_editor):
    module = importlib.import_module('gathering.migrations.0002_location_confirmed_at')
    return module.backfill_confirmed_at(apps, schema_editor)


@override_settings(PASSWORD_HASHERS=FAST_HASHERS, SECURE_SSL_REDIRECT=False)
class ConfirmTests(TestCase):
    def setUp(self):
        self.room = Classroom.objects.create(slug='one', name='一班', unlock_password=make_password('class-password'))
        self.user = get_user_model().objects.create_user('member', password='personal-password')
        self.admin = get_user_model().objects.create_user('manager', password='admin-password')
        self.member = Member.objects.create(classroom=self.room, name='张同学', student_code='001', user=self.user)
        self.manager = Member.objects.create(classroom=self.room, name='班长', student_code='000', user=self.admin, is_admin=True)
        self.unclaimed = Member.objects.create(classroom=self.room, name='李同学', student_code='002')
        self.base = '/c/one/api/'

    def post(self, route, data=None, method='post'):
        return getattr(self.client, method)(self.base + route, data=json.dumps(data or {}), content_type='application/json')

    def auth(self, admin=False):
        self.client.force_login(self.admin if admin else self.user)

    def confirm(self, member, location, version=None):
        return self.post(f'members/{member.pk}/locations/{location.pk}/confirm',
                         {'version': version if version is not None else location.updated_at.isoformat()})

    def assertRecent(self, value):
        self.assertIsNotNone(value)
        self.assertLess(abs((timezone.now() - value).total_seconds()), 5)

    # --- save_location ---------------------------------------------------

    def test_self_create_sets_confirmed_at(self):
        self.auth()
        response = self.post(f'members/{self.member.pk}/locations', stay())
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIsNotNone(response.json()['location']['confirmed_at'])
        self.assertRecent(Location.objects.get(member=self.member).confirmed_at)

    def test_self_edit_refreshes_confirmed_at(self):
        loc = save_location(self.member, stay(), self.user)
        Location.objects.filter(pk=loc.pk).update(confirmed_at=timezone.make_aware(datetime(2015, 9, 1)))
        self.auth()
        payload = stay(version=loc.updated_at.isoformat(), note='还在')
        response = self.post(f'members/{self.member.pk}/locations/{loc.pk}', payload, method='patch')
        self.assertEqual(response.status_code, 200, response.content)
        loc.refresh_from_db()
        self.assertRecent(loc.confirmed_at)

    def test_admin_edit_keeps_confirmed_at(self):
        self.auth()
        created = self.post(f'members/{self.member.pk}/locations', stay()).json()['location']
        before = Location.objects.get(pk=created['id']).confirmed_at
        self.assertIsNotNone(before)
        self.auth(admin=True)
        payload = stay(version=created['version'], note='管理员改的')
        response = self.post(f'members/{self.member.pk}/locations/{created["id"]}', payload, method='patch')
        self.assertEqual(response.status_code, 200, response.content)
        loc = Location.objects.get(pk=created['id'])
        self.assertEqual(loc.note, '管理员改的')
        self.assertEqual(loc.confirmed_at, before)

    def test_admin_create_for_other_member_counts_from_started_on(self):
        # Spec 5.7: not self-confirmed → as of started_on, so the stay is still shown under 全部.
        self.auth(admin=True)
        local_start = '2020-01-01T00:00:00+08:00'
        response = self.post(f'members/{self.unclaimed.pk}/locations', stay())
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['location']['confirmed_at'], local_start)
        response = self.post(f'members/{self.member.pk}/locations', stay())
        self.assertEqual(response.json()['location']['confirmed_at'], local_start)

    def test_admin_create_own_location_counts_as_self(self):
        self.auth(admin=True)
        response = self.post(f'members/{self.manager.pk}/locations', stay())
        self.assertEqual(response.status_code, 200, response.content)
        self.assertRecent(Location.objects.get(member=self.manager).confirmed_at)

    def test_import_counts_from_started_on(self):
        # Includes the admin's own row: imports never count as self-confirmation (spec 5.7).
        rows = [{'student_code': '003', 'name': '王同学'} | stay(),
                {'student_code': '000', 'name': '班长'} | stay()]
        import_rows(self.room, rows, self.admin)
        stays = Location.objects.filter(member__classroom=self.room)
        self.assertEqual(stays.count(), 2)
        for loc in stays:
            self.assertEqual(timezone.localtime(loc.confirmed_at).isoformat(), '2020-01-01T00:00:00+08:00')

    def test_import_update_keeps_existing_confirmed_at(self):
        loc = save_location(self.manager, stay(), self.admin)
        before = loc.confirmed_at
        self.assertIsNotNone(before)
        import_rows(self.room, [{'student_code': '000', 'name': '班长'} | stay(note='导入改的')], self.admin)
        loc.refresh_from_db()
        self.assertEqual(loc.note, '导入改的')
        self.assertEqual(loc.confirmed_at, before)

    # --- confirm endpoint ------------------------------------------------

    def test_confirm_refreshes_only_confirmed_at(self):
        loc = save_location(self.member, stay(note='原来的'), self.user)
        Location.objects.filter(pk=loc.pk).update(confirmed_at=timezone.make_aware(datetime(2015, 9, 1)))
        loc.refresh_from_db()
        self.auth()
        response = self.confirm(self.member, loc)
        self.assertEqual(response.status_code, 200, response.content)
        after = Location.objects.get(pk=loc.pk)
        self.assertEqual(timezone.localtime(after.confirmed_at).date(), timezone.localdate())
        self.assertRecent(after.confirmed_at)
        self.assertEqual(after.updated_at, loc.updated_at)
        self.assertEqual(after.note, '原来的')
        self.assertEqual(after.started_on, loc.started_on)
        body = response.json()['location']
        self.assertEqual(body['version'], loc.updated_at.isoformat())
        self.assertEqual(body['confirmed_at'], timezone.localtime(after.confirmed_at).isoformat())
        self.assertTrue(AuditEvent.objects.filter(action='location.confirm', member=self.member,
                                                  detail__location_id=loc.pk).exists())

    def test_confirm_by_admin_forbidden(self):
        loc = save_location(self.member, stay(), self.user)
        self.auth(admin=True)
        response = self.confirm(self.member, loc)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()['error'], '只能确认自己的位置')

    def test_admin_can_confirm_own_location(self):
        loc = save_location(self.manager, stay(), self.admin)
        Location.objects.filter(pk=loc.pk).update(confirmed_at=None)
        self.auth(admin=True)
        self.assertEqual(self.confirm(self.manager, loc).status_code, 200)
        loc.refresh_from_db()
        self.assertRecent(loc.confirmed_at)

    def test_confirm_other_member_forbidden(self):
        loc = save_location(self.unclaimed, stay(), self.admin)
        before = loc.confirmed_at
        self.auth()
        self.assertEqual(self.confirm(self.unclaimed, loc).status_code, 403)
        # A guest who only unlocked the class map is not anyone's "self" either.
        self.client.logout()
        self.post('unlock', {'password': 'class-password'})
        self.assertEqual(self.confirm(self.unclaimed, loc).status_code, 403)
        loc.refresh_from_db()
        self.assertEqual(loc.confirmed_at, before)

    def test_confirm_location_id_cannot_cross_members(self):
        other = save_location(self.unclaimed, stay(), self.admin)
        self.auth()
        self.assertEqual(self.confirm(self.member, other).status_code, 404)

    def test_confirm_stale_version_409(self):
        loc = save_location(self.member, stay(), self.user)
        Location.objects.filter(pk=loc.pk).update(confirmed_at=None)
        self.auth()
        self.assertEqual(self.confirm(self.member, loc, version='2015-09-01T00:00:00+08:00').status_code, 409)
        loc.refresh_from_db()
        self.assertIsNone(loc.confirmed_at)

    def test_confirm_ended_location_400(self):
        self.auth()
        today = timezone.localdate()
        for ended_on in ['2021-01-01', today.isoformat()]:
            with self.subTest(ended_on=ended_on):
                Location.objects.all().delete()
                loc = save_location(self.member, stay(ended_on=ended_on), self.user)
                response = self.confirm(self.member, loc)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()['error'], '这条位置已经结束')
        # Ends tomorrow: still the current stay today.
        Location.objects.all().delete()
        loc = save_location(self.member, stay(ended_on=(today + timedelta(days=1)).isoformat()), self.user)
        self.assertEqual(self.confirm(self.member, loc).status_code, 200)

    def test_confirm_rejects_get(self):
        loc = save_location(self.member, stay(), self.user)
        self.auth()
        self.assertEqual(self.client.get(self.base + f'members/{self.member.pk}/locations/{loc.pk}/confirm').status_code, 405)

    # --- read side -------------------------------------------------------

    def test_snapshot_exposes_confirmed_at(self):
        mine = save_location(self.member, stay(), self.user)
        save_location(self.unclaimed, stay(), self.admin)
        self.auth()
        rows = {row['id']: row for row in self.client.get(self.base + 'snapshot').json()['members']}
        # Local (+08:00) ISO so the browser can read the month straight from the string (filter.js).
        self.assertEqual(rows[self.member.pk]['location']['confirmed_at'], timezone.localtime(mine.confirmed_at).isoformat())
        self.assertTrue(rows[self.member.pk]['location']['confirmed_at'].endswith('+08:00'))
        self.assertEqual(rows[self.unclaimed.pk]['location']['confirmed_at'], '2020-01-01T00:00:00+08:00')  # admin-made: started_on
        detail = self.client.get(self.base + f'members/{self.member.pk}').json()
        self.assertEqual(detail['locations'][0]['confirmed_at'], timezone.localtime(mine.confirmed_at).isoformat())

    # --- migration backfill ---------------------------------------------

    def test_backfill_rule(self):
        mine = Location.objects.create(member=self.member, updated_by=self.user, **self.values('2020-01-01'))
        by_admin = Location.objects.create(member=self.member, updated_by=self.admin, **self.values('2015-09-01', '2020-01-01'))
        # Unclaimed member with no editor: None == None must not count as "self".
        orphan = Location.objects.create(member=self.unclaimed, updated_by=None, **self.values('2016-03-05'))
        stamps = {loc.pk: loc.updated_at for loc in (mine, by_admin, orphan)}
        backfill_confirmed_at(django.apps.apps, None)
        for loc in (mine, by_admin, orphan):
            loc.refresh_from_db()
        self.assertEqual(mine.confirmed_at, mine.updated_at)
        self.assertEqual(by_admin.confirmed_at, timezone.make_aware(datetime(2015, 9, 1)))
        self.assertEqual(timezone.localtime(by_admin.confirmed_at).isoformat(), '2015-09-01T00:00:00+08:00')
        self.assertEqual(orphan.confirmed_at, timezone.make_aware(datetime(2016, 3, 5)))
        # Backfill must not bump updated_at (that is the edit version).
        self.assertEqual({loc.pk: loc.updated_at for loc in (mine, by_admin, orphan)}, stamps)

    @staticmethod
    def values(started_on, ended_on=None):
        return dict(country_code='CHN', province_code='330000', city_code='330100', city_name='杭州市',
                    started_on=datetime.fromisoformat(started_on).date(),
                    ended_on=datetime.fromisoformat(ended_on).date() if ended_on else None)


@override_settings(PASSWORD_HASHERS=FAST_HASHERS, SECURE_SSL_REDIRECT=False)
class StayWithNoteTests(TestCase):
    """Round 2: a stay and the personal note (Member.bio) are saved in one transaction."""

    def setUp(self):
        self.room = Classroom.objects.create(slug='one', name='一班', unlock_password=make_password('class-password'))
        self.user = get_user_model().objects.create_user('member', password='personal-password')
        self.member = Member.objects.create(classroom=self.room, name='张同学', student_code='001', user=self.user, bio='旧备注')
        self.client.force_login(self.user)
        self.base = '/c/one/api/'
        self.stay = save_location(self.member, stay(label='武汉大学'), self.user)
        self.member.refresh_from_db()

    def send(self, route, data, method='post'):
        return getattr(self.client, method)(self.base + route, data=json.dumps(data), content_type='application/json')

    def stay_payload(self, **changes):
        payload = {k: (str(v) if v is not None else '') for k, v in stay().items()}
        return payload | {'label': '武汉大学', 'version': self.stay.updated_at.isoformat()} | changes

    def test_patch_saves_workplace_and_note_together(self):
        response = self.send(f'members/{self.member.pk}/locations/{self.stay.pk}',
                             self.stay_payload(label='华为', bio='周末有空', member_version=self.member.updated_at.isoformat()), 'patch')
        self.assertEqual(response.status_code, 200, response.content)
        self.stay.refresh_from_db(); self.member.refresh_from_db()
        self.assertEqual((self.stay.label, self.member.bio), ('华为', '周末有空'))

    def test_stale_note_version_rolls_the_stay_back_too(self):
        before = (self.stay.label, self.stay.confirmed_at)
        response = self.send(f'members/{self.member.pk}/locations/{self.stay.pk}',
                             self.stay_payload(label='华为', bio='新的', member_version='2000-01-01T00:00:00+00:00'), 'patch')
        self.assertEqual(response.status_code, 409)
        self.stay.refresh_from_db(); self.member.refresh_from_db()
        self.assertEqual((self.stay.label, self.stay.confirmed_at), before)
        self.assertEqual(self.member.bio, '旧备注')

    def test_confirm_can_carry_the_note(self):
        response = self.send(f'members/{self.member.pk}/locations/{self.stay.pk}/confirm',
                             {'version': self.stay.updated_at.isoformat(), 'bio': '还在', 'member_version': self.member.updated_at.isoformat()})
        self.assertEqual(response.status_code, 200, response.content)
        self.member.refresh_from_db()
        self.assertEqual(self.member.bio, '还在')

    def test_new_stay_can_carry_the_note(self):
        payload = {k: (str(v) if v is not None else '') for k, v in {**stay(), 'started_on': timezone.localdate().isoformat(), 'city_code': '330200', 'city_name': '宁波市'}.items()}
        response = self.send(f'members/{self.member.pk}/locations',
                             payload | {'close_previous': True, 'bio': '搬到宁波了', 'member_version': self.member.updated_at.isoformat()})
        self.assertEqual(response.status_code, 200, response.content)
        self.member.refresh_from_db()
        self.assertEqual(self.member.bio, '搬到宁波了')

    def test_import_rows_with_bio_still_work(self):
        # Imports pass a 'bio' column through save_location without member_version: never a conflict.
        import_rows(self.room, [{'student_code': '009', 'name': '新同学', 'bio': '导入的'} | stay()], self.user)
        self.assertEqual(Member.objects.get(classroom=self.room, student_code='009').bio, '导入的')
