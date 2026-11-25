"""Hosting checks: the running server must report the archive's application version."""
import json
from pathlib import Path
import urllib.request


def check_served_version(url, bundle, context=None):
    """Compare /api/vilnius/version with the bundle's release.json version.

    Returns the served version. Archives packaged before release.json carried a
    version are not checked and return None.
    """
    expected = json.loads((Path(bundle) / "release.json").read_text()).get("version")
    if expected is None:
        return None
    with urllib.request.urlopen(url + "/api/vilnius/version", timeout=10, context=context) as response:
        header = response.headers.get("X-App-Version")
        served = json.load(response).get("version")
    if header is None:
        raise RuntimeError(f"{url}/api/vilnius/version sent no X-App-Version header (archive version {expected!r})")
    if served != expected or header != expected:
        raise RuntimeError(f"served version {served!r} (header {header!r}) does not match the archive's {expected!r}")
    return served
