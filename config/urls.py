from django.contrib import admin
from django.urls import include, path
from gathering import views
from gathering.amap_proxy import amap_proxy

urlpatterns = [path('admin/', admin.site.urls), path('healthz/', views.health),
               path('_AMapService/<path:resource>', amap_proxy),
               path('', views.home), path('c/<slug:slug>/', include('gathering.urls'))]
