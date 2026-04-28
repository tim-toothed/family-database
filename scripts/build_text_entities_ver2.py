from __future__ import annotations

import argparse
import inspect
import json
import re
import sys
import warnings
import zipfile
from collections import namedtuple
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

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

try:
  import pymorphy2
  from natasha import MorphVocab, NamesExtractor
except ImportError as exc:  # pragma: no cover - runtime guard
  raise SystemExit(
    'This script requires natasha and pymorphy2. Install them with: python -m pip install -r requirements-text-entities.txt',
  ) from exc


ROOT_DIR = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT_DIR / 'data' / 'docs_processed' / 'index.json'
DEFAULT_OUTPUT_DIR = ROOT_DIR / 'data' / 'docs_processed' / 'entities'
WORD_NAMESPACE = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

MARKDOWN_HEADING_RE = re.compile(r'^\s{0,3}(#{1,6})\s+(.*)$')
MARKDOWN_LIST_RE = re.compile(r'^\s*(?:[-+*]|\d+[.)])\s+(.*)$')
MARKDOWN_QUOTE_RE = re.compile(r'^\s*>\s?(.*)$')
MARKDOWN_FENCE_RE = re.compile(r'^\s*```')
MARKDOWN_LINK_RE = re.compile(r'!?\[([^\]]*)\]\([^)]+\)')
MARKDOWN_CODE_RE = re.compile(r'`([^`]+)`')
MARKDOWN_TAG_RE = re.compile(r'<[^>]+>')
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
  'бабка',
  'бабушка',
  'брат',
  'внук',
  'внучка',
  'дед',
  'дедушка',
  'дочь',
  'дочка',
  'дядя',
  'жена',
  'зять',
  'мама',
  'мать',
  'мачеха',
  'муж',
  'невестка',
  'отец',
  'отчим',
  'папа',
  'племянник',
  'племянница',
  'потомок',
  'предок',
  'прародитель',
  'родитель',
  'родня',
  'родственник',
  'родственница',
  'сват',
  'свекровь',
  'свёкор',
  'сестра',
  'сноха',
  'супруг',
  'супруга',
  'сын',
  'тесть',
  'тетя',
  'тётя',
  'теща',
  'тёща',
}
KINSHIP_MODIFIER_LEMMAS = {
  'двоюродный',
  'единоутробный',
  'единокровный',
  'младший',
  'приемный',
  'приёмный',
  'родной',
  'сводный',
  'старший',
  'троюродный',
}
NON_PERSON_COMPONENT_LEMMAS = {
  'август',
  'дети',
  'дочь',
  'герой',
  'из',
  'заметка',
  'имя',
  'мать',
  'область',
  'отец',
  'район',
  'ребёнок',
  'сын',
  'тетя',
  'тётя',
  'февраль',
  'январь',
}
MONTH_LEMMAS = {
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
}
HONORIFIC_OR_AWARD_LEMMAS = {
  'герой',
  'кавалер',
  'лауреат',
  'орден',
  'медаль',
  'награда',
  'степень',
  'союз',
  'труд',
  'революция',
  'звезда',
}
ONE_WORD_NAME_CONTEXT_BLOCKERS = {
  'династия',
  'имени',
  'мануфактура',
  'фабрика',
}
GEO_CONTEXT_LEMMAS = {
  'автономия',
  'область',
  'город',
  'губерния',
  'деревня',
  'край',
  'обл',
  'поселок',
  'посёлок',
  'район',
  'регион',
  'республика',
  'село',
  'станица',
  'станция',
  'улус',
}
BLOCKED_NAME_POS = {
  'ADJF',
  'ADJS',
  'ADVB',
  'COMP',
  'CONJ',
  'GRND',
  'INFN',
  'INTJ',
  'NUMR',
  'PRCL',
  'PRED',
  'PREP',
  'PRTF',
  'PRTS',
  'VERB',
}


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
  id: str
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


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description='Build text mentions using Natasha for person names and lemma matching for kinship words.',
  )
  parser.add_argument('--document-id', help='Process only one document from data/docs_processed/index.json.')
  parser.add_argument(
    '--output-dir',
    default=str(DEFAULT_OUTPUT_DIR),
    help='Directory for output JSON files.',
  )
  return parser.parse_args()


def normalize_whitespace(value: str) -> str:
  return re.sub(r'\s+', ' ', value).strip()


def strip_markdown_inline(text: str) -> str:
  value = MARKDOWN_LINK_RE.sub(lambda match: match.group(1), text)
  value = MARKDOWN_CODE_RE.sub(lambda match: match.group(1), value)
  value = MARKDOWN_TAG_RE.sub(' ', value)
  for marker in ('***', '___', '**', '__', '*', '_', '~~'):
    value = value.replace(marker, '')
  return normalize_whitespace(value.replace('\\', ''))


def extract_markdown_blocks(text: str) -> list[TextBlock]:
  blocks: list[TextBlock] = []
  paragraph_lines: list[str] = []
  in_fence = False

  def flush_paragraph() -> None:
    if not paragraph_lines:
      return
    block_text = strip_markdown_inline(' '.join(paragraph_lines))
    paragraph_lines.clear()
    if block_text:
      blocks.append(TextBlock(index=len(blocks), kind='paragraph', text=block_text))

  for raw_line in text.splitlines():
    line = raw_line.rstrip()

    if MARKDOWN_FENCE_RE.match(line.strip()):
      flush_paragraph()
      in_fence = not in_fence
      continue
    if in_fence:
      continue

    stripped = line.strip()
    if not stripped:
      flush_paragraph()
      continue

    heading_match = MARKDOWN_HEADING_RE.match(line)
    if heading_match:
      flush_paragraph()
      heading_text = strip_markdown_inline(heading_match.group(2))
      if heading_text:
        blocks.append(TextBlock(index=len(blocks), kind='heading', text=heading_text))
      continue

    list_match = MARKDOWN_LIST_RE.match(line)
    if list_match:
      flush_paragraph()
      list_text = strip_markdown_inline(list_match.group(1))
      if list_text:
        blocks.append(TextBlock(index=len(blocks), kind='list_item', text=list_text))
      continue

    quote_match = MARKDOWN_QUOTE_RE.match(line)
    if quote_match:
      paragraph_lines.append(quote_match.group(1))
      continue

    paragraph_lines.append(stripped)

  flush_paragraph()
  return blocks


def extract_docx_blocks(path: Path) -> list[TextBlock]:
  with zipfile.ZipFile(path) as archive:
    xml_bytes = archive.read('word/document.xml')

  root = ET.fromstring(xml_bytes)
  body = root.find('w:body', WORD_NAMESPACE)
  if body is None:
    return []

  blocks: list[TextBlock] = []
  for child in body:
    local_name = child.tag.rsplit('}', 1)[-1]
    if local_name == 'p':
      text = ''.join(node.text or '' for node in child.findall('.//w:t', WORD_NAMESPACE))
      text = normalize_whitespace(text)
      if text:
        blocks.append(TextBlock(index=len(blocks), kind='paragraph', text=text))
      continue

    if local_name == 'tbl':
      for cell in child.findall('.//w:tc', WORD_NAMESPACE):
        text = ''.join(node.text or '' for node in cell.findall('.//w:t', WORD_NAMESPACE))
        text = normalize_whitespace(text)
        if text:
          blocks.append(TextBlock(index=len(blocks), kind='table_cell', text=text))

  return blocks


def load_manifest_entries() -> list[dict[str, str]]:
  payload = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
  return payload.get('documents') or []


def extract_blocks(entry: dict[str, str]) -> list[TextBlock]:
  path = ROOT_DIR / Path(str(entry['path']).lstrip('./'))
  doc_type = str(entry['type']).lower()
  if doc_type == 'markdown':
    return extract_markdown_blocks(path.read_text(encoding='utf-8'))
  if doc_type == 'docx':
    return extract_docx_blocks(path)
  raise RuntimeError(f'Unsupported document type: {doc_type}')


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
  if not parses:
    return None
  return parses[0].tag.POS


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
  if not is_word_token(token):
    return False
  return any(is_kinship_lemma(lemma) for lemma in token_normal_forms(token.text, morph))


def token_is_name_component(token: TokenSpan, morph) -> bool:
  return (
    token_has_name_signal(token, morph)
    or token_has_surname_signal(token, morph)
    or token_has_patronymic_signal(token, morph)
  )


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
  while result and (
    token_is_kinship(result[0], morph)
    or not token_is_name_component(result[0], morph)
  ):
    result.pop(0)
  while result and (
    token_is_kinship(result[-1], morph)
    or not token_is_name_component(result[-1], morph)
  ):
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
      continue
    if token_has_patronymic_signal(token, morph):
      components['middle'].append(token.text)
      continue
    if token_has_surname_signal(token, morph):
      components['last'].append(token.text)
      continue
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
  if not seed_indexes:
    return []
  return trim_name_edges([tokens[index] for index in seed_indexes], morph)


def build_name_match(text: str, tokens: list[TokenSpan], match, morph) -> NameMatch | None:
  word_tokens = raw_word_tokens_from_match(text, tokens, match, morph)
  if not word_tokens:
    return None

  if any(len(token.text.strip('-')) < 2 for token in word_tokens):
    return None

  components = classify_name_tokens(word_tokens, morph)
  strong_count = len(components['first']) + len(components['last']) + len(components['middle'])
  word_count = len(word_tokens)
  if strong_count == 0:
    return None

  if any(token_normal_forms(token.text, morph) & NON_PERSON_COMPONENT_LEMMAS for token in word_tokens):
    return None

  if any(token_has_geographical_signal(token, morph) for token in word_tokens):
    return None

  if word_count == 1 and not (components['first'] or components['last'] or components['middle']):
    return None

  if word_count == 1 and components['last'] and not components['first'] and not components['middle']:
    return None

  if word_count == 1:
    token_index = tokens.index(word_tokens[0])
    if not is_capitalized_word(word_tokens[0]) or previous_geo_context(tokens, token_index, morph):
      return None

  if any(token_top_pos(token.text, morph) in BLOCKED_NAME_POS for token in word_tokens if not token_is_kinship(token, morph)):
    return None

  start = word_tokens[0].start
  end = word_tokens[-1].end

  return NameMatch(start=start, end=end, components=components)


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


def mention_key(mention: Mention) -> tuple[int, int, str]:
  return (mention.start, mention.end, mention.kind)


def extract_initial_surname_mentions(text: str) -> list[Mention]:
  mentions: list[Mention] = []
  for match in INITIAL_SURNAME_RE.finditer(text):
    value = normalize_whitespace(match.group(0))
    if not value:
      continue
    mentions.append(
      Mention(
        id='',
        kind='name',
        text=value,
        start=match.start(),
        end=match.end(),
        source='initials_surname',
      ),
    )
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

    word_tokens = [item for item in tokens[start_index:end_index + 1] if is_word_token(item)]
    word_tokens = trim_geo_suffix_from_sequence(trim_sequence_edges(word_tokens, morph), tokens, morph)
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
      mentions.append(
        Mention(
          id='',
          kind='name',
          text=normalize_whitespace(text[word_tokens[0].start:word_tokens[-1].end]),
          start=word_tokens[0].start,
          end=word_tokens[-1].end,
          source='capitalized_name_sequence',
        ),
      )

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
    overlap = next(
      (
        item for item in accepted
        if mention.start < item.end and mention.end > item.start
      ),
      None,
    )
    if overlap is None:
      accepted.append(mention)
      continue

    current_score = (mention.end - mention.start, -source_rank.get(mention.source, 9))
    overlap_score = (overlap.end - overlap.start, -source_rank.get(overlap.source, 9))
    if current_score > overlap_score:
      accepted.remove(overlap)
      accepted.append(mention)

  return sorted(accepted, key=lambda item: (item.start, item.end))


def serialize_mention(mention: Mention) -> dict[str, Any]:
  return {
    'id': mention.id,
    'kind': mention.kind,
    'text': mention.text,
    'start': mention.start,
    'end': mention.end,
    'source': mention.source,
  }


def assign_mention_ids(mentions: list[Mention]) -> list[Mention]:
  counters = {'name': 0, 'kinship': 0}
  result: list[Mention] = []
  for mention in mentions:
    counters[mention.kind] = counters.get(mention.kind, 0) + 1
    prefix = 'K' if mention.kind == 'kinship' else 'N'
    result.append(
      Mention(
        id=mention.id or f'{prefix}{counters[mention.kind]:04d}',
        kind=mention.kind,
        text=mention.text,
        start=mention.start,
        end=mention.end,
        source=mention.source,
      ),
    )
  return result


def extract_name_mentions(text: str, name_extractor, morph) -> list[Mention]:
  tokens = tokenize_text(text)
  mentions: list[Mention] = []
  seen: set[tuple[int, int]] = set()

  for index, match in enumerate(name_extractor(text)):
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

    mention_text = normalize_whitespace(text[name_match.start:name_match.end])
    mentions.append(
      Mention(
        id=f'N{index + 1:04d}',
        kind='name',
        text=mention_text,
        start=name_match.start,
        end=name_match.end,
        source='natasha_person',
      ),
    )

  mentions.extend(extract_initial_surname_mentions(text))
  mentions.extend(extract_capitalized_sequence_mentions(text, morph))

  deduped: list[Mention] = []
  seen_mentions: set[tuple[int, int, str]] = set()
  for mention in mentions:
    key = mention_key(mention)
    if key in seen_mentions:
      continue
    seen_mentions.add(key)
    deduped.append(mention)

  return remove_overlaps(deduped)


def token_normal_forms_cached(token_text: str, morph) -> set[str]:
  return token_normal_forms(token_text, morph)


def extract_kinship_mentions(text: str, morph) -> list[Mention]:
  tokens = [(match.group(0), match.start(), match.end()) for match in TOKEN_RE.finditer(text)]
  mentions: list[Mention] = []
  index = 0

  while index < len(tokens):
    token_text, token_start, token_end = tokens[index]
    if not WORD_RE.fullmatch(token_text):
      index += 1
      continue

    lemmas = token_normal_forms_cached(token_text, morph)
    matched_lemma = next((lemma for lemma in lemmas if is_kinship_lemma(lemma)), None)
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
      left_lemmas = token_normal_forms_cached(left_text, morph)
      if not any(lemma in KINSHIP_MODIFIER_LEMMAS for lemma in left_lemmas):
        break
      start = left_start
      modifier_budget -= 1
      left -= 1

    mentions.append(
      Mention(
        id=f'K{len(mentions) + 1:04d}',
        kind='kinship',
        text=normalize_whitespace(text[start:end]),
        start=start,
        end=end,
        source='lemma_kinship',
      ),
    )
    index += 1

  return mentions


def build_document_payload(entry: dict[str, str], name_extractor, morph) -> dict[str, Any]:
  blocks = extract_blocks(entry)
  payload_blocks = []
  for block in blocks:
    mentions = assign_mention_ids(remove_overlaps([
      *extract_name_mentions(block.text, name_extractor, morph),
      *extract_kinship_mentions(block.text, morph),
    ]))
    payload_blocks.append({
      'index': block.index,
      'kind': block.kind,
      'text': block.text,
      'mentions': [serialize_mention(mention) for mention in mentions],
    })

  mention_count = sum(len(block['mentions']) for block in payload_blocks)
  return {
    'document_id': entry['id'],
    'title': entry.get('title') or entry['id'],
    'source_type': entry['type'],
    'source_path': entry['path'],
    'generated_at': datetime.now(UTC).isoformat(),
    'extractor': {
      'name': 'natasha-person-kinship-ver2',
      'version': 2,
      'name_source': 'natasha_person',
      'kinship_source': 'lemma_kinship',
    },
    'block_count': len(payload_blocks),
    'mention_count': mention_count,
    'blocks': payload_blocks,
  }


def write_payload(payload: dict[str, Any], output_dir: Path) -> Path:
  output_dir.mkdir(parents=True, exist_ok=True)
  target_path = output_dir / f"{payload['document_id']}.json"
  target_path.write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + '\n',
    encoding='utf-8',
  )
  return target_path


def build_resources():
  morph_vocab = MorphVocab()
  return NamesExtractor(morph_vocab), pymorphy2.MorphAnalyzer()


def main() -> None:
  args = parse_args()
  entries = load_manifest_entries()
  if args.document_id:
    entries = [entry for entry in entries if str(entry.get('id')) == args.document_id]
    if not entries:
      raise RuntimeError(f'Document {args.document_id} was not found in manifest.')

  name_extractor, morph = build_resources()
  output_dir = Path(args.output_dir)

  summary: list[dict[str, Any]] = []
  for entry in entries:
    payload = build_document_payload(entry, name_extractor, morph)
    target_path = write_payload(payload, output_dir)
    summary.append({
      'document_id': payload['document_id'],
      'mention_count': payload['mention_count'],
      'path': str(target_path.relative_to(ROOT_DIR)).replace('\\', '/'),
    })
    print(f"{payload['document_id']}: {payload['mention_count']} mentions -> {target_path.relative_to(ROOT_DIR)}")

  (output_dir / 'index.json').write_text(
    json.dumps({'documents': summary}, ensure_ascii=False, indent=2) + '\n',
    encoding='utf-8',
  )


if __name__ == '__main__':
  try:
    main()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
