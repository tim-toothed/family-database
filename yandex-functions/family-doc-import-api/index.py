from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
from datetime import UTC, datetime
from pathlib import PurePath
from typing import Any
from urllib.parse import urlparse

import ydb
import ydb.iam
from docx import Document
from pypdf import PdfReader


DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024
BLOCK_CHUNK_SIZE = 100
SUPPORTED_EXTENSIONS = {'txt', 'md', 'markdown', 'docx', 'pdf'}

_driver: ydb.Driver | None = None
_pool: ydb.QuerySessionPool | None = None
_pool_token: str | None = None
_context_token: str | None = None


def cors_headers() -> dict[str, str]:
  return {
    'Access-Control-Allow-Origin': os.environ.get('CORS_ORIGIN', '*'),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  }


def json_response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
  return {
    'statusCode': status_code,
    'headers': {
      **cors_headers(),
      'Content-Type': 'application/json; charset=utf-8',
    },
    'body': json.dumps(payload, ensure_ascii=False),
    'isBase64Encoded': False,
  }


def empty_response(status_code: int) -> dict[str, Any]:
  return {
    'statusCode': status_code,
    'headers': cors_headers(),
    'body': '',
    'isBase64Encoded': False,
  }


def get_header(event: dict[str, Any], name: str) -> str:
  normalized = name.lower()
  headers = event.get('headers') or {}
  for key, value in headers.items():
    if str(key).lower() == normalized:
      return str(value or '')
  return ''


def require_api_token(event: dict[str, Any]) -> None:
  expected = os.environ.get('FAMILY_DB_API_TOKEN')
  if not expected:
    return
  if get_header(event, 'authorization') != f'Bearer {expected}':
    raise HttpError(401, 'Unauthorized')


def normalize_path(event: dict[str, Any]) -> str:
  query = event.get('queryStringParameters') or {}
  route = query.get('route') or query.get('path')
  if route:
    path = str(route)
    path = path if path.startswith('/') else f'/{path}'
    return path.rstrip('/') or '/'

  raw_path = str(event.get('path') or (event.get('requestContext') or {}).get('path') or '/')
  path = raw_path if raw_path.startswith('/') else f'/{raw_path}'
  return path.rstrip('/') or '/'


def parse_body(event: dict[str, Any]) -> dict[str, Any]:
  body = event.get('body')
  if not body:
    raise HttpError(400, 'Request body is required.')

  raw = base64.b64decode(body).decode('utf-8') if event.get('isBase64Encoded') else str(body)
  try:
    parsed = json.loads(raw)
  except json.JSONDecodeError as exc:
    raise HttpError(400, 'Request body must be valid JSON.') from exc

  if not isinstance(parsed, dict):
    raise HttpError(400, 'Request body must be a JSON object.')
  return parsed


class HttpError(Exception):
  def __init__(self, status_code: int, message: str) -> None:
    super().__init__(message)
    self.status_code = status_code


def raw_string(value: Any) -> str:
  return '@@' + str(value).replace('@@', '@@@@') + '@@'


def utf8_literal(value: Any) -> str:
  return f'Utf8({raw_string(value)})'


def json_literal(value: Any) -> str:
  payload = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
  return f'Json({raw_string(payload)})'


def nullable_utf8(value: Any) -> str:
  text = str(value or '').strip()
  return utf8_literal(text) if text else 'NULL'


def parse_ydb_connection_string() -> tuple[str, str]:
  connection = os.environ.get('YDB_CONNECTION_STRING', '').strip()
  if not connection:
    raise RuntimeError('YDB_CONNECTION_STRING environment variable is required.')

  parsed = urlparse(connection)
  if not parsed.scheme or not parsed.netloc or not parsed.path:
    raise RuntimeError('YDB_CONNECTION_STRING must look like grpcs://host:2135/<database-path>.')

  endpoint = f'{parsed.scheme}://{parsed.netloc}'
  database = parsed.path
  return endpoint, database


def extract_context_access_token(context: Any) -> str:
  token = getattr(context, 'token', None)
  if isinstance(token, dict):
    return str(token.get('access_token') or '').strip()
  return str(getattr(token, 'access_token', '') or '').strip()


def get_ydb_pool() -> ydb.QuerySessionPool:
  global _driver, _pool, _pool_token
  access_token = os.environ.get('YDB_ACCESS_TOKEN', '').strip() or (_context_token or '')

  if _pool and _pool_token == access_token:
    return _pool

  endpoint, database = parse_ydb_connection_string()
  credentials = ydb.AccessTokenCredentials(access_token) if access_token else ydb.iam.MetadataUrlCredentials()
  _driver = ydb.Driver(endpoint=endpoint, database=database, credentials=credentials)
  _driver.wait(fail_fast=True, timeout=10)
  _pool = ydb.QuerySessionPool(_driver)
  _pool_token = access_token
  return _pool


def execute_yql(script: str) -> None:
  get_ydb_pool().execute_with_retries(script)


def now_iso() -> str:
  return datetime.now(UTC).isoformat().replace('+00:00', 'Z')


def normalize_newlines(text: str) -> str:
  return text.replace('\r\n', '\n').replace('\r', '\n')


def collapse_blank_lines(text: str) -> str:
  return re.sub(r'\n{3,}', '\n\n', normalize_newlines(text)).strip()


def text_blocks_from_plain_text(text: str) -> list[dict[str, Any]]:
  blocks: list[dict[str, Any]] = []
  for part in re.split(r'\n\s*\n', collapse_blank_lines(text)):
    value = re.sub(r'[ \t]+\n', '\n', part).strip()
    if value:
      blocks.append({'kind': 'paragraph', 'text': value})
  return blocks


def text_blocks_from_markdown(text: str) -> list[dict[str, Any]]:
  blocks: list[dict[str, Any]] = []
  paragraph_lines: list[str] = []

  def flush_paragraph() -> None:
    if not paragraph_lines:
      return
    value = ' '.join(line.strip() for line in paragraph_lines).strip()
    paragraph_lines.clear()
    if value:
      blocks.append({'kind': 'paragraph', 'text': value})

  for raw_line in normalize_newlines(text).split('\n'):
    line = raw_line.strip()
    if not line:
      flush_paragraph()
      continue

    heading_match = re.match(r'^(#{1,6})\s+(.+?)\s*#*$', line)
    if heading_match:
      flush_paragraph()
      blocks.append({'kind': 'heading', 'text': heading_match.group(2).strip()})
      continue

    list_match = re.match(r'^([-*+]|\d+[.)])\s+(.+)$', line)
    if list_match:
      flush_paragraph()
      blocks.append({'kind': 'list_item', 'text': list_match.group(2).strip()})
      continue

    paragraph_lines.append(line)

  flush_paragraph()
  return blocks


def text_blocks_from_docx(content: bytes) -> list[dict[str, Any]]:
  document = Document(io.BytesIO(content))
  blocks: list[dict[str, Any]] = []
  for paragraph in document.paragraphs:
    text = re.sub(r'\s+', ' ', paragraph.text).strip()
    if not text:
      continue

    style_name = str(paragraph.style.name if paragraph.style else '').lower()
    if style_name.startswith('heading') or style_name.startswith('заголовок'):
      kind = 'heading'
    elif style_name.startswith('list') or 'спис' in style_name:
      kind = 'list_item'
    else:
      kind = 'paragraph'
    blocks.append({'kind': kind, 'text': text})
  return blocks


def pdf_text_fragmentation_score(text: str) -> float:
  lines = [line.strip() for line in normalize_newlines(text).split('\n') if line.strip()]
  if not lines:
    return 1_000_000

  short_lines = sum(1 for line in lines if len(line) < 18)
  one_word_lines = sum(1 for line in lines if len(line.split()) <= 1)
  average_length = sum(len(line) for line in lines) / len(lines)
  return (short_lines / len(lines)) + (one_word_lines / len(lines)) - (average_length / 200)


def extract_pdf_page_text(page: Any) -> str:
  candidates: list[str] = []
  plain_text = page.extract_text() or ''
  if plain_text.strip():
    candidates.append(plain_text)

  try:
    layout_text = page.extract_text(extraction_mode='layout') or ''
    if layout_text.strip():
      candidates.append(layout_text)
  except TypeError:
    pass

  if not candidates:
    return ''
  return min(candidates, key=pdf_text_fragmentation_score)


def is_pdf_heading_candidate(line: str, next_line: str | None) -> bool:
  if not next_line:
    return False
  if len(line) > 80 or len(line.split()) > 7:
    return False
  if re.search(r'[.!?…:;,]["»)\]]*$', line):
    return False
  if len(next_line) < 25:
    return False
  return bool(re.match(r'^[A-ZА-ЯЁ0-9]', line))


def should_start_pdf_paragraph(current_text: str, next_line: str) -> bool:
  if len(current_text) < 260:
    return False
  if not re.search(r'[.!?…]["»)\]]*$', current_text):
    return False
  return bool(re.match(r'^[A-ZА-ЯЁ0-9]', next_line))


def join_pdf_paragraph_lines(lines: list[str]) -> str:
  text = ''
  for line in lines:
    if not text:
      text = line
    elif text.endswith('-'):
      text = text[:-1] + line
    else:
      text = f'{text} {line}'
  return re.sub(r'\s+', ' ', text).strip()


def text_blocks_from_pdf_text(text: str) -> list[dict[str, Any]]:
  lines = [
    re.sub(r'\s+', ' ', line).strip()
    for line in normalize_newlines(text).split('\n')
  ]
  non_empty_lines = [line for line in lines if line]
  blocks: list[dict[str, Any]] = []
  paragraph_lines: list[str] = []

  def flush_paragraph() -> None:
    if not paragraph_lines:
      return
    value = join_pdf_paragraph_lines(paragraph_lines)
    paragraph_lines.clear()
    if value:
      blocks.append({'kind': 'paragraph', 'text': value})

  for index, line in enumerate(non_empty_lines):
    next_line = non_empty_lines[index + 1] if index + 1 < len(non_empty_lines) else None

    if is_pdf_heading_candidate(line, next_line):
      flush_paragraph()
      blocks.append({'kind': 'heading', 'text': line})
      continue

    current_text = join_pdf_paragraph_lines(paragraph_lines)
    if current_text and should_start_pdf_paragraph(current_text, line):
      flush_paragraph()

    paragraph_lines.append(line)

  flush_paragraph()
  return blocks


def text_blocks_from_pdf(content: bytes) -> list[dict[str, Any]]:
  reader = PdfReader(io.BytesIO(content))
  page_texts = [extract_pdf_page_text(page) for page in reader.pages]
  return text_blocks_from_pdf_text('\n\n'.join(page_texts))



def decode_text_content(content: bytes) -> str:
  for encoding in ('utf-8-sig', 'utf-8', 'cp1251'):
    try:
      return content.decode(encoding)
    except UnicodeDecodeError:
      continue
  return content.decode('utf-8', errors='replace')


def build_blocks(extension: str, content: bytes) -> list[dict[str, Any]]:
  if extension in {'md', 'markdown'}:
    return text_blocks_from_markdown(decode_text_content(content))
  if extension == 'txt':
    return text_blocks_from_plain_text(decode_text_content(content))
  if extension == 'docx':
    return text_blocks_from_docx(content)
  if extension == 'pdf':
    return text_blocks_from_pdf(content)
  raise HttpError(400, f'Unsupported document extension: {extension}.')


def slugify(value: str) -> str:
  text = value.lower()
  text = re.sub(r'[^a-z0-9а-яё]+', '-', text, flags=re.IGNORECASE)
  text = re.sub(r'-{2,}', '-', text).strip('-')
  return text or 'document'


def normalize_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
  normalized: list[dict[str, Any]] = []
  for index, block in enumerate(blocks):
    text = str(block.get('text') or '').strip()
    if not text:
      continue
    kind = str(block.get('kind') or 'paragraph')
    if kind not in {'heading', 'paragraph', 'list_item'}:
      kind = 'paragraph'
    normalized.append({
      'document_id': '',
      'block_index': len(normalized),
      'kind': kind,
      'text': text,
      'mention_count': 0,
    })
  return normalized


def build_content_hash(document: dict[str, Any], blocks: list[dict[str, Any]]) -> str:
  payload = {
    'document': document,
    'blocks': [
      {
        'block_index': block['block_index'],
        'kind': block['kind'],
        'text': block['text'],
      }
      for block in blocks
    ],
  }
  encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
  return hashlib.sha256(encoded).hexdigest()


def chunked(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
  return [items[index:index + size] for index in range(0, len(items), size)]


def build_document_yql(document: dict[str, Any]) -> str:
  document_id = document['id']
  return '\n'.join([
    f'DELETE FROM text_document_mentions WHERE document_id = {utf8_literal(document_id)};',
    f'DELETE FROM text_document_blocks WHERE document_id = {utf8_literal(document_id)};',
    'UPSERT INTO text_documents ('
    'id, title, description, source_type, source_path, extractor, content_hash, generated_at, '
    'block_count, mention_count, created_at, updated_at'
    ') VALUES ('
    f'{utf8_literal(document_id)}, '
    f'{utf8_literal(document["title"])}, '
    f'{nullable_utf8(document.get("description"))}, '
    f'{utf8_literal(document["source_type"])}, '
    f'{utf8_literal(document["source_path"])}, '
    f'{json_literal(document["extractor"])}, '
    f'{utf8_literal(document["content_hash"])}, '
    f'{utf8_literal(document["generated_at"])}, '
    f'{int(document["block_count"])}, '
    f'{int(document["mention_count"])}, '
    f'{utf8_literal(document["created_at"])}, '
    f'{utf8_literal(document["updated_at"])}'
    ');',
  ]) + '\n'


def build_blocks_yql(blocks: list[dict[str, Any]]) -> str:
  statements: list[str] = []
  for block in blocks:
    statements.append(
      'UPSERT INTO text_document_blocks (document_id, block_index, kind, text, mention_count) VALUES '
      f'({utf8_literal(block["document_id"])}, {int(block["block_index"])}, {utf8_literal(block["kind"])}, '
      f'{utf8_literal(block["text"])}, {int(block["mention_count"])});'
    )
  return '\n'.join(statements) + '\n'


def import_document(payload: dict[str, Any]) -> dict[str, Any]:
  filename = PurePath(str(payload.get('filename') or '')).name.strip()
  if not filename:
    raise HttpError(400, 'filename is required.')

  extension = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
  if extension not in SUPPORTED_EXTENSIONS:
    raise HttpError(400, 'Поддерживаются только документы .md, .markdown, .docx, .pdf и .txt.')

  encoded_content = str(payload.get('contentBase64') or '')
  if not encoded_content:
    raise HttpError(400, 'contentBase64 is required.')

  try:
    content = base64.b64decode(encoded_content, validate=True)
  except ValueError as exc:
    raise HttpError(400, 'contentBase64 must be valid base64.') from exc

  max_upload_bytes = int(os.environ.get('MAX_UPLOAD_BYTES') or DEFAULT_MAX_UPLOAD_BYTES)
  if len(content) > max_upload_bytes:
    raise HttpError(413, f'Файл слишком большой. Максимум: {max_upload_bytes} bytes.')

  raw_blocks = build_blocks(extension, content)
  blocks = normalize_blocks(raw_blocks)
  if not blocks:
    raise HttpError(400, 'Не удалось извлечь текстовые блоки из документа.')

  title = str(payload.get('title') or filename.rsplit('.', 1)[0] or filename).strip()
  document_id = str(payload.get('documentId') or '').strip()
  if not document_id:
    source_hash = hashlib.sha256(content).hexdigest()[:8]
    document_id = f'{slugify(title)}-{source_hash}'

  for block in blocks:
    block['document_id'] = document_id

  timestamp = now_iso()
  source_type = 'markdown' if extension in {'md', 'markdown'} else extension
  document = {
    'id': document_id,
    'title': title,
    'description': str(payload.get('description') or '').strip() or None,
    'source_type': source_type,
    'source_path': filename,
    'extractor': {
      'name': 'family-doc-import-api',
      'version': 1,
      'source_extension': extension,
    },
    'content_hash': '',
    'generated_at': timestamp,
    'block_count': len(blocks),
    'mention_count': 0,
    'created_at': timestamp,
    'updated_at': timestamp,
  }
  document['content_hash'] = build_content_hash(document, blocks)

  execute_yql(build_document_yql(document))
  for block_chunk in chunked(blocks, BLOCK_CHUNK_SIZE):
    execute_yql(build_blocks_yql(block_chunk))

  return {
    'document': {
      'id': document['id'],
      'title': document['title'],
      'description': document['description'],
      'source_type': document['source_type'],
      'source_path': document['source_path'],
      'extractor': document['extractor'],
      'content_hash': document['content_hash'],
      'generated_at': document['generated_at'],
      'block_count': document['block_count'],
      'mention_count': document['mention_count'],
    },
  }


def route(event: dict[str, Any]) -> dict[str, Any]:
  method = str(event.get('httpMethod') or 'GET').upper()
  if method == 'OPTIONS':
    return empty_response(204)

  require_api_token(event)
  path = normalize_path(event)

  if method == 'GET' and path == '/health':
    return json_response(200, {'ok': True})

  if method == 'POST' and path == '/documents/import':
    return json_response(201, import_document(parse_body(event)))

  return json_response(404, {'error': 'Not found'})


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
  global _context_token
  _context_token = extract_context_access_token(context)
  try:
    return route(event or {})
  except HttpError as exc:
    return json_response(exc.status_code, {'error': str(exc)})
  except Exception as exc:  # noqa: BLE001
    print(repr(exc))
    return json_response(500, {'error': 'Internal server error'})
