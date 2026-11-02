"""Client identity for throttling behind an explicitly trusted proxy chain."""
from ipaddress import ip_address

from django.conf import settings


def normalized_ip(value):
    # Scope IDs and host:port forms are not client addresses in X-Forwarded-For.
    if '%' in value:
        raise ValueError('Scoped address is not supported')
    address = ip_address(value.strip())
    return str(getattr(address, 'ipv4_mapped', None) or address)


def client_ip(request):
    peer = request.META.get('REMOTE_ADDR', '')
    try:
        peer = normalized_ip(peer)
    except ValueError:
        peer = ''
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
