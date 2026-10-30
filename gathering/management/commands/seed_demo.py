import os
from datetime import datetime, time, timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from gathering.models import Classroom, Location, Member
from gathering.services import import_rows


class Command(BaseCommand):
    help = 'Create fictional demo data in /c/demo/ (DEBUG only, requires DEMO_PASSWORD). Never modifies other classes.'

    @transaction.atomic
    def handle(self, *args, **options):
        password = os.getenv('DEMO_PASSWORD')
        if not settings.DEBUG or not password:
            raise CommandError('Requires DEBUG=1 and DEMO_PASSWORD.')
        if Classroom.objects.filter(slug='demo').exists():
            raise CommandError('Demo already exists; refusing to overwrite it.')
        room = Classroom.objects.create(slug='demo', name='2019 届 · 演示班级', description='演示数据：山海各有归处，见面总有理由。', unlock_password=make_password(password))
        admin = get_user_model().objects.create_superuser('demo-admin', password=password)
        data = [
            ('001', '林晓', 'CHN', '330000', '330100', '杭州市', '2020-07-01', '2022-06-01', 120.155, 30.274, '毕业后的第一站。'),
            ('001', '林晓', 'CHN', '310000', '310000', '上海市', '2022-06-01', '', 121.474, 31.230, '周末常在徐汇，来之前喊我。'),
            ('002', '陈雨', 'CHN', '330000', '330100', '杭州市', '2021-01-01', '', 120.155, 30.274, '在杭州工作，欢迎来喝茶。'),
            ('003', '周宁', 'CHN', '110000', '110000', '北京市', '2020-08-01', '', 116.407, 39.904, '下次回校一起吃饭。'),
            ('004', '许晨', 'CHN', '440000', '440300', '深圳市', '2022-03-01', '', 114.057, 22.543, '周五晚上通常有空。'),
            ('005', '赵一', 'JPN', '', '', '东京', '2023-09-01', '', 139.692, 35.690, '想吃什么我来找店。'),
            ('006', '叶青', 'CHN', '510000', '510100', '成都市', '2020-10-01', '', 104.066, 30.572, '火锅随时约。'),
            ('007', '吴桐', 'CHN', '330000', '330200', '宁波市', '2021-07-01', '', 121.550, 29.874, '可以带你去海边。'),
            ('008', '顾言', 'SGP', '', '', '新加坡', '2024-02-01', '', 103.820, 1.352, '有空过来坐坐。'),
            # Below: enough people to show every count bucket (1 / 2-3 / 4-9 / 10+), dense
            # neighbours that cluster, province-only rows and three countries.
            *[(f'{n:03d}', name, 'CHN', '420000', '420100', '武汉市', '2015-09-01', '', 114.305, 30.593, note)
              for n, name, note in [(10, '宋知夏', '汉口开了家面馆，热干面管够。'), (11, '周一禾', '协和夜班多，提前约。'), (12, '何以南', ''),
                                    (13, '杜若', '武大读博。'), (14, '陈默', ''), (15, '许嘉树', ''), (16, '马骁', '光谷上班。'),
                                    (17, '罗青', ''), (18, '唐棠', '周末常在东湖。'), (19, '韩笑', ''), (20, '冯远', ''), (21, '邓禾', '')]],
            ('022', '钱多多', 'CHN', '320000', '320100', '南京市', '2015-09-01', '', 118.797, 32.060, ''),
            ('023', '孙悦', 'CHN', '320000', '320100', '南京市', '2023-03-01', '', 118.797, 32.060, '新街口附近。'),
            ('024', '李想', 'CHN', '320000', '320500', '苏州市', '2015-09-01', '', 120.585, 31.299, ''),
            ('025', '郑好', 'CHN', '320000', '320500', '苏州市', '2024-05-01', '', 120.585, 31.299, '园区上班。'),
            ('026', '王一帆', 'CHN', '310000', '310000', '上海市', '2015-09-01', '', 121.474, 31.230, ''),
            ('027', '沈清', 'CHN', '330000', '330100', '杭州市', '2025-02-01', '', 120.155, 30.274, '西湖边。'),
            ('028', '冯晚', 'CHN', '110000', '110000', '北京市', '2015-09-01', '', 116.407, 39.904, ''),
            ('029', '秦川', 'CHN', '110000', '110000', '北京市', '2024-09-01', '', 116.407, 39.904, '海淀。'),
            ('030', '梁晨', 'CHN', '440000', '440100', '广州市', '2015-09-01', '', 113.264, 23.129, ''),
            *[(f'{n:03d}', name, 'CHN', '430000', '430100', '长沙市', '2015-09-01', '', 112.938, 28.228, '')
              for n, name in [(31, '唐一'), (32, '白露'), (33, '苏木'), (34, '江河')]],
            ('035', '高山', 'CHN', '420000', '', '', '2015-09-01', '', '', '', '只记得在湖北。'),
            ('036', '林间', 'CHN', '440000', '', '', '2015-09-01', '', '', '', ''),
            ('037', '纪远', 'USA', '', '', '纽约', '2022-08-01', '', -74.006, 40.713, '来纽约找我。'),
            ('038', '许港生', 'CHN', '810000', '810000', '香港特别行政区', '2024-03-01', '', 114.170, 22.320, '中环上班。'),  # shows under 境外
        ]
        rows = [dict(zip(['student_code', 'name', 'country_code', 'province_code', 'city_code', 'city_name', 'started_on', 'ended_on', 'longitude', 'latitude', 'note'], row)) for row in data]
        for row in rows:
            row['coordinate_system'] = 'gcj02' if row['country_code'] == 'CHN' else 'wgs84'
        rows.append({'student_code': '009', 'name': '夏禾'})
        import_rows(room, rows, admin)
        member = Member.objects.get(classroom=room, student_code='001'); member.user = admin; member.is_admin = True; member.save()
        # A second claimed, non-admin member so each e2e device profile updates its own person.
        peer = Member.objects.get(classroom=room, student_code='002')
        peer.user = get_user_model().objects.create_user('demo-member', password=password); peer.save()
        self.confirm_dates(room)
        self.stdout.write('Created fictional demo: /c/demo/ ; admin username: demo-admin')

    def confirm_dates(self, room):
        # import_rows never sets confirmed_at; spread the current stays like real data:
        # about half still at the 2015 import, the rest re-confirmed during 2023-2026.
        today = timezone.localdate()
        recent = [today - timedelta(days=days) for days in (12, 40, 75, 130, 200, 290, 380, 520, 700, 900)]
        current = Location.objects.filter(member__classroom=room, ended_on__isnull=True).order_by('member__student_code')
        for index, location in enumerate(current):
            code = location.member.student_code
            if code in ('001', '002'):
                day = today - timedelta(days=395)  # the two claimed demo members: 13 months old, lights the stale dot
            elif index % 2:
                day = recent[index // 2 % len(recent)]
            else:
                day = datetime(2015, 9, 1).date()
            Location.objects.filter(pk=location.pk).update(confirmed_at=timezone.make_aware(datetime.combine(day, time(12))))
