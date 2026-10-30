from django.urls import path
from . import views

urlpatterns = [
    path('', views.page, name='class-page'),
    path('api/bootstrap', views.bootstrap), path('api/unlock', views.unlock),
    path('api/login', views.sign_in), path('api/logout', views.sign_out), path('api/claim', views.claim),
    path('api/password', views.password_change), path('api/snapshot', views.snapshot),
    path('api/members/<int:member_id>', views.member_detail),
    path('api/members/<int:member_id>/locations', views.location_create),
    path('api/members/<int:member_id>/locations/<int:location_id>', views.location_detail),
    path('api/members/<int:member_id>/locations/<int:location_id>/confirm', views.location_confirm),
    path('api/admin/members/<int:member_id>/invite', views.invite),
    path('api/admin/import', views.roster_import), path('api/admin/settings', views.class_settings),
]
