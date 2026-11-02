import os
from pathlib import Path
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.getenv('DEBUG', '0') == '1'
SECRET_KEY = os.getenv('SECRET_KEY', '')
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured('Set SECRET_KEY (or DEBUG=1 for local development).')
    SECRET_KEY = 'local-development-only-do-not-deploy'
ALLOWED_HOSTS = os.getenv('ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1]').split(',')
CSRF_TRUSTED_ORIGINS = list(filter(None, os.getenv('CSRF_TRUSTED_ORIGINS', '').split(',')))
INSTALLED_APPS = [
    'django.contrib.admin', 'django.contrib.auth', 'django.contrib.contenttypes',
    'django.contrib.sessions', 'django.contrib.messages', 'django.contrib.staticfiles', 'gathering',
]
MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware', 'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware', 'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware', 'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'gathering.middleware.PrivateResponseMiddleware',
]
ROOT_URLCONF = 'config.urls'
TEMPLATES = [{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'DIRS': [], 'APP_DIRS': True,
              'OPTIONS': {'context_processors': ['django.template.context_processors.request',
                  'django.contrib.auth.context_processors.auth', 'django.contrib.messages.context_processors.messages']}}]
WSGI_APPLICATION = 'config.wsgi.application'
if os.getenv('REGATHER_FC') == '1' and not os.getenv('MYSQL_HOST'):
    raise ImproperlyConfigured('FC requires MYSQL_HOST; its local filesystem is not persistent storage.')
if os.getenv('MYSQL_HOST'):
    import pymysql
    pymysql.install_as_MySQLdb()
    DATABASES = {'default': {
        'ENGINE': 'django.db.backends.mysql', 'HOST': os.environ['MYSQL_HOST'],
        'PORT': os.getenv('MYSQL_PORT', '3306'), 'NAME': os.getenv('MYSQL_DATABASE', 'regather'),
        'USER': os.getenv('MYSQL_USER', 'regather'), 'PASSWORD': os.environ['MYSQL_PASSWORD'],
        'CONN_MAX_AGE': int(os.getenv('MYSQL_CONN_MAX_AGE', '60')), 'CONN_HEALTH_CHECKS': True,
        'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'",
                    'connect_timeout': int(os.getenv('MYSQL_CONNECT_TIMEOUT', '10')),
                    'read_timeout': int(os.getenv('MYSQL_READ_TIMEOUT', '30')),
                    'write_timeout': int(os.getenv('MYSQL_WRITE_TIMEOUT', '30')),
                    **({'ssl': {'ca': os.environ['MYSQL_SSL_CA'], 'check_hostname': True}} if os.getenv('MYSQL_SSL_CA') else {})},
    }}
else:
    DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3',
                            'NAME': os.getenv('SQLITE_PATH', str(BASE_DIR / 'db.sqlite3')),
                            'OPTIONS': {'timeout': 20}}}
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 10}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]
LANGUAGE_CODE = 'zh-hans'
TIME_ZONE = 'Asia/Shanghai'
USE_I18N = True
USE_TZ = True
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
            'staticfiles': {'BACKEND': 'config.storage.ModuleStaticStorage'}}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_AGE = 60 * 60 * 24 * 14
SECURE_SSL_REDIRECT = not DEBUG and os.getenv('SECURE_SSL_REDIRECT', '1') == '1'
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'same-origin'
# Enable only behind a trusted proxy that overwrites X-Forwarded-Proto.
if os.getenv('TRUST_PROXY', '0') == '1':
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
DEFAULT_CLASS_SLUG = os.getenv('DEFAULT_CLASS_SLUG', 'our-class')
AMAP_JS_KEY = os.getenv('AMAP_JS_KEY', '')
AMAP_SERVICE_HOST = os.getenv('AMAP_SERVICE_HOST', '/_AMapService')
# FC can serve the same-origin security proxy without a separate nginx server.
AMAP_PROXY_ENABLED = os.getenv('AMAP_PROXY_ENABLED', '0') == '1'
AMAP_PROXY_SECURITY_CODE = os.getenv('AMAP_PROXY_SECURITY_CODE', '')
# Development only. Production uses a server-side reverse proxy.
AMAP_SECURITY_JS_CODE = os.getenv('AMAP_SECURITY_JS_CODE', '') if DEBUG else ''
CSRF_FAILURE_VIEW = 'gathering.views.csrf_failure'
