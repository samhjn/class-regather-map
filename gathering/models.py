from django.conf import settings
from django.db import models
from django.db.models import F, Q


class Classroom(models.Model):
    slug = models.SlugField(unique=True)
    name = models.CharField(max_length=80)
    description = models.CharField(max_length=240, blank=True)
    unlock_password = models.CharField(max_length=128, blank=True)
    gate_version = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class Member(models.Model):
    classroom = models.ForeignKey(Classroom, on_delete=models.CASCADE, related_name='members')
    student_code = models.CharField(max_length=64)
    name = models.CharField(max_length=60)
    bio = models.CharField(max_length=240, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
    is_admin = models.BooleanField(default=False)
    claim_hash = models.CharField(max_length=128, blank=True)
    claim_expires_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['student_code', 'id']
        constraints = [models.UniqueConstraint(fields=['classroom', 'student_code'], name='member_class_code'),
                       models.UniqueConstraint(fields=['classroom', 'user'], name='member_class_user')]

    def __str__(self):
        return f'{self.classroom} / {self.name}'


class Location(models.Model):
    member = models.ForeignKey(Member, on_delete=models.CASCADE, related_name='locations')
    country_code = models.CharField(max_length=3)
    province_code = models.CharField(max_length=6, blank=True)
    city_code = models.CharField(max_length=6, blank=True)
    city_name = models.CharField(max_length=80, blank=True)
    label = models.CharField(max_length=120, blank=True)
    longitude = models.DecimalField(max_digits=10, decimal_places=6, null=True, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    coordinate_system = models.CharField(max_length=8, choices=[('gcj02', 'GCJ-02'), ('wgs84', 'WGS84')], default='gcj02')
    started_on = models.DateField()
    # Exclusive end: on this date the student is no longer here.
    ended_on = models.DateField(null=True, blank=True)
    note = models.CharField(max_length=500, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
    # Last time the member themself said "this is still true". Unlike updated_at,
    # admin edits and imports never touch it.
    confirmed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['started_on', 'id']
        indexes = [models.Index(fields=['member', 'started_on', 'ended_on'], name='location_timeline'),
                   models.Index(fields=['country_code', 'province_code', 'city_code'], name='location_region')]
        constraints = [
            models.CheckConstraint(condition=Q(ended_on__isnull=True) | Q(ended_on__gt=F('started_on')), name='positive_stay'),
            models.CheckConstraint(condition=(Q(longitude__isnull=True) & Q(latitude__isnull=True)) |
                                   (Q(longitude__isnull=False) & Q(latitude__isnull=False)), name='coordinate_pair'),
            models.CheckConstraint(condition=Q(longitude__isnull=True) | Q(longitude__gte=-180, longitude__lte=180), name='valid_longitude'),
            models.CheckConstraint(condition=Q(latitude__isnull=True) | Q(latitude__gte=-90, latitude__lte=90), name='valid_latitude'),
        ]


class AuditEvent(models.Model):
    classroom = models.ForeignKey(Classroom, on_delete=models.CASCADE)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    action = models.CharField(max_length=40)
    member = models.ForeignKey(Member, on_delete=models.SET_NULL, null=True)
    detail = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)


class RateBucket(models.Model):
    key = models.CharField(max_length=64, unique=True)
    attempts = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField()
