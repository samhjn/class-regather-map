import csv
import hashlib
import io
import re
import secrets
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation

from django.contrib.auth.hashers import make_password
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .geography import CHINA_ALIASES, MUNICIPALITIES, PROVINCES, SPECIAL_PROVINCES, countries
from .models import AuditEvent, Classroom, Location, Member, RateBucket


class Problem(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def string(data, key, maximum, required=False):
    value = data.get(key, '')
    if not isinstance(value, str):
        raise Problem(f'{key} 必须是文本')
    value = value.strip()
    if len(value) > maximum or (required and not value):
        raise Problem(f'{key} 不能为空或超过 {maximum} 个字符' if required else f'{key} 超过 {maximum} 个字符')
    return value


def parse_date(value, name, required=False):
    if value in (None, '') and not required:
        return None
    try:
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            raise ValueError
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise Problem(f'{name} 应为有效日期 YYYY-MM-DD')


def secret_text(data, key):
    value = data.get(key, '')
    if not isinstance(value, str) or len(value) > 200:
        raise Problem('密码或认领码格式不正确')
    return value


def validate_member_password(password):
    # Member accounts are a lightweight class directory, separate from staff
    # credentials and the shared viewing password's Django validators.
    # Keep a minimum length: short numeric passwords fit inside one login throttle window.
    if len(password) < 6:
        raise Problem('个人密码至少需要 6 位')


def audit(classroom, actor, action, member=None, **detail):
    AuditEvent.objects.create(classroom=classroom, actor=actor if actor and actor.is_authenticated else None,
                              action=action, member=member, detail=detail)


def throttle(scope, identity, limit=20):
    key = hashlib.sha256(f'{scope}:{identity}'.encode()).hexdigest()
    now = timezone.now()
    with transaction.atomic():
        bucket, _ = RateBucket.objects.get_or_create(key=key, defaults={'expires_at': now + timedelta(minutes=15)})
        bucket = RateBucket.objects.select_for_update().get(pk=bucket.pk)
        if bucket.expires_at <= now:
            bucket.attempts = 0
            bucket.expires_at = now + timedelta(minutes=15)
        blocked = bucket.attempts >= limit
        if not blocked:
            bucket.attempts += 1
            bucket.save()
    if blocked:
        raise Problem('尝试次数较多，请 15 分钟后再试。', 429)


def location_values(data):
    country = string(data, 'country_code', 3, True).upper()
    province = string(data, 'province_code', 6)
    if country in CHINA_ALIASES:
        province = SPECIAL_PROVINCES.get(country, province)
        country = 'CHN'
    if country not in countries():
        raise Problem('请选择有效国家（使用 ISO 三字母代码，如 CHN、JPN）')
    city = string(data, 'city_code', 6)
    city_name = string(data, 'city_name', 80)
    if country == 'CHN':
        if province not in PROVINCES:
            raise Problem('中国的位置需要选择省级行政区')
        if province in MUNICIPALITIES:
            city, city_name = province, PROVINCES[province]
        if city and (not re.fullmatch(r'\d{6}', city) or city[:2] != province[:2]):
            raise Problem('城市行政区代码必须属于所选省份')
        if city and not city_name:
            raise Problem('填写城市代码时也需要城市名称')
        if city and province not in MUNICIPALITIES | {'710000'} and city[2:4] != '90' and not city.endswith('00'):
            raise Problem('请填写市级行政区代码，不要填写区县代码')
        if city_name and not city:
            raise Problem('中国城市需要行政区代码，可通过城市选择或手工填写')
    else:
        province, city = '', ''
    coords = []
    for field, bound in [('longitude', 180), ('latitude', 90)]:
        value = data.get(field)
        try:
            number = None if value in (None, '') else Decimal(str(value))
            if number is not None and (not number.is_finite() or not -bound <= number <= bound):
                raise InvalidOperation
            coords.append(number.quantize(Decimal('0.000001')) if number is not None else None)
        except (InvalidOperation, ValueError):
            raise Problem(f'{field} 超出有效范围')
    if (coords[0] is None) != (coords[1] is None):
        raise Problem('经纬度必须同时填写或同时留空')
    system = string(data, 'coordinate_system', 8) or ('gcj02' if country == 'CHN' else 'wgs84')
    if system not in {'gcj02', 'wgs84'}:
        raise Problem('坐标系应为 gcj02 或 wgs84')
    if coords[0] is not None and country == 'CHN' and province not in {'710000', '810000', '820000'} and system != 'gcj02':
        raise Problem('中国内地坐标请先通过高德转换为 GCJ-02，避免点位偏移')
    start = parse_date(data.get('started_on'), '到达日期', True)
    end = parse_date(data.get('ended_on'), '离开日期')
    if end and end <= start:
        raise Problem('离开日期必须晚于到达日期；离开当天不再计入此地点')
    if start > timezone.localdate():
        raise Problem('历史和当前位置不能使用未来到达日期')
    return dict(country_code=country, province_code=province, city_code=city, city_name=city_name,
                label=string(data, 'label', 120), longitude=coords[0], latitude=coords[1], coordinate_system=system,
                started_on=start, ended_on=end, note=string(data, 'note', 500))


def lock_member(member):
    # Every write takes these locks in this order, including imports and claims.
    Classroom.objects.select_for_update().get(pk=member.classroom_id)
    return Member.objects.select_for_update().get(pk=member.pk)


def is_self(member, actor):
    # An admin editing their own member record counts as self too.
    return bool(actor and actor.is_authenticated and member.user_id == actor.pk)


def apply_note(member, data):
    """Save the personal note (Member.bio) in the caller's transaction, guarded by the version the
    form was opened with. Only when the client sends member_version: imports never do."""
    if 'member_version' not in data:
        return
    if data.get('member_version') != member.updated_at.isoformat():
        raise Problem('个人备注已被更新，请重新打开再改', 409)
    member.bio = string(data, 'bio', 240)
    member.save(update_fields=['bio', 'updated_at'])


@transaction.atomic
def save_location(member, data, actor, location_id=None, check_version=True, confirm=True):
    member = lock_member(member)
    if confirm and is_self(member, actor):
        apply_note(member, data)
    values = location_values(data)
    existing = None
    if location_id:
        existing = member.locations.filter(pk=location_id).first()
        if not existing:
            raise Problem('找不到这条足迹', 404)
        if check_version and data.get('version') != existing.updated_at.isoformat():
            raise Problem('记录已被更新，请刷新后再编辑。', 409)
    others = member.locations.exclude(pk=location_id).order_by('started_on')
    # Explicit move action closes the preceding open interval, never historical records.
    if not existing and data.get('close_previous') is True:
        previous = others.filter(ended_on__isnull=True, started_on__lt=values['started_on']).first()
        if previous:
            previous.ended_on = values['started_on']
            previous.updated_by = actor
            previous.save()
            audit(member.classroom, actor, 'location.close', member, location_id=previous.pk)
    overlap = others.filter(Q(started_on__lt=values['ended_on']) if values['ended_on'] else Q()).filter(
        Q(ended_on__isnull=True) | Q(ended_on__gt=values['started_on']))
    if overlap.exists():
        raise Problem('这段时间与已有足迹重叠。请调整日期，或勾选结束上一个常住地。', 409)
    location = existing or Location(member=member)
    for key, value in values.items():
        setattr(location, key, value)
    location.updated_by = actor
    # Only the member saving their own stay confirms it; others' edits keep the previous value.
    if confirm and is_self(member, actor):
        location.confirmed_at = timezone.now()
    elif not existing:
        # Spec 5.7: a stay nobody self-confirmed counts as known on its start date.
        location.confirmed_at = timezone.make_aware(datetime.combine(location.started_on, time.min))
    location.full_clean()
    location.save()
    audit(member.classroom, actor, 'location.update' if existing else 'location.create', member, location_id=location.pk)
    return location


@transaction.atomic
def confirm_location(member, location_id, version, actor, data=None):
    member = lock_member(member)
    # Checked on the locked row so a concurrent claim reset cannot slip through.
    if not is_self(member, actor):
        raise Problem('只能确认自己的位置', 403)
    location = member.locations.filter(pk=location_id).first()
    if not location:
        raise Problem('找不到这条足迹', 404)
    if version != location.updated_at.isoformat():
        raise Problem('记录已被更新，请刷新后再确认。', 409)
    if location.ended_on and location.ended_on <= timezone.localdate():
        raise Problem('这条位置已经结束')
    apply_note(member, data or {})
    # update() rather than save(): save() would bump updated_at (the edit version).
    Location.objects.filter(pk=location.pk).update(confirmed_at=timezone.now())
    audit(member.classroom, actor, 'location.confirm', member, location_id=location.pk)
    location.refresh_from_db()
    return location


@transaction.atomic
def issue_claim(member, actor, reset=False):
    member = lock_member(member)
    if member.user_id and not reset:
        raise Problem('该同学已认领；重置需明确选择重新认领。', 409)
    if reset and member.user_id:
        user = member.user
        # Password hash change invalidates all existing Django sessions.
        user.set_unusable_password()
        user.save(update_fields=['password'])
    code = secrets.token_urlsafe(24)
    member.claim_hash = make_password(code)
    member.claim_expires_at = timezone.now() + timedelta(days=7)
    member.save()
    audit(member.classroom, actor, 'claim.reset' if reset else 'claim.issue', member)
    return code, member.claim_expires_at


IMPORT_FIELDS = {'student_code', 'name', 'bio', 'country_code', 'province_code', 'city_code', 'city_name',
                 'label', 'longitude', 'latitude', 'coordinate_system', 'started_on', 'ended_on', 'note'}


def parse_import(data):
    rows = data.get('rows')
    if rows is None:
        content = string(data, 'csv', 1_000_000, True).lstrip('\ufeff')
        reader = csv.DictReader(io.StringIO(content))
        if not reader.fieldnames or len(reader.fieldnames) != len(set(reader.fieldnames)):
            raise Problem('CSV 表头缺失或重复')
        rows = list(reader)
    if not isinstance(rows, list) or not 1 <= len(rows) <= 1000:
        raise Problem('每次请导入 1–1000 行')
    for i, row in enumerate(rows, 2):
        if not isinstance(row, dict) or set(row) - IMPORT_FIELDS:
            raise Problem(f'第 {i} 行含有未知字段，请使用导入模板')
        if any(value is None or isinstance(value, (dict, list, bool)) for value in row.values()):
            raise Problem(f'第 {i} 行格式不正确，请检查列数和字段')
        for key, value in list(row.items()):
            row[key] = str(value).strip()
    return rows


@transaction.atomic
def import_rows(classroom, rows, actor, dry_run=False):
    Classroom.objects.select_for_update().get(pk=classroom.pk)
    created, updated, stays, seen, roster = 0, 0, 0, set(), set()
    for index, row in enumerate(rows, 2):
        try:
            code, name = string(row, 'student_code', 64, True), string(row, 'name', 60, True)
            member, new = Member.objects.get_or_create(classroom=classroom, student_code=code, defaults={'name': name})
            if code not in roster:
                created += int(new)
                updated += int(not new)
                roster.add(code)
            member.name = name
            if 'bio' in row:
                member.bio = string(row, 'bio', 240)
            member.save()
            if row.get('country_code') or row.get('started_on'):
                values = location_values(row)
                identity = (code, values['started_on'])
                if identity in seen:
                    raise Problem('同一同学的到达日期重复')
                seen.add(identity)
                old = member.locations.filter(started_on=values['started_on']).first()
                save_location(member, row, actor, old.pk if old else None, check_version=False, confirm=False)
                stays += 1
        except (Problem, ValidationError) as error:
            message = error.message if isinstance(error, Problem) else '; '.join(error.messages)
            raise Problem(f'第 {index} 行：{message}')
    audit(classroom, actor, 'roster.import', rows=len(rows), created=created, updated=updated, stays=stays)
    if dry_run:
        transaction.set_rollback(True)
    return {'created': created, 'updated': updated, 'locations': stays, 'rows': len(rows)}
