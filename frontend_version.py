"""Read APP_VERSION from frontend/src/version.ts."""
import os
import re

_VERSION_FILE = os.path.join(os.path.dirname(__file__), "frontend", "src", "version.ts")


def get_app_version() -> int:
    try:
        with open(_VERSION_FILE) as f:
            match = re.search(r'APP_VERSION\s*=\s*(\d+)', f.read())
            return int(match.group(1)) if match else 0
    except Exception:
        return 0
