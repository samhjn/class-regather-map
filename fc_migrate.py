"""IAM-only, temporary FC maintenance function; never attach an HTTP trigger."""
import io
import json
import os
import uuid


def handler(event, context):
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
    os.environ.setdefault('REGATHER_FC', '1')
    import django
    django.setup()
    from django.core.management import call_command
    from django.db import connection, transaction
    from django.db.migrations.executor import MigrationExecutor
    from gathering.models import Classroom

    action = json.loads(event or '{}').get('action', 'check')
    if action == 'migrate':
        output = io.StringIO()
        call_command('migrate', interactive=False, stdout=output)
    elif action == 'bootstrap':
        # Explicit opt-in. Existing classes and passwords are never overwritten.
        from django.contrib.auth import get_user_model
        from django.contrib.auth.password_validation import validate_password
        if not os.getenv('CLASS_UNLOCK_PASSWORD') or not os.getenv('DJANGO_SUPERUSER_PASSWORD'):
            raise ValueError('Bootstrap requires CLASS_UNLOCK_PASSWORD and DJANGO_SUPERUSER_PASSWORD.')
        validate_password(os.environ['DJANGO_SUPERUSER_PASSWORD'])
        slug = os.getenv('DEFAULT_CLASS_SLUG', 'our-class')
        if not Classroom.objects.filter(slug=slug).exists():
            call_command('initclass', slug=slug, name=os.getenv('CLASS_NAME', '我们的班级'))
        username = os.getenv('DJANGO_SUPERUSER_USERNAME', 'class-admin')
        if not get_user_model().objects.filter(username=username).exists():
            call_command('createsuperuser', interactive=False, username=username,
                         email=os.getenv('DJANGO_SUPERUSER_EMAIL', ''))
    elif action != 'check':
        raise ValueError('Allowed actions: migrate, check, bootstrap.')

    executor = MigrationExecutor(connection)
    pending = executor.migration_plan(executor.loader.graph.leaf_nodes())
    if pending:
        raise RuntimeError('Unapplied migrations remain.')
    probe_slug = 'fc-probe-' + uuid.uuid4().hex
    with transaction.atomic():
        probe = Classroom.objects.create(slug=probe_slug, name='FC transaction probe')
        if Classroom.objects.get(pk=probe.pk).name != probe.name:
            raise RuntimeError('Database round trip failed.')
        transaction.set_rollback(True)
    if Classroom.objects.filter(slug=probe_slug).exists():
        raise RuntimeError('Database rollback failed.')
    return {'status': 'ok', 'action': action, 'database': connection.vendor,
            'migrations_pending': 0, 'write_read_rollback': True}
