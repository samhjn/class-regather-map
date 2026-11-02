"""Client identity for throttling behind an explicitly trusted proxy chain."""
from ipaddress import ip_address
from secrets import compare_digest

from django.conf import settings


def normalized_ip(value):
    # Scope IDs and host:port forms are not client addresses in X-Forwarded-For.
    if '%' in value:
        raise ValueError('Scoped address is not supported')
    address = ip_address(value.strip())
    return str(getattr(address, 'ipv4_mapped', None) or address)


def valid_esa_token(request):
    secret = settings.ESA_ORIGIN_SECRET
    supplied = request.META.get('HTTP_X_REGATHER_ORIGIN_TOKEN', '')
    # compare_digest on str raises TypeError for non-ASCII request headers.
    return bool(secret and isinstance(supplied, str) and
                compare_digest(supplied.encode('utf-8'), secret.encode('utf-8')))


def client_ip(request):
    peer = request.META.get('REMOTE_ADDR', '')
    try:
        peer = normalized_ip(peer)
    except ValueError:
        peer = ''
    # When ESA protects the FC origin, its authenticated and overwritten source
    # address is authoritative; there is no need to guess the ESA/FC XFF chain.
    if settings.ESA_ORIGIN_SECRET:
        if not valid_esa_token(request):
            return peer
        try:
            return normalized_ip(request.META['HTTP_X_REGATHER_CLIENT_IP'])
        except (KeyError, ValueError):
            return peer
    hops = settings.TRUSTED_PROXY_HOPS
    if not hops:
        return peer
    # The runtime must only be reachable through these proxies, each of which
    # appends its peer (or the edge overwrites XFF). Never use the leftmost value.
    forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
    if len(forwarded) > 8192:
        return peer
    addresses = forwarded.rsplit(',', hops)
    if len(addresses) < hops:
        return peer
    try:
        trusted = [normalized_ip(value) for value in addresses[-hops:]]
    except ValueError:
        return peer
    return trusted[0]
