from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path
from typing import Iterable
from urllib import error, request

import yaml


ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR))

from scripts.person_schema_migration import migrate_person_schema, prune_person_schema

ENV_PATH = ROOT_DIR / '.env'
PEOPLE_DIR = ROOT_DIR / 'data' / 'people'
TABLE_NAME = 'family_yaml'
SCHEMA_NAME = 'family_site'
CHUNK_SIZE = 50


def parse_env_file(path: Path) -> dict[str, str]:
  values: dict[str, str] = {}

  for raw_line in path.read_text(encoding='utf-8').splitlines():
    line = raw_line.strip()
    if not line or line.startswith('#'):
      continue

    if '=' not in line:
      continue

    key, raw_value = line.split('=', 1)
    key = key.strip()
    value = raw_value.strip().rstrip(';').strip()
    if not key:
      continue

    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
      value = value[1:-1]

    values[key] = value

  return values


def get_required_config() -> tuple[str, str]:
  values = parse_env_file(ENV_PATH)
  url = values.get('supabaseUrl') or values.get('SUPABASE_URL')
  service_key = values.get('supabaseServiceKey') or values.get('SUPABASE_SERVICE_KEY')

  if not url or not service_key:
    raise RuntimeError('В .env не найдены supabaseUrl / supabaseServiceKey.')

  return url.rstrip('/'), service_key


def iter_person_records() -> Iterable[dict[str, object]]:
  for path in sorted(PEOPLE_DIR.glob('P*.yaml')):
    person_id = path.stem
    payload = yaml.safe_load(path.read_text(encoding='utf-8')) or {}
    if not isinstance(payload, dict):
      raise RuntimeError(f'{path.name}: YAML должен содержать объект.')

    payload = prune_person_schema(migrate_person_schema(payload, person_id)) or {'id': person_id}
    yield {
      'id': person_id,
      'payload': payload,
    }


def chunked(items: list[dict[str, object]], size: int) -> Iterable[list[dict[str, object]]]:
  for index in range(0, len(items), size):
    yield items[index:index + size]


def import_people() -> None:
  base_url, service_key = get_required_config()
  rows = list(iter_person_records())
  if not rows:
    raise RuntimeError('Не найдено ни одного YAML-файла для импорта.')

  endpoint = f'{base_url}/rest/v1/{TABLE_NAME}?on_conflict=id'
  total_chunks = math.ceil(len(rows) / CHUNK_SIZE)

  for index, chunk in enumerate(chunked(rows, CHUNK_SIZE), start=1):
    req = request.Request(
      endpoint,
      data=json.dumps(chunk, ensure_ascii=False).encode('utf-8'),
      method='POST',
      headers={
        'apikey': service_key,
        'Authorization': f'Bearer {service_key}',
        'Content-Type': 'application/json',
        'Content-Profile': SCHEMA_NAME,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
    )

    try:
      with request.urlopen(req):
        pass
    except error.HTTPError as exc:
      details = exc.read().decode('utf-8', errors='replace')
      raise RuntimeError(f'HTTP {exc.code} for chunk {index}/{total_chunks}\n{details}') from exc

    print(f'[{index}/{total_chunks}] Импортировано {len(chunk)} записей.')

  print(f'Готово: {len(rows)} карточек загружено в {TABLE_NAME}.')


if __name__ == '__main__':
  try:
    import_people()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
