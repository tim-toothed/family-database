from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from d1_utils import build_location_args, get_database_name, run_wrangler_d1


ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR))

from supabase.person_payload import migrate_person_schema, prune_person_schema


DEFAULT_PEOPLE_DIR = ROOT_DIR / 'data' / 'people'
STRUCTURE_PATH = ROOT_DIR / 'structure.yaml'


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description='Экспортирует карточки из Cloudflare D1 в YAML.')
  parser.add_argument('--database', help='Имя D1-базы. По умолчанию: family-tree-db или значение из .env.')
  parser.add_argument('--output-dir', default=str(DEFAULT_PEOPLE_DIR), help='Папка, куда будут сохранены YAML-файлы.')
  parser.add_argument('--local', action='store_true', help='Читать из локальной D1 вместо remote.')
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


def fetch_rows(database_name: str, *, remote: bool) -> list[dict[str, object]]:
  result = run_wrangler_d1([
    'execute',
    database_name,
    *build_location_args(remote=remote),
    '--command=SELECT id, payload FROM family_yaml ORDER BY id',
  ], expect_json=True)

  if not isinstance(result, list) or not result:
    raise RuntimeError('Wrangler не вернул результаты запроса.')

  rows = result[0].get('results')
  if not isinstance(rows, list):
    raise RuntimeError('Неожиданный формат ответа от Wrangler.')

  return rows


def export_rows(rows: list[dict[str, object]], output_dir: Path) -> None:
  if not rows:
    raise RuntimeError('В таблице family_yaml пока нет данных.')

  schema = load_structure_schema()
  output_dir.mkdir(parents=True, exist_ok=True)
  ids: list[str] = []

  for row in rows:
    person_id = str(row.get('id') or '').strip()
    raw_payload = row.get('payload')
    if not person_id:
      continue

    if isinstance(raw_payload, str):
      payload = json.loads(raw_payload)
    elif isinstance(raw_payload, dict):
      payload = raw_payload
    else:
      raise RuntimeError(f'Некорректный payload для {person_id}.')

    payload = prune_person_schema(migrate_person_schema(payload, person_id)) or {'id': person_id}
    ordered_payload = order_by_schema(payload, schema)
    target = output_dir / f'{person_id}.yaml'
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

  manifest_path = output_dir / 'index.json'
  manifest_path.write_text(
    json.dumps({'people': ids}, ensure_ascii=False, indent=2) + '\n',
    encoding='utf-8',
  )

  print(f'Готово: выгружено {len(ids)} карточек и обновлен {manifest_path.name}.')


def main() -> None:
  args = parse_args()
  database_name = get_database_name(args.database)
  output_dir = Path(args.output_dir).resolve()
  rows = fetch_rows(database_name, remote=not args.local)
  export_rows(rows, output_dir)


if __name__ == '__main__':
  try:
    main()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
