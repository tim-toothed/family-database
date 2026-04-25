from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from ydb_utils import DEFAULT_PROFILE, ROOT_DIR, json_literal, run_yql_file, sql_quote, utf8_literal


DOCS_MANIFEST_PATH = ROOT_DIR / 'data' / 'docs_processed' / 'index.json'
DOCS_ENTITIES_DIR = ROOT_DIR / 'data' / 'docs_processed' / 'entities'
TEMP_SQL_PATH = ROOT_DIR / '.yandex-ydb-documents-import.yql'
BLOCK_CHUNK_SIZE = 100
MENTION_CHUNK_SIZE = 200


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description='Импортирует обработанные документы в Yandex YDB.')
  parser.add_argument('--profile', default=DEFAULT_PROFILE, help='Профиль ydb CLI.')
  parser.add_argument('--ydb-bin', help='Путь к ydb CLI.')
  parser.add_argument('--document-id', help='Импортировать только один документ по id.')
  parser.add_argument('--block-chunk-size', type=int, default=BLOCK_CHUNK_SIZE, help='Размер пачки блоков.')
  parser.add_argument('--mention-chunk-size', type=int, default=MENTION_CHUNK_SIZE, help='Размер пачки упоминаний.')
  return parser.parse_args()


def load_documents_manifest() -> list[dict[str, object]]:
  payload = json.loads(DOCS_MANIFEST_PATH.read_text(encoding='utf-8'))
  documents = payload.get('documents')
  if not isinstance(documents, list):
    raise RuntimeError('data/docs_processed/index.json: missing documents array.')
  return documents


def load_entity_payload(document_id: str) -> dict[str, object]:
  path = DOCS_ENTITIES_DIR / f'{document_id}.json'
  if not path.exists():
    raise RuntimeError(f'Не найден entity JSON для {document_id}: {path}')
  payload = json.loads(path.read_text(encoding='utf-8'))
  if not isinstance(payload, dict):
    raise RuntimeError(f'{path}: JSON должен содержать объект.')
  return payload


def iso_or_empty(value: object) -> str:
  return str(value or '').strip()


def nullable_utf8(value: object) -> str:
  text = str(value or '').strip()
  return utf8_literal(text) if text else 'NULL'


def nullable_json(value: object) -> str:
  return json_literal(value) if isinstance(value, dict) else 'NULL'


def canonical_json_bytes(value: object) -> bytes:
  return json.dumps(
    value,
    ensure_ascii=False,
    sort_keys=True,
    separators=(',', ':'),
  ).encode('utf-8')


def build_content_hash(
  manifest_entry: dict[str, object],
  payload: dict[str, object],
  block_rows: list[dict[str, object]],
  mention_rows: list[dict[str, object]],
) -> str:
  hash_payload = {
    'document_id': str(payload['document_id']),
    'title': str(payload.get('title') or manifest_entry.get('title') or payload['document_id']),
    'description': str(manifest_entry.get('description') or '').strip() or None,
    'source_type': str(payload.get('source_type') or manifest_entry.get('type') or ''),
    'source_path': str(payload.get('source_path') or manifest_entry.get('path') or ''),
    'extractor': payload.get('extractor') if isinstance(payload.get('extractor'), dict) else None,
    'blocks': block_rows,
    'mentions': mention_rows,
  }
  return hashlib.sha256(canonical_json_bytes(hash_payload)).hexdigest()


def build_document_row(manifest_entry: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
  return {
    'id': str(payload['document_id']),
    'title': str(payload.get('title') or manifest_entry.get('title') or payload['document_id']),
    'description': str(manifest_entry.get('description') or '').strip() or None,
    'source_type': str(payload.get('source_type') or manifest_entry.get('type') or ''),
    'source_path': str(payload.get('source_path') or manifest_entry.get('path') or ''),
    'extractor': payload.get('extractor') if isinstance(payload.get('extractor'), dict) else None,
    'content_hash': None,
    'generated_at': iso_or_empty(payload.get('generated_at')),
    'block_count': int(payload.get('block_count') or 0),
    'mention_count': int(payload.get('mention_count') or 0),
  }


def build_block_rows(document_id: str, payload: dict[str, object]) -> list[dict[str, object]]:
  rows: list[dict[str, object]] = []
  blocks = payload.get('blocks')
  if not isinstance(blocks, list):
    return rows

  for block in blocks:
    if not isinstance(block, dict):
      continue
    mentions = block.get('mentions')
    rows.append({
      'document_id': document_id,
      'block_index': int(block.get('index') or 0),
      'kind': str(block.get('kind') or 'paragraph'),
      'text': str(block.get('text') or ''),
      'mention_count': len(mentions) if isinstance(mentions, list) else 0,
    })

  return rows


def build_mention_rows(document_id: str, payload: dict[str, object]) -> list[dict[str, object]]:
  rows: list[dict[str, object]] = []
  blocks = payload.get('blocks')
  if not isinstance(blocks, list):
    return rows

  for block in blocks:
    if not isinstance(block, dict):
      continue
    block_index = int(block.get('index') or 0)
    mentions = block.get('mentions')
    if not isinstance(mentions, list):
      continue

    for mention_index, mention in enumerate(mentions):
      if not isinstance(mention, dict):
        continue
      rows.append({
        'document_id': document_id,
        'block_index': block_index,
        'mention_index': mention_index,
        'kind': str(mention.get('kind') or ''),
        'text': str(mention.get('text') or ''),
        'start_offset': int(mention.get('start') or 0),
        'end_offset': int(mention.get('end') or 0),
        'source': str(mention.get('source') or ''),
      })

  return rows


def build_document_import_yql(
  document_row: dict[str, object],
) -> str:
  document_id = str(document_row['id'])
  timestamp = datetime.now(UTC).isoformat().replace('+00:00', 'Z')
  statements = [
    f'DELETE FROM text_document_mentions WHERE document_id = {utf8_literal(document_id)};',
    f'DELETE FROM text_document_blocks WHERE document_id = {utf8_literal(document_id)};',
    'UPSERT INTO text_documents ('
    'id, title, description, source_type, source_path, extractor, content_hash, generated_at, '
    'block_count, mention_count, created_at, updated_at'
    ') VALUES ('
    f'{utf8_literal(document_id)}, '
    f'{utf8_literal(document_row["title"])}, '
    f'{nullable_utf8(document_row.get("description"))}, '
    f'{utf8_literal(document_row["source_type"])}, '
    f'{utf8_literal(document_row["source_path"])}, '
    f'{nullable_json(document_row.get("extractor"))}, '
    f'{nullable_utf8(document_row.get("content_hash"))}, '
    f'{nullable_utf8(document_row.get("generated_at"))}, '
    f'{int(document_row["block_count"])}, '
    f'{int(document_row["mention_count"])}, '
    f'{utf8_literal(timestamp)}, '
    f'{utf8_literal(timestamp)}'
    ');',
  ]
  return '\n'.join(statements) + '\n'


def build_blocks_import_yql(block_rows: list[dict[str, object]]) -> str:
  statements: list[str] = []
  for row in block_rows:
    statements.append(
      'UPSERT INTO text_document_blocks (document_id, block_index, kind, text, mention_count) VALUES '
      f'({utf8_literal(row["document_id"])}, {int(row["block_index"])}, {utf8_literal(row["kind"])}, '
      f'{utf8_literal(row["text"])}, {int(row["mention_count"])});'
    )
  return '\n'.join(statements) + '\n'


def build_mentions_import_yql(mention_rows: list[dict[str, object]]) -> str:
  statements: list[str] = []
  for row in mention_rows:
    statements.append(
      'UPSERT INTO text_document_mentions ('
      'document_id, block_index, mention_index, kind, text, start_offset, end_offset, source'
      ') VALUES '
      f'({utf8_literal(row["document_id"])}, {int(row["block_index"])}, {int(row["mention_index"])}, '
      f'{utf8_literal(row["kind"])}, {utf8_literal(row["text"])}, {int(row["start_offset"])}, '
      f'{int(row["end_offset"])}, {utf8_literal(row["source"])});'
    )

  return '\n'.join(statements) + '\n'


def chunked(rows: list[dict[str, object]], size: int) -> list[list[dict[str, object]]]:
  return [rows[index:index + size] for index in range(0, len(rows), size)]


def run_temp_yql(script: str, *, profile: str, ydb_bin: str | None) -> None:
  TEMP_SQL_PATH.write_text(script, encoding='utf-8')
  run_yql_file(TEMP_SQL_PATH, profile=profile, ydb_bin=ydb_bin)


def main() -> None:
  args = parse_args()
  manifest_entries = load_documents_manifest()

  if args.document_id:
    manifest_entries = [
      entry for entry in manifest_entries
      if str(entry.get('id') or '').strip() == args.document_id
    ]
    if not manifest_entries:
      raise RuntimeError(f'Документ {args.document_id} не найден в data/docs_processed/index.json.')

  if not manifest_entries:
    raise RuntimeError('В data/docs_processed/index.json нет документов для импорта.')

  try:
    for position, manifest_entry in enumerate(manifest_entries, start=1):
      document_id = str(manifest_entry.get('id') or '').strip()
      if not document_id:
        continue

      payload = load_entity_payload(document_id)
      block_rows = build_block_rows(document_id, payload)
      mention_rows = build_mention_rows(document_id, payload)
      document_row = build_document_row(manifest_entry, payload)
      document_row['content_hash'] = build_content_hash(
        manifest_entry,
        payload,
        block_rows,
        mention_rows,
      )

      run_temp_yql(
        build_document_import_yql(document_row),
        profile=args.profile,
        ydb_bin=args.ydb_bin,
      )

      block_chunks = chunked(block_rows, max(1, args.block_chunk_size))
      for block_index, block_chunk in enumerate(block_chunks, start=1):
        run_temp_yql(
          build_blocks_import_yql(block_chunk),
          profile=args.profile,
          ydb_bin=args.ydb_bin,
        )
        print(
          f'[{position}/{len(manifest_entries)}] {document_id}: '
          f'blocks {block_index}/{len(block_chunks)} imported.',
        )

      mention_chunks = chunked(mention_rows, max(1, args.mention_chunk_size))
      for mention_index, mention_chunk in enumerate(mention_chunks, start=1):
        run_temp_yql(
          build_mentions_import_yql(mention_chunk),
          profile=args.profile,
          ydb_bin=args.ydb_bin,
        )
        print(
          f'[{position}/{len(manifest_entries)}] {document_id}: '
          f'mentions {mention_index}/{len(mention_chunks)} imported.',
        )

      print(
        f'[{position}/{len(manifest_entries)}] {document_id}: '
        f'{len(block_rows)} blocks, {len(mention_rows)} mentions imported.',
      )
  finally:
    if TEMP_SQL_PATH.exists():
      TEMP_SQL_PATH.unlink()

  print(f'Готово: импортировано {len(manifest_entries)} документов.')


if __name__ == '__main__':
  try:
    main()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
