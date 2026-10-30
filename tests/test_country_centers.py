import re
from pathlib import Path

from django.test import SimpleTestCase

from gathering.geography import countries


class CountryCenterCoverageTests(SimpleTestCase):
    """Every selectable overseas country needs a dot position, or the overseas map would
    drop people (or crash) while the header still counts them."""

    def test_every_selectable_country_has_a_center(self):
        source = Path('gathering/static/gathering/country-centers.js').read_text()
        known = set(re.findall(r'^\s*([A-Z]{3}): \[', source, flags=re.M))
        missing = sorted(set(countries()) - known - {'CHN'})
        self.assertEqual(missing, [])
