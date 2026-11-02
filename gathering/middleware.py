"""Private responses and browser-side same-origin protection behind FC ingress."""

from secrets import compare_digest

from django.conf import settings
from django.http import JsonResponse

from .client_ip import normalized_ip


def _untrusted_esa_origin(request):
    if not settings.ESA_ORIGIN_SECRET:
        return False
    # ESA must overwrite both values on ALL origin-bound requests, not merely
    # add them. A forged browser header must never be accepted as proof.
    if not compare_digest(request.META.get('HTTP_X_REGATHER_ORIGIN_TOKEN', ''),
                          settings.ESA_ORIGIN_SECRET):
        return True
    try:
        normalized_ip(request.META.get('HTTP_X_REGATHER_CLIENT_IP', ''))
    except ValueError:
        return True
    return False


def _cross_origin_browser_request(request):
    # FC's legacy HTTP gateway reflects Origin with Allow-Credentials, even if
    # Django would not emit any CORS headers. Never return private data to such
    # requests; API-configured gateway CORS may require an FC preview entitlement.
    origin = request.META.get('HTTP_ORIGIN')
    if origin is not None and origin != f'{request.scheme}://{request.get_host()}':
        return True

    # A browser's fetch metadata is useful defense in depth when a resource is
    # loaded without Origin (e.g. no-cors). Leave top-level link navigations
    # intact so classmates can follow links from WeChat/other websites.
    private_endpoint = (request.path.startswith('/_AMapService/') or
                        request.path.startswith('/admin/') or
                        request.path.startswith('/c/') and '/api/' in request.path)
    return (private_endpoint and request.META.get('HTTP_SEC_FETCH_SITE') in ('same-site', 'cross-site')
            and request.META.get('HTTP_SEC_FETCH_MODE') != 'navigate')


class PrivateResponseMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if _untrusted_esa_origin(request) or _cross_origin_browser_request(request):
            response = JsonResponse({'error': '仅允许同源或可信入口访问'}, status=403)
            response['Cache-Control'] = 'private, no-store'
            response['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
            return response
        if request.path == '/admin/login/' and request.method == 'POST':
            from .client_ip import client_ip
            from .services import Problem, throttle
            try:
                throttle('system-admin-login', client_ip(request), 20)
            except Problem as error:
                response = JsonResponse({'error': error.message}, status=error.status)
                response['Cache-Control'] = 'private, no-store'
                return response
        response = self.get_response(request)
        if not request.path.startswith('/static/'):
            response['Cache-Control'] = 'private, no-store'
            response['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
        response['Permissions-Policy'] = 'geolocation=(self)'
        return response
