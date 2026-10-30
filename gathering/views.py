import hashlib
import json
import secrets
from functools import wraps

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout, update_session_auth_hash
from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.password_validation import validate_password
from django.core import signing
from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.db.models import Min, Prefetch, Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET

from .geography import PROVINCES, countries, country_name
from .models import Classroom, Location, Member
from .services import (Problem, audit, confirm_location, import_rows, issue_claim, lock_member, parse_date,
                       parse_import, save_location, secret_text, string, throttle, validate_member_password)


def csrf_failure(request, reason=''):
    return JsonResponse({'error': '页面凭据已过期，请刷新后重试。'}, status=403)


@require_GET
def health(request):
    with connection.cursor() as cursor:
        cursor.execute('SELECT 1')
    return JsonResponse({'status': 'ok'})


@require_GET
def home(request):
    response = redirect('class-page', slug=settings.DEFAULT_CLASS_SLUG)
    if request.GET:
        response['Location'] += '?' + request.GET.urlencode()
    return response


@ensure_csrf_cookie
@require_GET
def page(request, slug):
    classroom = get_object_or_404(Classroom, slug=slug)
    return render(request, 'gathering/index.html', {'classroom': classroom})


def current_member(request, classroom):
    if not request.user.is_authenticated:
        return None
    return classroom.members.filter(user=request.user).first()


def is_admin(request, classroom):
    member = current_member(request, classroom)
    return request.user.is_authenticated and (request.user.is_superuser or bool(member and member.is_admin))


def can_read(request, classroom):
    return not classroom.unlock_password or is_admin(request, classroom) or current_member(request, classroom) or (
        request.session.get(f'gate:{classroom.pk}') == classroom.gate_version)


def endpoint(methods=('GET',), access='read'):
    def decorate(func):
        @wraps(func)
        def wrapped(request, slug, **kwargs):
            if request.method not in methods:
                response = JsonResponse({'error': '请求方法不支持'}, status=405)
                response['Allow'] = ', '.join(methods)
                return response
            classroom = get_object_or_404(Classroom, slug=slug)
            try:
                if access != 'public' and not can_read(request, classroom):
                    raise Problem('请先解锁班级地图', 403)
                if access == 'admin' and not is_admin(request, classroom):
                    raise Problem('需要本班管理员权限', 403)
                data = {}
                if request.method != 'GET':
                    try:
                        data = json.loads(request.body or '{}')
                    except (ValueError, UnicodeDecodeError):
                        raise Problem('请求不是有效 JSON')
                    if not isinstance(data, dict):
                        raise Problem('请求需要 JSON 对象')
                result = func(request, classroom, data, **kwargs)
                return JsonResponse(result)
            except Problem as error:
                return JsonResponse({'error': error.message}, status=error.status)
            except ValidationError as error:
                return JsonResponse({'error': '；'.join(error.messages)}, status=400)
            except IntegrityError:
                return JsonResponse({'error': '数据发生冲突，请刷新后再试。'}, status=409)
        return wrapped
    return decorate


def check_edit(request, classroom, member_id):
    member = get_object_or_404(Member, pk=member_id, classroom=classroom)
    if not is_admin(request, classroom) and (not request.user.is_authenticated or member.user_id != request.user.pk):
        raise Problem('只能编辑自己的资料', 403)
    return member


def auth_throttle(request, classroom, kind, account=''):
    # REMOTE_ADDR is deliberate: never trust arbitrary X-Forwarded-For.
    throttle(f'{kind}:ip:{classroom.pk}', request.META.get('REMOTE_ADDR', ''), 60)
    if account:
        throttle(f'{kind}:account:{classroom.pk}', account, 15)


def location_json(location):
    return {key: getattr(location, key) for key in (
        'id', 'country_code', 'province_code', 'city_code', 'city_name', 'label', 'longitude', 'latitude',
        'coordinate_system', 'started_on', 'ended_on', 'note')} | {
        'country_name': country_name(location.country_code), 'province_name': PROVINCES.get(location.province_code, ''),
        'updated_at': location.updated_at.isoformat(), 'version': location.updated_at.isoformat(),
        'confirmed_at': timezone.localtime(location.confirmed_at).isoformat() if location.confirmed_at else None,
    }


def member_json(member, request, classroom):
    result = {'id': member.pk, 'name': member.name, 'bio': member.bio,
              'claimed': bool(member.user_id), 'updated_at': member.updated_at.isoformat()}
    if is_admin(request, classroom) or request.user.is_authenticated and member.user_id == request.user.pk:
        result['student_code'] = member.student_code
    return result


@endpoint(access='public')
def bootstrap(request, classroom, data):
    unlocked = bool(can_read(request, classroom))
    member = current_member(request, classroom)
    result = {'classroom': {'name': classroom.name, 'description': classroom.description, 'slug': classroom.slug},
              'unlocked': unlocked, 'has_password': bool(classroom.unlock_password),
              'is_admin': bool(is_admin(request, classroom)),
              'me': {'id': member.pk, 'name': member.name, 'student_code': member.student_code} if member else None,
              'today': timezone.localdate().isoformat(), 'authenticated': request.user.is_authenticated}
    if unlocked:
        result['countries'] = countries()
        result['provinces'] = PROVINCES
        result['map'] = {'key': settings.AMAP_JS_KEY, 'service_host': settings.AMAP_SERVICE_HOST,
                         'security_js_code': settings.AMAP_SECURITY_JS_CODE}
    return result


@endpoint(('POST',), access='public')
def unlock(request, classroom, data):
    auth_throttle(request, classroom, 'unlock')
    password = secret_text(data, 'password')
    if classroom.unlock_password and not check_password(password, classroom.unlock_password):
        raise Problem('班级密码不正确', 403)
    request.session.cycle_key()
    request.session[f'gate:{classroom.pk}'] = classroom.gate_version
    return {'ok': True}


@endpoint(('POST',), access='public')
def sign_in(request, classroom, data):
    field, identity = member_identity(data)
    password = secret_text(data, 'password')
    auth_throttle(request, classroom, 'login', f'{field}:{identity}')
    candidates = list(classroom.members.select_related('user').filter(**{field: identity})[:2])
    # Never silently select the first of two classmates with the same name.
    member = candidates[0] if len(candidates) == 1 else None
    user = authenticate(request, username=member.user.username if member and member.user else f'missing_{secrets.token_hex(16)}', password=password)
    if not user:
        raise Problem('姓名或个人密码不正确；同名同学可使用班级编号登录' if field == 'name' else '班级编号或个人密码不正确', 403)
    login(request, user)
    return {'ok': True}


@endpoint(('POST',), access='public')
def sign_out(request, classroom, data):
    logout(request)
    return {'ok': True}


def member_identity(data):
    name = string(data, 'name', 60)
    student_code = string(data, 'student_code', 64)
    if bool(name) == bool(student_code):
        raise Problem('请填写姓名，或使用班级编号')
    return ('name', name) if name else ('student_code', student_code)


@endpoint(('POST',))
def claim(request, classroom, data):
    field, identity = member_identity(data)
    code = secret_text(data, 'claim_code')
    password = secret_text(data, 'password')
    auth_throttle(request, classroom, 'claim', f'{field}:{identity}')
    validate_member_password(password)
    with transaction.atomic():
        Classroom.objects.select_for_update().get(pk=classroom.pk)
        candidates = classroom.members.select_for_update().filter(**{field: identity}, claim_expires_at__gt=timezone.now()).exclude(claim_hash='')
        matches = [member for member in candidates if check_password(code, member.claim_hash)]
        if len(matches) != 1:
            raise Problem('姓名或认领码不正确，或认领码已过期', 403)
        member = matches[0]
        if member.is_admin or member.user and (member.user.is_staff or member.user.is_superuser):
            validate_password(password, member.user)
        user = member.user or get_user_model()(username=f'm_{secrets.token_hex(16)}')
        user.set_password(password)
        user.save()
        member.user, member.claim_hash, member.claim_expires_at = user, '', None
        member.save()
        audit(classroom, user, 'claim.complete', member)
    login(request, user, backend='django.contrib.auth.backends.ModelBackend')
    return {'ok': True}


@endpoint(('POST',))
def password_change(request, classroom, data):
    member = current_member(request, classroom)
    if not member:
        raise Problem('请先登录个人账号', 403)
    auth_throttle(request, classroom, 'password', str(request.user.pk))
    if not request.user.check_password(secret_text(data, 'old_password')):
        raise Problem('原密码不正确', 403)
    password = secret_text(data, 'password')
    if member.is_admin or request.user.is_staff or request.user.is_superuser:
        validate_password(password, request.user)
    else:
        validate_member_password(password)
    request.user.set_password(password)
    request.user.save(update_fields=['password'])
    update_session_auth_hash(request, request.user)
    return {'ok': True}


@endpoint()
def snapshot(request, classroom, data):
    day = parse_date(request.GET.get('at') or timezone.localdate().isoformat(), '查询日期', True)
    if day > timezone.localdate():
        raise Problem('请选择今天或历史日期')
    active = Location.objects.filter(started_on__lte=day).filter(Q(ended_on__isnull=True) | Q(ended_on__gt=day))
    members = classroom.members.prefetch_related(Prefetch('locations', queryset=active, to_attr='active_locations'))
    admin = is_admin(request, classroom)
    rows = []
    for member in members:
        row = {'id': member.pk, 'name': member.name, 'bio': member.bio, 'claimed': bool(member.user_id),
               'location': location_json(member.active_locations[0]) if member.active_locations else None}
        if admin or member.user_id == request.user.pk and request.user.is_authenticated:
            row['student_code'] = member.student_code
        rows.append(row)
    return {'at': day, 'members': rows,
            'timeline_start': Location.objects.filter(member__classroom=classroom).aggregate(first=Min('started_on'))['first']}


@endpoint(('GET', 'PATCH'))
def member_detail(request, classroom, data, member_id):
    member = get_object_or_404(Member, pk=member_id, classroom=classroom)
    if request.method == 'PATCH':
        member = check_edit(request, classroom, member_id)
        with transaction.atomic():
            member = lock_member(member)
            if data.get('version') != member.updated_at.isoformat():
                raise Problem('资料已被更新，请重新打开', 409)
            member.name = string(data, 'name', 60, True)
            member.bio = string(data, 'bio', 240)
            member.save()
            audit(classroom, request.user, 'member.update', member)
    return {'member': member_json(member, request, classroom),
            'locations': [location_json(loc) for loc in member.locations.all()],
            'editable': bool(is_admin(request, classroom) or request.user.is_authenticated and member.user_id == request.user.pk)}


@endpoint(('POST',))
def location_create(request, classroom, data, member_id):
    member = check_edit(request, classroom, member_id)
    return {'location': location_json(save_location(member, data, request.user))}


@endpoint(('PATCH', 'DELETE'))
def location_detail(request, classroom, data, member_id, location_id):
    member = check_edit(request, classroom, member_id)
    if request.method == 'PATCH':
        return {'location': location_json(save_location(member, data, request.user, location_id))}
    with transaction.atomic():
        member = lock_member(member)
        location = get_object_or_404(Location, member=member, pk=location_id)
        if data.get('version') != location.updated_at.isoformat():
            raise Problem('记录已更新，请重新打开', 409)
        location.delete()
        audit(classroom, request.user, 'location.delete', member, location_id=location_id)
    return {'ok': True}


@endpoint(('POST',))
def location_confirm(request, classroom, data, member_id, location_id):
    # Not check_edit: admins may edit others' stays but never confirm them.
    member = get_object_or_404(Member, pk=member_id, classroom=classroom)
    return {'location': location_json(confirm_location(member, location_id, data.get('version'), request.user, data))}


@endpoint(('POST',), access='admin')
def invite(request, classroom, data, member_id):
    member = get_object_or_404(Member, classroom=classroom, pk=member_id)
    if member.user_id == request.user.pk and data.get('reset'):
        raise Problem('不能重置自己的认领，请使用修改个人密码')
    code, expires = issue_claim(member, request.user, reset=data.get('reset') is True)
    return {'student_code': member.student_code, 'name': member.name, 'claim_code': code, 'expires_at': expires}


def import_digest(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


@endpoint(('POST',), access='admin')
def roster_import(request, classroom, data):
    rows = parse_import(data)
    digest = import_digest(rows)
    if data.get('commit') is True:
        try:
            token = signing.loads(string(data, 'preview_token', 2000, True), salt='roster-import', max_age=3600)
        except signing.BadSignature:
            raise Problem('预览已失效，请重新预览')
        if token != {'class': classroom.pk, 'user': request.user.pk, 'digest': digest}:
            raise Problem('导入内容已改变，请重新预览')
        return import_rows(classroom, rows, request.user)
    result = import_rows(classroom, rows, request.user, dry_run=True)
    result['preview_token'] = signing.dumps({'class': classroom.pk, 'user': request.user.pk, 'digest': digest}, salt='roster-import')
    return result


@endpoint(('GET', 'PATCH'), access='admin')
def class_settings(request, classroom, data):
    if request.method == 'PATCH':
        with transaction.atomic():
            classroom = Classroom.objects.select_for_update().get(pk=classroom.pk)
            classroom.name = string(data, 'name', 80, True)
            classroom.description = string(data, 'description', 240)
            if 'password' in data:
                password = secret_text(data, 'password')
                if password:
                    validate_password(password)
                classroom.unlock_password = make_password(password) if password else ''
                classroom.gate_version += 1
            classroom.save()
            audit(classroom, request.user, 'class.update')
    return {'name': classroom.name, 'description': classroom.description, 'has_password': bool(classroom.unlock_password)}
