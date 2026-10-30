from datetime import datetime, time

from django.db import migrations, models
from django.utils import timezone


def backfill_confirmed_at(apps, schema_editor):
    """Spec 5.7: a stay last saved by its (claimed) owner was confirmed at updated_at;
    anything else (imports, admin edits, unclaimed) counts as confirmed on started_on."""
    Location = apps.get_model('gathering', 'Location')
    # list() first: SQLite gives no isolation when writing to a table mid-iteration.
    rows = list(Location.objects.values_list('pk', 'updated_by_id', 'member__user_id', 'updated_at', 'started_on'))
    for pk, editor, owner, updated_at, started_on in rows:
        if owner is not None and editor == owner:
            confirmed = updated_at
        else:
            confirmed = timezone.make_aware(datetime.combine(started_on, time.min))
        # update(), not save(): save() would bump auto_now updated_at (the edit version).
        Location.objects.filter(pk=pk).update(confirmed_at=confirmed)


class Migration(migrations.Migration):

    dependencies = [
        ('gathering', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='location',
            name='confirmed_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(backfill_confirmed_at, migrations.RunPython.noop),
    ]
