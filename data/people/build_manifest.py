from __future__ import annotations

import json
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = BASE_DIR / "index.json"


def collect_people_ids() -> list[str]:
    return sorted(path.stem for path in BASE_DIR.glob("P*.yaml"))


def main() -> None:
    manifest = {"people": collect_people_ids()}
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Updated {MANIFEST_PATH} with {len(manifest['people'])} people.")


if __name__ == "__main__":
    main()
