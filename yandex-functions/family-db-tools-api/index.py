from __future__ import annotations

import base64
import inspect
import json
import os
import re
import warnings
from collections import namedtuple
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any
from urllib.parse import unquote, urlparse

import ydb
import ydb.iam

if not hasattr(inspect, 'getargspec'):
  ArgSpec = namedtuple('ArgSpec', 'args varargs keywords defaults')

  def getargspec(func):
    spec = inspect.getfullargspec(func)
    return ArgSpec(spec.args, spec.varargs, spec.varkw, spec.defaults)

  inspect.getargspec = getargspec

warnings.filterwarnings(
  'ignore',
  message='pkg_resources is deprecated as an API.*',
  category=UserWarning,
)

import pymorphy2
import pymorphy2_dicts_ru
from natasha import MorphVocab, NamesExtractor


MAX_PAGE_SIZE = 5000
MENTION_CHUNK_SIZE = 150
BLOCK_UPDATE_CHUNK_SIZE = 200
TOKEN_RE = re.compile(r'[A-Za-zА-ЯЁа-яё]+(?:-[A-Za-zА-ЯЁа-яё]+)*|[()\[\]]|[^\s]')
WORD_RE = re.compile(r'^[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*$')
CAPITALIZED_WORD_RE = re.compile(r'^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)*$')
UPPERCASE_WORD_RE = re.compile(r'^[А-ЯЁ]{3,}(?:-[А-ЯЁ]{3,})*$')
INITIAL_SURNAME_RE = re.compile(r'(?<![А-ЯЁа-яё])(?:[А-ЯЁ]\.){1,3}\s*[А-ЯЁ][А-ЯЁа-яё-]{2,}')
PATRONYMIC_TOKEN_RE = re.compile(r'(?:вич|вна|ична|оглы|кызы)$', re.IGNORECASE)

KINSHIP_PATTERNS = (
  re.compile(r'^(?:пра)+дед(?:ушка)?$'),
  re.compile(r'^(?:пра)+баб(?:ка|ушка)$'),
  re.compile(r'^(?:пра)+внук$'),
  re.compile(r'^(?:пра)+внучка$'),
)
KINSHIP_LEMMAS = {
  'бабка', 'бабушка', 'брат', 'внук', 'внучка', 'дед', 'дедушка',
  'дочь', 'дочка', 'дядя', 'жена', 'зять', 'мама', 'мать', 'мачеха',
  'муж', 'невестка', 'отец', 'отчим', 'папа', 'племянник', 'племянница',
  'потомок', 'предок', 'прародитель', 'родитель', 'родня', 'родственник',
  'родственница', 'сват', 'свекровь', 'свёкор', 'сестра', 'сноха',
  'супруг', 'супруга', 'сын', 'тесть', 'тетя', 'тётя', 'теща', 'тёща',
}
KINSHIP_MODIFIER_LEMMAS = {
  'двоюродный', 'единоутробный', 'единокровный', 'младший', 'приемный',
  'приёмный', 'родной', 'сводный', 'старший', 'троюродный',
}
NON_PERSON_COMPONENT_LEMMAS = {
  'август', 'дети', 'дочь', 'герой', 'из', 'заметка', 'имя', 'мать',
  'область', 'отец', 'район', 'ребёнок', 'сын', 'тетя', 'тётя',
  'февраль', 'январь',
}
MONTH_LEMMAS = {
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль',
  'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
}
HONORIFIC_OR_AWARD_LEMMAS = {
  'герой', 'кавалер', 'лауреат', 'орден', 'медаль', 'награда',
  'степень', 'союз', 'труд', 'революция', 'звезда',
}
GEO_CONTEXT_LEMMAS = {
  'автономия', 'область', 'город', 'губерния', 'деревня', 'край',
  'обл', 'поселок', 'посёлок', 'район', 'регион', 'республика',
  'село', 'станица', 'станция', 'улус',
}
BLOCKED_NAME_POS = {
  'ADJF', 'ADJS', 'ADVB', 'COMP', 'CONJ', 'GRND', 'INFN', 'INTJ',
  'NUMR', 'PRCL', 'PRED', 'PREP', 'PRTF', 'PRTS', 'VERB',
}

_driver: ydb.Driver | None = None
_pool: ydb.QuerySessionPool | None = None
_pool_token: str | None = None
_context_token: str | None = None
_resources: tuple[Any, Any] | None = None


@dataclass(slots=True)
class TextBlock:
  index: int
  kind: str
  text: str


@dataclass(slots=True)
class TokenSpan:
  text: str
  start: int
  end: int


@dataclass(slots=True)
class Mention:
  kind: str
  text: str
  start: int
  end: int
  source: str


@dataclass(slots=True)
class NameMatch:
  start: int
  end: int
  components: dict[str, list[str]]


class HttpError(Exception):
  def __init__(self, status_code: int, message: str) -> None:
    super().__init__(message)
    self.status_code = status_code


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
  for key, value in (event.get('headers') or {}).items():
    if str(key).lower() == normalized:
      return str(value or '')
  return ''


def require_api_token(event: dict[str, Any]) -> None:
  expected = os.environ.get('FAMILY_DB_API_TOKEN')
  if expected and get_header(event, 'authorization') != f'Bearer {expected}':
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
    return {}
  raw = base64.b64decode(body).decode('utf-8') if event.get('isBase64Encoded') else str(body)
  try:
    parsed = json.loads(raw)
  except json.JSONDecodeError as exc:
    raise HttpError(400, 'Request body must be valid JSON.') from exc
  if not isinstance(parsed, dict):
    raise HttpError(400, 'Request body must be a JSON object.')
  return parsed


def raw_string(value: Any) -> str:
  return '@@' + str(value).replace('@@', '@@@@') + '@@'


def utf8_literal(value: Any) -> str:
  return f'Utf8({raw_string(value)})'


def json_literal(value: Any) -> str:
  return f'Json({raw_string(json.dumps(value, ensure_ascii=False, separators=(",", ":")))})'


def parse_ydb_connection_string() -> tuple[str, str]:
  connection = os.environ.get('YDB_CONNECTION_STRING', '').strip()
  if not connection:
    raise RuntimeError('YDB_CONNECTION_STRING environment variable is required.')
  parsed = urlparse(connection)
  if not parsed.scheme or not parsed.netloc or not parsed.path or parsed.path == '/':
    raise RuntimeError('YDB_CONNECTION_STRING must look like grpcs://host:2135/<database-path>.')
  return f'{parsed.scheme}://{parsed.netloc}', parsed.path


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


def execute_yql(script: str):
  return get_ydb_pool().execute_with_retries(script)


def unwrap_rows(result: Any) -> list[dict[str, Any]]:
  if result is None:
    return []
  if isinstance(result, list):
    if not result:
      return []
    if isinstance(result[0], list):
      return list(result[0])
    if hasattr(result[0], 'rows'):
      return list(result[0].rows)
    return list(result)
  if hasattr(result, 'rows'):
    return list(result.rows)
  return []


def normalize_whitespace(value: str) -> str:
  return re.sub(r'\s+', ' ', value).strip()


def tokenize_text(text: str) -> list[TokenSpan]:
  return [TokenSpan(text=match.group(0), start=match.start(), end=match.end()) for match in TOKEN_RE.finditer(text)]


@lru_cache(maxsize=50000)
def parse_word(word: str, morph):
  return tuple(morph.parse(word))


def token_normal_forms(token_text: str, morph) -> set[str]:
  return {parse.normal_form for parse in parse_word(token_text, morph)}


def token_grammemes(token_text: str, morph) -> set[str]:
  grammemes: set[str] = set()
  for parse in parse_word(token_text, morph):
    grammemes.update(parse.tag.grammemes)
  return grammemes


def token_top_pos(token_text: str, morph) -> str | None:
  parses = parse_word(token_text, morph)
  return parses[0].tag.POS if parses else None


def token_is_month(token: TokenSpan, morph) -> bool:
  return is_word_token(token) and bool(token_normal_forms(token.text, morph) & MONTH_LEMMAS)


def token_is_honorific_or_award(token: TokenSpan, morph) -> bool:
  return is_word_token(token) and bool(token_normal_forms(token.text, morph) & HONORIFIC_OR_AWARD_LEMMAS)


def is_word_token(token: TokenSpan) -> bool:
  return bool(WORD_RE.fullmatch(token.text))


def is_capitalized_word(token: TokenSpan) -> bool:
  return bool(CAPITALIZED_WORD_RE.fullmatch(token.text))


def is_uppercase_word(token: TokenSpan) -> bool:
  return bool(UPPERCASE_WORD_RE.fullmatch(token.text))


def is_kinship_lemma(lemma: str) -> bool:
  return lemma in KINSHIP_LEMMAS or any(pattern.fullmatch(lemma) for pattern in KINSHIP_PATTERNS)


def token_has_name_signal(token: TokenSpan, morph) -> bool:
  return is_word_token(token) and 'Name' in token_grammemes(token.text, morph)


def token_has_surname_signal(token: TokenSpan, morph) -> bool:
  return is_word_token(token) and 'Surn' in token_grammemes(token.text, morph)


def token_has_patronymic_signal(token: TokenSpan, morph) -> bool:
  return is_word_token(token) and (
    'Patr' in token_grammemes(token.text, morph) or PATRONYMIC_TOKEN_RE.search(token.text) is not None
  )


def token_has_geographical_signal(token: TokenSpan, morph) -> bool:
  return is_word_token(token) and 'Geox' in token_grammemes(token.text, morph)


def token_is_kinship(token: TokenSpan, morph) -> bool:
  return is_word_token(token) and any(is_kinship_lemma(lemma) for lemma in token_normal_forms(token.text, morph))


def token_is_name_component(token: TokenSpan, morph) -> bool:
  return token_has_name_signal(token, morph) or token_has_surname_signal(token, morph) or token_has_patronymic_signal(token, morph)


def token_can_be_name_word(token: TokenSpan, morph) -> bool:
  if not is_word_token(token):
    return False
  if token_is_month(token, morph) or token_is_kinship(token, morph) or token_is_honorific_or_award(token, morph):
    return False
  if token_has_geographical_signal(token, morph):
    return False
  pos = token_top_pos(token.text, morph)
  if pos in BLOCKED_NAME_POS and not token_is_name_component(token, morph):
    return False
  return token_is_name_component(token, morph) or is_capitalized_word(token) or is_uppercase_word(token)


def token_can_be_sequence_name_word(token: TokenSpan, morph) -> bool:
  return token_can_be_name_word(token, morph) and (is_capitalized_word(token) or is_uppercase_word(token))


def trim_geo_suffix_from_sequence(word_tokens: list[TokenSpan], tokens: list[TokenSpan], morph) -> list[TokenSpan]:
  result = list(word_tokens)
  while len(result) > 1:
    last_index = tokens.index(result[-1])
    next_index = find_next_word_index(tokens, last_index)
    next_token = tokens[next_index] if next_index is not None else None
    if not next_token or not (token_normal_forms(next_token.text, morph) & GEO_CONTEXT_LEMMAS):
      break
    result.pop()
  return result


def trim_name_edges(word_tokens: list[TokenSpan], morph) -> list[TokenSpan]:
  result = list(word_tokens)
  while result and (token_is_kinship(result[0], morph) or not token_is_name_component(result[0], morph)):
    result.pop(0)
  while result and (token_is_kinship(result[-1], morph) or not token_is_name_component(result[-1], morph)):
    result.pop()
  return result


def trim_sequence_edges(word_tokens: list[TokenSpan], morph) -> list[TokenSpan]:
  result = list(word_tokens)
  while result and (
    token_is_kinship(result[0], morph)
    or token_is_month(result[0], morph)
    or token_is_honorific_or_award(result[0], morph)
  ):
    result.pop(0)
  while result and (
    token_is_kinship(result[-1], morph)
    or token_is_month(result[-1], morph)
    or token_is_honorific_or_award(result[-1], morph)
  ):
    result.pop()
  return result


def classify_name_tokens(word_tokens: list[TokenSpan], morph) -> dict[str, list[str]]:
  components = {'first': [], 'last': [], 'middle': []}
  for token in word_tokens:
    if token_has_name_signal(token, morph):
      components['first'].append(token.text)
    elif token_has_patronymic_signal(token, morph):
      components['middle'].append(token.text)
    elif token_has_surname_signal(token, morph):
      components['last'].append(token.text)
  return components


def find_word_indexes_in_span(tokens: list[TokenSpan], start: int, end: int) -> list[int]:
  indexes: list[int] = []
  for index, token in enumerate(tokens):
    if not is_word_token(token):
      continue
    if token.end <= start:
      continue
    if token.start >= end:
      break
    indexes.append(index)
  return indexes


def find_previous_word_index(tokens: list[TokenSpan], start_index: int) -> int | None:
  for index in range(start_index - 1, -1, -1):
    if is_word_token(tokens[index]):
      return index
  return None


def find_next_word_index(tokens: list[TokenSpan], start_index: int) -> int | None:
  for index in range(start_index + 1, len(tokens)):
    if is_word_token(tokens[index]):
      return index
  return None


def token_separator_is_plain_space(text: str, left: TokenSpan, right: TokenSpan) -> bool:
  return bool(re.fullmatch(r'\s+', text[left.end:right.start] or ''))


def previous_geo_context(tokens: list[TokenSpan], token_index: int, morph, window: int = 2) -> bool:
  checked = 0
  index = token_index - 1
  while index >= 0 and checked < window:
    token = tokens[index]
    if is_word_token(token):
      checked += 1
      if token_normal_forms(token.text, morph) & GEO_CONTEXT_LEMMAS:
        return True
    index -= 1
  return False


def raw_word_tokens_from_match(text: str, tokens: list[TokenSpan], match, morph) -> list[TokenSpan]:
  seed_indexes = find_word_indexes_in_span(tokens, int(match.start), int(match.stop))
  return trim_name_edges([tokens[index] for index in seed_indexes], morph) if seed_indexes else []


def build_name_match(text: str, tokens: list[TokenSpan], match, morph) -> NameMatch | None:
  word_tokens = raw_word_tokens_from_match(text, tokens, match, morph)
  if not word_tokens or any(len(token.text.strip('-')) < 2 for token in word_tokens):
    return None

  components = classify_name_tokens(word_tokens, morph)
  strong_count = len(components['first']) + len(components['last']) + len(components['middle'])
  if strong_count == 0:
    return None
  if any(token_normal_forms(token.text, morph) & NON_PERSON_COMPONENT_LEMMAS for token in word_tokens):
    return None
  if any(token_has_geographical_signal(token, morph) for token in word_tokens):
    return None
  if len(word_tokens) == 1 and components['last'] and not components['first'] and not components['middle']:
    return None
  if len(word_tokens) == 1:
    token_index = tokens.index(word_tokens[0])
    if not is_capitalized_word(word_tokens[0]) or previous_geo_context(tokens, token_index, morph):
      return None
  if any(token_top_pos(token.text, morph) in BLOCKED_NAME_POS for token in word_tokens if not token_is_kinship(token, morph)):
    return None

  return NameMatch(start=word_tokens[0].start, end=word_tokens[-1].end, components=components)


def expand_name_candidate(text: str, word_tokens: list[TokenSpan], tokens: list[TokenSpan], morph) -> list[TokenSpan]:
  if not word_tokens:
    return []

  word_indexes = [index for index, token in enumerate(tokens) if token in word_tokens]
  if not word_indexes:
    return word_tokens

  start_index = word_indexes[0]
  end_index = word_indexes[-1]

  while True:
    previous_index = find_previous_word_index(tokens, start_index)
    if (
      previous_index is None
      or not token_can_be_name_word(tokens[previous_index], morph)
      or not token_separator_is_plain_space(text, tokens[previous_index], tokens[start_index])
    ):
      break
    start_index = previous_index

  while True:
    next_index = find_next_word_index(tokens, end_index)
    if (
      next_index is None
      or not token_can_be_name_word(tokens[next_index], morph)
      or not token_separator_is_plain_space(text, tokens[end_index], tokens[next_index])
    ):
      break
    end_index = next_index

  expanded = [token for token in tokens[start_index:end_index + 1] if is_word_token(token)]
  return trim_name_edges(expanded, morph)


def extract_initial_surname_mentions(text: str) -> list[Mention]:
  mentions: list[Mention] = []
  for match in INITIAL_SURNAME_RE.finditer(text):
    mentions.append(Mention(
      kind='name',
      text=normalize_whitespace(match.group(0)),
      start=match.start(),
      end=match.end(),
      source='initials_surname',
    ))
  return mentions


def extract_capitalized_sequence_mentions(text: str, morph) -> list[Mention]:
  tokens = tokenize_text(text)
  mentions: list[Mention] = []
  index = 0

  while index < len(tokens):
    token = tokens[index]
    if not token_can_be_sequence_name_word(token, morph):
      index += 1
      continue

    start_index = index
    end_index = index
    next_index = find_next_word_index(tokens, index)
    while (
      next_index is not None
      and token_can_be_sequence_name_word(tokens[next_index], morph)
      and token_separator_is_plain_space(text, tokens[end_index], tokens[next_index])
    ):
      end_index = next_index
      next_index = find_next_word_index(tokens, end_index)

    word_tokens = trim_geo_suffix_from_sequence(
      trim_sequence_edges([item for item in tokens[start_index:end_index + 1] if is_word_token(item)], morph),
      tokens,
      morph,
    )
    components = classify_name_tokens(word_tokens, morph)
    strong_count = len(components['first']) + len(components['last']) + len(components['middle'])
    has_uppercase_sequence = len(word_tokens) >= 2 and sum(1 for item in word_tokens if is_uppercase_word(item)) >= 2
    has_short_acronym_tail = any(is_uppercase_word(item) and len(item.text) <= 4 for item in word_tokens)
    all_words_uppercase = all(is_uppercase_word(item) for item in word_tokens)

    if (
      len(word_tokens) >= 2
      and (strong_count >= 1 or has_uppercase_sequence)
      and not (has_short_acronym_tail and not all_words_uppercase)
      and not previous_geo_context(tokens, start_index, morph)
    ):
      mentions.append(Mention(
        kind='name',
        text=normalize_whitespace(text[word_tokens[0].start:word_tokens[-1].end]),
        start=word_tokens[0].start,
        end=word_tokens[-1].end,
        source='capitalized_name_sequence',
      ))

    index = max(end_index + 1, index + 1)

  return mentions


def remove_overlaps(mentions: list[Mention]) -> list[Mention]:
  accepted: list[Mention] = []
  source_rank = {
    'initials_surname': 0,
    'capitalized_name_sequence': 1,
    'natasha_person': 2,
    'lemma_kinship': 3,
  }
  for mention in sorted(mentions, key=lambda item: (item.start, -(item.end - item.start), source_rank.get(item.source, 9), item.kind)):
    overlap = next((item for item in accepted if mention.start < item.end and mention.end > item.start), None)
    if overlap is None:
      accepted.append(mention)
      continue
    if (mention.end - mention.start, -source_rank.get(mention.source, 9)) > (
      overlap.end - overlap.start,
      -source_rank.get(overlap.source, 9),
    ):
      accepted.remove(overlap)
      accepted.append(mention)
  return sorted(accepted, key=lambda item: (item.start, item.end))


def extract_name_mentions(text: str, name_extractor, morph) -> list[Mention]:
  tokens = tokenize_text(text)
  mentions: list[Mention] = []
  seen: set[tuple[int, int]] = set()

  for match in name_extractor(text):
    name_match = build_name_match(text, tokens, match, morph)
    if name_match is None:
      continue
    word_indexes = find_word_indexes_in_span(tokens, name_match.start, name_match.end)
    expanded_tokens = expand_name_candidate(text, [tokens[item] for item in word_indexes], tokens, morph)
    if expanded_tokens:
      name_match = NameMatch(
        start=expanded_tokens[0].start,
        end=expanded_tokens[-1].end,
        components=classify_name_tokens(expanded_tokens, morph),
      )
    key = (name_match.start, name_match.end)
    if key in seen:
      continue
    seen.add(key)
    mentions.append(Mention(
      kind='name',
      text=normalize_whitespace(text[name_match.start:name_match.end]),
      start=name_match.start,
      end=name_match.end,
      source='natasha_person',
    ))

  mentions.extend(extract_initial_surname_mentions(text))
  mentions.extend(extract_capitalized_sequence_mentions(text, morph))

  deduped: list[Mention] = []
  seen_mentions: set[tuple[int, int, str]] = set()
  for mention in mentions:
    key = (mention.start, mention.end, mention.kind)
    if key in seen_mentions:
      continue
    seen_mentions.add(key)
    deduped.append(mention)

  return remove_overlaps(deduped)


def extract_kinship_mentions(text: str, morph) -> list[Mention]:
  tokens = [(match.group(0), match.start(), match.end()) for match in TOKEN_RE.finditer(text)]
  mentions: list[Mention] = []
  index = 0

  while index < len(tokens):
    token_text, token_start, token_end = tokens[index]
    if not WORD_RE.fullmatch(token_text):
      index += 1
      continue

    matched_lemma = next((lemma for lemma in token_normal_forms(token_text, morph) if is_kinship_lemma(lemma)), None)
    if not matched_lemma:
      index += 1
      continue

    start = token_start
    end = token_end
    left = index - 1
    modifier_budget = 2
    while left >= 0 and modifier_budget > 0:
      left_text, left_start, _ = tokens[left]
      if not WORD_RE.fullmatch(left_text):
        break
      if not any(lemma in KINSHIP_MODIFIER_LEMMAS for lemma in token_normal_forms(left_text, morph)):
        break
      start = left_start
      modifier_budget -= 1
      left -= 1

    mentions.append(Mention(
      kind='kinship',
      text=normalize_whitespace(text[start:end]),
      start=start,
      end=end,
      source='lemma_kinship',
    ))
    index += 1

  return mentions


def build_resources():
  global _resources
  if _resources is None:
    morph_vocab = MorphVocab()
    _resources = (NamesExtractor(morph_vocab), pymorphy2.MorphAnalyzer(path=pymorphy2_dicts_ru.get_path()))
  return _resources


def chunked(items: list[Any], size: int) -> list[list[Any]]:
  return [items[index:index + size] for index in range(0, len(items), size)]


def fetch_document(document_id: str) -> dict[str, Any] | None:
  rows = unwrap_rows(execute_yql(f'''
    SELECT id, title, source_type, source_path, block_count, mention_count
    FROM text_documents
    WHERE id = {utf8_literal(document_id)}
    LIMIT 1;
  '''))
  return rows[0] if rows else None


def fetch_blocks(document_id: str) -> list[TextBlock]:
  rows = unwrap_rows(execute_yql(f'''
    SELECT block_index, kind, text
    FROM text_document_blocks
    WHERE document_id = {utf8_literal(document_id)}
    ORDER BY block_index
    LIMIT {MAX_PAGE_SIZE};
  '''))
  return [
    TextBlock(
      index=int(row.get('block_index') or 0),
      kind=str(row.get('kind') or 'paragraph'),
      text=str(row.get('text') or ''),
    )
    for row in rows
    if str(row.get('text') or '').strip()
  ]


def build_mentions_for_blocks(blocks: list[TextBlock], include_names: bool, include_kinship: bool) -> list[dict[str, Any]]:
  name_extractor, morph = build_resources()
  rows: list[dict[str, Any]] = []

  for block in blocks:
    mentions: list[Mention] = []
    if include_names:
      mentions.extend(extract_name_mentions(block.text, name_extractor, morph))
    if include_kinship:
      mentions.extend(extract_kinship_mentions(block.text, morph))

    for mention_index, mention in enumerate(remove_overlaps(mentions)):
      rows.append({
        'block_index': block.index,
        'mention_index': mention_index,
        'kind': mention.kind,
        'text': mention.text,
        'start_offset': mention.start,
        'end_offset': mention.end,
        'source': mention.source,
      })

  return rows


def build_mentions_yql(document_id: str, mentions: list[dict[str, Any]]) -> str:
  statements: list[str] = []
  for row in mentions:
    statements.append(
      'UPSERT INTO text_document_mentions ('
      'document_id, block_index, mention_index, kind, text, start_offset, end_offset, source'
      ') VALUES '
      f'({utf8_literal(document_id)}, {int(row["block_index"])}, {int(row["mention_index"])}, '
      f'{utf8_literal(row["kind"])}, {utf8_literal(row["text"])}, {int(row["start_offset"])}, '
      f'{int(row["end_offset"])}, {utf8_literal(row["source"])});'
    )
  return '\n'.join(statements) + '\n'


def build_block_counts_yql(document_id: str, blocks: list[TextBlock], mentions: list[dict[str, Any]]) -> str:
  counts: dict[int, int] = {block.index: 0 for block in blocks}
  for mention in mentions:
    counts[int(mention['block_index'])] = counts.get(int(mention['block_index']), 0) + 1

  statements = [
    'UPSERT INTO text_document_blocks (document_id, block_index, kind, text, mention_count) VALUES '
    f'({utf8_literal(document_id)}, {block.index}, {utf8_literal(block.kind)}, {utf8_literal(block.text)}, {counts.get(block.index, 0)});'
    for block in blocks
  ]
  return '\n'.join(statements) + '\n'


def update_document_summary(document_id: str, mention_count: int, include_names: bool, include_kinship: bool) -> None:
  timestamp = datetime.now(UTC).isoformat().replace('+00:00', 'Z')
  extractor = {
    'name': 'natasha-person-kinship-ver2',
    'version': 2,
    'name_source': 'natasha_person' if include_names else None,
    'kinship_source': 'lemma_kinship' if include_kinship else None,
    'updated_by': 'family-db-tools-api',
  }
  execute_yql(
    'UPDATE text_documents SET '
    f'extractor = {json_literal(extractor)}, '
    f'mention_count = {int(mention_count)}, '
    f'updated_at = {utf8_literal(timestamp)} '
    f'WHERE id = {utf8_literal(document_id)};'
  )


def process_document_ner(document_id: str, options: dict[str, Any]) -> dict[str, Any]:
  document = fetch_document(document_id)
  if not document:
    raise HttpError(404, 'Document not found.')

  include_names = bool(options.get('includeNames', True))
  include_kinship = bool(options.get('includeKinship', True))
  if not include_names and not include_kinship:
    raise HttpError(400, 'At least one extractor must be enabled.')

  blocks = fetch_blocks(document_id)
  if not blocks:
    raise HttpError(400, 'Document has no text blocks.')

  mentions = build_mentions_for_blocks(blocks, include_names, include_kinship)
  execute_yql(f'DELETE FROM text_document_mentions WHERE document_id = {utf8_literal(document_id)};')
  for mention_chunk in chunked(mentions, MENTION_CHUNK_SIZE):
    execute_yql(build_mentions_yql(document_id, mention_chunk))
  for block_chunk in chunked(blocks, BLOCK_UPDATE_CHUNK_SIZE):
    execute_yql(build_block_counts_yql(document_id, block_chunk, mentions))
  update_document_summary(document_id, len(mentions), include_names, include_kinship)

  return {
    'document': {
      'id': document_id,
      'title': str(document.get('title') or document_id),
      'block_count': len(blocks),
      'mention_count': len(mentions),
    },
    'includeNames': include_names,
    'includeKinship': include_kinship,
  }


def route(event: dict[str, Any]) -> dict[str, Any]:
  method = str(event.get('httpMethod') or 'GET').upper()
  if method == 'OPTIONS':
    return empty_response(204)

  require_api_token(event)
  path = normalize_path(event)
  segments = [unquote(part) for part in path.split('/') if part]

  if method == 'GET' and path == '/health':
    return json_response(200, {'ok': True})

  if len(segments) == 3 and segments[0] == 'documents' and segments[2] == 'ner' and method == 'POST':
    return json_response(200, process_document_ner(segments[1], parse_body(event)))

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
