from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml

from ydb_utils import DEFAULT_PROFILE, ROOT_DIR, json_literal, run_yql_file, utf8_literal

sys.path.insert(0, str(ROOT_DIR))

from supabase.person_payload import migrate_person_schema, prune_person_schema


PEOPLE_DIR = ROOT_DIR / 'data' / 'people'
TEMP_SQL_PATH = ROOT_DIR / '.yandex-ydb-import.yql'
CHUNK_SIZE = 50


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description='Импортирует YAML-карточки в Yandex YDB.')
  parser.add_argument('--profile', default=DEFAULT_PROFILE, help='Профиль ydb CLI.')
  parser.add_argument('--ydb-bin', help='Путь к ydb CLI.')
  parser.add_argument('--people-dir', default=str(PEOPLE_DIR), help='Папка с YAML-карточками.')
  parser.add_argument('--chunk-size', type=int, default=CHUNK_SIZE, help='Размер пачки UPSERT.')
  return parser.parse_args()


def get_display_name(payload: dict[str, object], fallback_id: str) -> str:
  birth_name = payload.get('birth_name')
  if isinstance(birth_name, str) and birth_name.strip():
    return birth_name.strip()

  if isinstance(birth_name, dict):
    name = ' '.join(
      str(birth_name.get(key) or '').strip()
      for key in ['surname', 'first_name', 'patronymic']
      if str(birth_name.get(key) or '').strip()
    )
    if name:
      return name

  return fallback_id.strip() or '???'


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
      'display_name': get_display_name(normalized, person_id),
    })
  return rows


def chunked(rows: list[dict[str, object]], size: int) -> list[list[dict[str, object]]]:
  return [rows[index:index + size] for index in range(0, len(rows), size)]


def build_import_yql(rows: list[dict[str, object]]) -> str:
  statements: list[str] = []
  timestamp = datetime.now(UTC).isoformat().replace('+00:00', 'Z')
  for row in rows:
    person_id = str(row['id'])
    display_name = str(row['display_name'])
    statements.append(
      'UPSERT INTO family_yaml (id, payload, created_at, updated_at) VALUES '
      f'({utf8_literal(person_id)}, {json_literal(row["payload"])}, {utf8_literal(timestamp)}, {utf8_literal(timestamp)});'
    )
    statements.append(
      'UPSERT INTO family_people (id, display_name) VALUES '
      f'({utf8_literal(person_id)}, {utf8_literal(display_name)});'
    )
  return '\n'.join(statements) + '\n'


def main() -> None:
  args = parse_args()
  people_dir = Path(args.people_dir).resolve()
  if not people_dir.exists():
    raise RuntimeError(f'Папка не найдена: {people_dir}')

  rows = iter_person_records(people_dir)
  if not rows:
    raise RuntimeError('Не найдено ни одного YAML-файла для импорта.')

  chunks = chunked(rows, max(1, args.chunk_size))
  try:
    for index, chunk in enumerate(chunks, start=1):
      TEMP_SQL_PATH.write_text(build_import_yql(chunk), encoding='utf-8')
      run_yql_file(TEMP_SQL_PATH, profile=args.profile, ydb_bin=args.ydb_bin)
      print(f'[{index}/{len(chunks)}] Импортировано {len(chunk)} карточек.')
  finally:
    if TEMP_SQL_PATH.exists():
      TEMP_SQL_PATH.unlink()

  print(f'Готово: {len(rows)} карточек загружено в YDB.')


if __name__ == '__main__':
  try:
    main()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
