from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from http.client import RemoteDisconnected
from pathlib import Path
from urllib import error, parse, request


ROOT_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT_DIR / '.env'
DOCS_MANIFEST_PATH = ROOT_DIR / 'data' / 'docs_processed' / 'index.json'
DOCS_ENTITIES_DIR = ROOT_DIR / 'data' / 'docs_processed' / 'entities'
SCHEMA_NAME = 'family_site'
IMPORT_RPC_NAME = 'import_text_document'
HTTP_TIMEOUT_SECONDS = 60
MAX_REQUEST_RETRIES = 3
RETRY_DELAY_SECONDS = 1.5


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


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description='Import processed text documents and mentions into Supabase.',
  )
  parser.add_argument('--document-id', help='Import only one document by id.')
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
  return json.loads(path.read_text(encoding='utf-8'))


def iso_or_none(value: object) -> str | None:
  text = str(value or '').strip()
  return text or None


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


def log_progress(message: str) -> None:
  print(message, flush=True)


def transient_error_details(exc: Exception) -> str | None:
  if isinstance(exc, error.URLError):
    return str(exc.reason)
  if isinstance(exc, TimeoutError | RemoteDisconnected | ConnectionResetError):
    return str(exc) or exc.__class__.__name__
  return None


def supabase_request(
  base_url: str,
  service_key: str,
  method: str,
  path: str,
  *,
  query: dict[str, str] | None = None,
  body: object | None = None,
  prefer: str | None = None,
  profile: str | None = None,
  return_json: bool = False,
) -> object | None:
  query_string = f"?{parse.urlencode(query)}" if query else ''
  url = f'{base_url}/rest/v1/{path}{query_string}'
  headers = {
    'apikey': service_key,
    'Authorization': f'Bearer {service_key}',
    'Connection': 'close',
  }
  if method in {'POST', 'PATCH', 'DELETE'}:
    headers['Content-Type'] = 'application/json'
    headers['Content-Profile'] = profile or SCHEMA_NAME
  if method == 'GET':
    headers['Accept-Profile'] = profile or SCHEMA_NAME
  if prefer:
    headers['Prefer'] = prefer

  payload = None
  if body is not None:
    payload = json.dumps(body, ensure_ascii=False).encode('utf-8')

  req = request.Request(url, data=payload, method=method, headers=headers)

  for attempt in range(1, MAX_REQUEST_RETRIES + 1):
    try:
      with request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as response:
        if not return_json:
          return None
        return json.loads(response.read().decode('utf-8'))
    except error.HTTPError as exc:
      details = exc.read().decode('utf-8', errors='replace')
      raise RuntimeError(f'HTTP {exc.code} {method} {url}\n{details}') from exc
    except (error.URLError, TimeoutError, RemoteDisconnected, ConnectionResetError) as exc:
      details = transient_error_details(exc)
      if attempt >= MAX_REQUEST_RETRIES:
        raise RuntimeError(
          f'Ошибка сети при запросе {method} {url}: {details}',
        ) from exc
      log_progress(
        f'Повтор запроса {attempt}/{MAX_REQUEST_RETRIES - 1} '
        f'для {method} {path}: {details}',
      )
      time.sleep(RETRY_DELAY_SECONDS * attempt)

  return None


def import_document_payload(
  base_url: str,
  service_key: str,
  document_id: str,
  document_row: dict[str, object],
  block_rows: list[dict[str, object]],
  mention_rows: list[dict[str, object]],
) -> dict[str, object]:
  result = supabase_request(
    base_url,
    service_key,
    'POST',
    f'rpc/{IMPORT_RPC_NAME}',
    body={
      'p_document': document_row,
      'p_blocks': block_rows,
      'p_mentions': mention_rows,
    },
    profile=SCHEMA_NAME,
    return_json=True,
  )
  if not isinstance(result, dict):
    raise RuntimeError(
      f'RPC {IMPORT_RPC_NAME} вернул неожиданный ответ для {document_id}.',
    )
  return result


def build_document_row(manifest_entry: dict[str, object], payload: dict[str, object]) -> dict[str, object]:
  return {
    'id': str(payload['document_id']),
    'title': str(payload.get('title') or manifest_entry.get('title') or payload['document_id']),
    'description': str(manifest_entry.get('description') or '').strip() or None,
    'source_type': str(payload.get('source_type') or manifest_entry.get('type') or ''),
    'source_path': str(payload.get('source_path') or manifest_entry.get('path') or ''),
    'extractor': payload.get('extractor') if isinstance(payload.get('extractor'), dict) else None,
    'content_hash': None,
    'generated_at': iso_or_none(payload.get('generated_at')),
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


def import_documents() -> None:
  args = parse_args()
  base_url, service_key = get_required_config()
  manifest_entries = load_documents_manifest()

  if args.document_id:
    manifest_entries = [
      entry for entry in manifest_entries
      if str(entry.get('id') or '').strip() == args.document_id
    ]
    if not manifest_entries:
      raise RuntimeError(f'Документ {args.document_id} не найден в data/docs_processed/index.json.')

  total = len(manifest_entries)
  if not total:
    raise RuntimeError('В data/docs_processed/index.json нет документов для импорта.')

  for position, manifest_entry in enumerate(manifest_entries, start=1):
    document_id = str(manifest_entry.get('id') or '').strip()
    if not document_id:
      continue

    log_progress(f'[{position}/{total}] {document_id}: loading entity payload')
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

    log_progress(
      f'[{position}/{total}] {document_id}: rpc import '
      f'({len(block_rows)} blocks, {len(mention_rows)} mentions)',
    )
    result = import_document_payload(
      base_url,
      service_key,
      document_id,
      document_row,
      block_rows,
      mention_rows,
    )

    imported_blocks = int(result.get('block_count') or len(block_rows))
    imported_mentions = int(result.get('mention_count') or len(mention_rows))
    if bool(result.get('skipped')):
      log_progress(
        f'[{position}/{total}] {document_id}: unchanged, skipped '
        f'({imported_blocks} blocks, {imported_mentions} mentions).',
      )
      continue
    log_progress(
      f'[{position}/{total}] {document_id}: '
      f'{imported_blocks} blocks, {imported_mentions} mentions imported.',
    )

  log_progress(f'Готово: импортировано {total} документов.')


if __name__ == '__main__':
  try:
    import_documents()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
