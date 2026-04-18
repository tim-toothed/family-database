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


PEOPLE_DIR = ROOT_DIR / 'data' / 'people'
SCHEMA_PATH = Path(__file__).resolve().with_name('schema.sql')


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description='Импортирует YAML-карточки в Cloudflare D1.')
  parser.add_argument('--database', help='Имя D1-базы. По умолчанию: family-tree-db или значение из .env.')
  parser.add_argument('--people-dir', default=str(PEOPLE_DIR), help='Папка с YAML-карточками.')
  parser.add_argument('--skip-schema', action='store_true', help='Не применять schema.sql перед импортом.')
  parser.add_argument('--local', action='store_true', help='Импортировать в локальную D1 вместо remote.')
  return parser.parse_args()


def iter_person_records(people_dir: Path) -> list[dict[str, object]]:
  rows: list[dict[str, object]] = []
  for path in sorted(people_dir.glob('P*.yaml')):
    person_id = path.stem
    payload = yaml.safe_load(path.read_text(encoding='utf-8')) or {}
    if not isinstance(payload, dict):
      raise RuntimeError(f'{path.name}: YAML должен содержать объект.')

    normalized = prune_person_schema(migrate_person_schema(payload, person_id)) or {'id': person_id}
    rows.append({
      'id': person_id,
      'payload': normalized,
    })

  return rows


def sql_quote(value: str) -> str:
  return "'" + value.replace("'", "''") + "'"


def build_import_sql(rows: list[dict[str, object]]) -> str:
  statements = ['PRAGMA foreign_keys = ON;']
  for row in rows:
    person_id = str(row['id'])
    payload_json = json.dumps(row['payload'], ensure_ascii=False, separators=(',', ':'))
    statements.append(
      'INSERT INTO family_yaml (id, payload) '
      f'VALUES ({sql_quote(person_id)}, {sql_quote(payload_json)}) '
      "ON CONFLICT(id) DO UPDATE SET "
      'payload = excluded.payload, '
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');"
    )
  return '\n'.join(statements) + '\n'


def apply_schema(database_name: str, *, remote: bool) -> None:
  run_wrangler_d1([
    'execute',
    database_name,
    *build_location_args(remote=remote),
    f'--file={SCHEMA_PATH}',
    '--yes',
  ], expect_json=True)


def import_people(database_name: str, rows: list[dict[str, object]], *, remote: bool) -> None:
  temp_sql_path = ROOT_DIR / '.cloudflare-d1-import.sql'
  try:
    temp_sql_path.write_text(build_import_sql(rows), encoding='utf-8')
    run_wrangler_d1([
      'execute',
      database_name,
      *build_location_args(remote=remote),
      f'--file={temp_sql_path}',
      '--yes',
    ], expect_json=True)
  finally:
    if temp_sql_path.exists():
      temp_sql_path.unlink()


def main() -> None:
  args = parse_args()
  people_dir = Path(args.people_dir).resolve()
  if not people_dir.exists():
    raise RuntimeError(f'Папка не найдена: {people_dir}')

  rows = iter_person_records(people_dir)
  if not rows:
    raise RuntimeError('Не найдено ни одного YAML-файла для импорта.')

  database_name = get_database_name(args.database)
  remote = not args.local

  if not args.skip_schema:
    apply_schema(database_name, remote=remote)

  import_people(database_name, rows, remote=remote)
  print(f'Готово: {len(rows)} карточек загружено в D1-базу {database_name}.')


if __name__ == '__main__':
  try:
    main()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
