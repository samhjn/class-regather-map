class PrivateResponseMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == '/admin/login/' and request.method == 'POST':
            from django.http import JsonResponse
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
