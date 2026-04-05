from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib import error, parse, request

import yaml


ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR))

from scripts.person_schema_migration import migrate_person_schema, prune_person_schema

ENV_PATH = ROOT_DIR / '.env'
PEOPLE_DIR = ROOT_DIR / 'data' / 'people'
MANIFEST_PATH = PEOPLE_DIR / 'index.json'
STRUCTURE_PATH = ROOT_DIR / 'structure.yaml'
TABLE_NAME = 'family_yaml'
SCHEMA_NAME = 'family_site'


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


def fetch_rows() -> list[dict[str, object]]:
  base_url, service_key = get_required_config()
  query = parse.urlencode({
    'select': 'id,payload',
    'order': 'id.asc',
    'limit': '1000',
  })
  url = f'{base_url}/rest/v1/{TABLE_NAME}?{query}'
  req = request.Request(
    url,
    headers={
      'apikey': service_key,
      'Authorization': f'Bearer {service_key}',
      'Accept-Profile': SCHEMA_NAME,
    },
    method='GET',
  )

  try:
    with request.urlopen(req) as response:
      return json.loads(response.read().decode('utf-8'))
  except error.HTTPError as exc:
    details = exc.read().decode('utf-8', errors='replace')
    raise RuntimeError(f'HTTP {exc.code} for {url}\n{details}') from exc


def load_structure_schema() -> object:
  return yaml.safe_load(STRUCTURE_PATH.read_text(encoding='utf-8'))


def order_by_schema(value: object, schema_node: object) -> object:
  if isinstance(value, list):
    item_schema = schema_node[0] if isinstance(schema_node, list) and schema_node else None
    return [order_by_schema(item, item_schema) for item in value]

  if not isinstance(value, dict):
    return value

  ordered: dict[str, object] = {}
  schema_keys = list(schema_node.keys()) if isinstance(schema_node, dict) else []

  for key in schema_keys:
    if key not in value:
      continue
    ordered[key] = order_by_schema(value[key], schema_node.get(key))

  for key, nested_value in value.items():
    if key in ordered:
      continue
    ordered[key] = order_by_schema(nested_value, None)

  return ordered


def export_rows() -> None:
  rows = fetch_rows()
  if not rows:
    raise RuntimeError('В таблице family_yaml пока нет данных.')

  schema = load_structure_schema()
  PEOPLE_DIR.mkdir(parents=True, exist_ok=True)
  ids: list[str] = []

  for row in rows:
    person_id = str(row.get('id') or '').strip()
    payload = row.get('payload') or {}
    if not person_id:
      continue
    if not isinstance(payload, dict):
      raise RuntimeError(f'Некорректный payload для {person_id}.')

    payload = prune_person_schema(migrate_person_schema(payload, person_id)) or {'id': person_id}
    ordered_payload = order_by_schema(payload, schema)
    target = PEOPLE_DIR / f'{person_id}.yaml'
    target.write_text(
      yaml.safe_dump(
        ordered_payload,
        allow_unicode=True,
        sort_keys=False,
        width=10_000,
      ),
      encoding='utf-8',
    )
    ids.append(person_id)

  MANIFEST_PATH.write_text(
    json.dumps({'people': ids}, ensure_ascii=False, indent=2) + '\n',
    encoding='utf-8',
  )

  print(f'Готово: выгружено {len(ids)} карточек и обновлен index.json.')


if __name__ == '__main__':
  try:
    export_rows()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
