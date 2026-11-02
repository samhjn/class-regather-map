"""AMap's documented security proxy, with fixed upstreams and app-session access."""
import http.client
import re
from urllib.parse import urlencode

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.views.decorators.http import require_GET

from .models import Classroom

MAX_RESPONSE_BYTES = 8 * 1024 * 1024


@require_GET
def amap_proxy(request, resource):
    if not (settings.AMAP_PROXY_ENABLED and settings.AMAP_JS_KEY and settings.AMAP_PROXY_SECURITY_CODE):
        return JsonResponse({'error': '地图代理尚未配置'}, status=503)
    from .views import can_read
    classroom = Classroom.objects.filter(pk=request.session.get('amap_proxy_class')).first()
    if not classroom or not can_read(request, classroom):
        return JsonResponse({'error': '请先打开并解锁班级地图'}, status=403)
    # A path can never select a host, scheme, port, or parent directory.
    if len(resource) > 256 or not re.fullmatch(r'v[34]/[A-Za-z0-9_/-]+', resource) or '//' in resource:
        return JsonResponse({'error': '地图请求路径不支持'}, status=400)
    if len(request.META.get('QUERY_STRING', '')) > 16384:
        return JsonResponse({'error': '地图请求过长'}, status=400)
    keys = request.GET.getlist('key')
    if keys and keys != [settings.AMAP_JS_KEY]:
        return JsonResponse({'error': '地图 Key 不匹配'}, status=400)
    callbacks = request.GET.getlist('callback')
    if callbacks and (len(callbacks) != 1 or not re.fullmatch(r'[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*', callbacks[0], re.ASCII)):
        return JsonResponse({'error': '地图回调无效'}, status=400)
    host = ('webapi.amap.com' if resource == 'v4/map/styles' or resource.startswith('v4/map/styles/')
            else 'fmap01.amap.com' if resource == 'v3/vectormap' or resource.startswith('v3/vectormap/')
            else 'restapi.amap.com')
    query = [(key, value) for key, values in request.GET.lists() if key.lower() not in ('key', 'jscode') for value in values]
    query.extend([('key', settings.AMAP_JS_KEY), ('jscode', settings.AMAP_PROXY_SECURITY_CODE)])
    upstream = http.client.HTTPSConnection(host, timeout=10)
    try:
        # Never forward browser credentials/headers or follow upstream redirects.
        upstream.request('GET', '/' + resource + '?' + urlencode(query),
                         headers={'Accept': '*/*', 'Accept-Encoding': 'identity'})
        response = upstream.getresponse()
        if response.status != 200:
            return JsonResponse({'error': '地图服务暂时不可用'}, status=502)
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            return JsonResponse({'error': '地图响应过大'}, status=502)
        content_type = response.getheader('Content-Type', 'application/octet-stream')
        if content_type.split(';', 1)[0].strip().lower() in ('text/html', 'application/xhtml+xml'):
            return JsonResponse({'error': '地图服务响应无效'}, status=502)
        if callbacks:
            content_type = 'application/javascript; charset=utf-8'
        result = HttpResponse(body, content_type=content_type)
        if response.getheader('Content-Encoding'):
            result['Content-Encoding'] = response.getheader('Content-Encoding')
        return result
    except (OSError, http.client.HTTPException):
        # Exceptions can contain the upstream URL and its security code.
        return JsonResponse({'error': '地图服务连接失败，请稍后重试'}, status=502)
    finally:
        upstream.close()
