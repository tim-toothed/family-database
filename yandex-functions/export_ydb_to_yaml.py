from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from ydb_utils import DEFAULT_PROFILE, ROOT_DIR, fetch_yql_json

sys.path.insert(0, str(ROOT_DIR))

from supabase.person_payload import migrate_person_schema, prune_person_schema


PEOPLE_DIR = ROOT_DIR / 'data' / 'people'
MANIFEST_PATH = PEOPLE_DIR / 'index.json'
STRUCTURE_PATH = ROOT_DIR / 'structure.yaml'


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description='Выгружает карточки из Yandex YDB в YAML.')
  parser.add_argument('--profile', default=DEFAULT_PROFILE, help='Профиль ydb CLI.')
  parser.add_argument('--ydb-bin', help='Путь к ydb CLI.')
  parser.add_argument('--people-dir', default=str(PEOPLE_DIR), help='Папка для YAML-карточек.')
  return parser.parse_args()


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


def parse_payload(value: object, person_id: str) -> dict[str, object]:
  if isinstance(value, dict):
    return value
  if isinstance(value, str):
    parsed = json.loads(value)
    if isinstance(parsed, dict):
      return parsed
  raise RuntimeError(f'Некорректный payload для {person_id}.')


def main() -> None:
  args = parse_args()
  rows = fetch_yql_json(
    'SELECT id, payload FROM family_yaml ORDER BY id LIMIT 5000;',
    profile=args.profile,
    ydb_bin=args.ydb_bin,
  )
  if not rows:
    raise RuntimeError('В таблице family_yaml пока нет данных.')

  schema = load_structure_schema()
  people_dir = Path(args.people_dir).resolve()
  people_dir.mkdir(parents=True, exist_ok=True)
  ids: list[str] = []

  for row in rows:
    person_id = str(row.get('id') or '').strip()
    if not person_id:
      continue

    payload = parse_payload(row.get('payload'), person_id)
    payload = prune_person_schema(migrate_person_schema(payload, person_id)) or {'id': person_id}
    ordered_payload = order_by_schema(payload, schema)
    target = people_dir / f'{person_id}.yaml'
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

  manifest_path = people_dir / MANIFEST_PATH.name
  manifest_path.write_text(
    json.dumps({'people': ids}, ensure_ascii=False, indent=2) + '\n',
    encoding='utf-8',
  )

  print(f'Готово: выгружено {len(ids)} карточек и обновлен {manifest_path}.')


if __name__ == '__main__':
  try:
    main()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
