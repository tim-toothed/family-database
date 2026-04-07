from __future__ import annotations

import argparse
import inspect
import json
import re
import sys
import warnings
import zipfile
from collections import namedtuple
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from xml.etree import ElementTree as ET

if not hasattr(inspect, 'getargspec'):
  ArgSpec = namedtuple('ArgSpec', 'args varargs keywords defaults')

  def getargspec(func):
    spec = inspect.getfullargspec(func)
    return ArgSpec(spec.args, spec.varargs, spec.varkw, spec.defaults)

  inspect.getargspec = getargspec

try:
  warnings.filterwarnings(
    'ignore',
    message='pkg_resources is deprecated as an API.*',
    category=UserWarning,
  )
  import pymorphy2
  from natasha import MorphVocab, NamesExtractor
except ImportError as exc:  # pragma: no cover - handled at runtime
  raise SystemExit(
    'Required NLP packages are missing. Install them with: python -m pip install -r requirements-text-entities.txt',
  ) from exc


ROOT_DIR = Path(__file__).resolve().parents[1]
TEXT_DOCUMENTS_DIR = ROOT_DIR / 'data' / 'sources' / 'text_documents'
MANIFEST_PATH = ROOT_DIR / 'data' / 'misc' / 'index.json'
ENTITIES_DIR = ROOT_DIR / 'data' / 'text_processing' / 'entities_legacy'
WORD_NAMESPACE = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

MARKDOWN_HEADING_RE = re.compile(r'^\s{0,3}(#{1,6})\s+(.*)$')
MARKDOWN_LIST_RE = re.compile(r'^\s*(?:[-+*]|\d+[.)])\s+(.*)$')
MARKDOWN_QUOTE_RE = re.compile(r'^\s*>\s?(.*)$')
MARKDOWN_FENCE_RE = re.compile(r'^\s*```')
MARKDOWN_LINK_RE = re.compile(r'!?\[([^\]]*)\]\([^)]+\)')
MARKDOWN_CODE_RE = re.compile(r'`([^`]+)`')
MARKDOWN_TAG_RE = re.compile(r'<[^>]+>')

TOKEN_RE = re.compile(r'[A-Za-zА-ЯЁа-яё]+(?:-[A-Za-zА-ЯЁа-яё]+)*|[()\[\]]|[^\s]')
CYRILLIC_WORD_RE = re.compile(r'^[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*$')
CAPITALIZED_WORD_RE = re.compile(r'^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)*$')
LOWER_WORD_RE = re.compile(r'^[а-яё]+(?:-[а-яё]+)*$')
PATRONYMIC_TOKEN_RE = re.compile(r'(?:вич|вна|ична|оглы|кызы)$', re.IGNORECASE)
TRIM_PUNCTUATION_RE = re.compile(r'^[\s"«»„“”()\[\],.;:!?]+|[\s"«»„“”()\[\],.;:!?]+$')

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
KINSHIP_LEMMA_PATTERNS = (
  re.compile(r'^(?:пра)+дед(?:ушка)?$'),
  re.compile(r'^(?:пра)+баб(?:ка|ушка)$'),
  re.compile(r'^(?:пра)+внук$'),
  re.compile(r'^(?:пра)+внучка$'),
)
NAME_CONTEXT_LEMMAS = {'звать', 'назвать', 'имя'}
ORDINAL_CONTEXT_LEMMAS = {
  'первый',
  'второй',
  'третий',
  'четвертый',
  'четвёртый',
  'пятый',
  'шестой',
  'седьмой',
  'восьмой',
  'девятый',
  'десятый',
}
BLOCKED_NAME_POS = {'ADJF', 'ADJS', 'ADVB', 'COMP', 'CONJ', 'GRND', 'INFN', 'INTJ', 'NUMR', 'PRCL', 'PRED', 'PREP', 'PRTF', 'PRTS', 'VERB'}
SOURCE_PRIORITY = {
  'natasha_names': 3,
  'morph_name_pattern': 2,
  'kinship_lemma': 2,
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
class EntityCandidate:
  kind: str
  start: int
  end: int
  source: str
  confidence: str


@dataclass(slots=True)
class EntitySpan:
  id: str
  kind: str
  text: str
  start: int
  end: int
  prefix: str
  suffix: str
  source: str
  confidence: str


@dataclass(slots=True)
class NameCandidate:
  start: int
  end: int
  next_index: int
  token_indexes: tuple[int, ...]


@dataclass(slots=True)
class NlpResources:
  name_extractor: NamesExtractor
  morph: object


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description='Build entity spans for text documents and store them in data/text_processing/entities_legacy.',
  )
  parser.add_argument('--document-id', help='Process only one document from data/text_processing/index.json.')
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


def trim_span(text: str, start: int, end: int) -> tuple[int, int]:
  fragment = text[start:end]
  left_trimmed = len(fragment) - len(fragment.lstrip(' \t\r\n"«»„“”()[],:;.!?'))
  right_trimmed = len(fragment.rstrip(' \t\r\n"«»„“”()[],:;.!?'))
  return start + left_trimmed, start + right_trimmed


def get_match_bounds(match: object) -> tuple[int, int] | None:
  start = getattr(match, 'start', None)
  stop = getattr(match, 'stop', None)
  if isinstance(start, int) and isinstance(stop, int):
    return start, stop

  span = getattr(match, 'span', None)
  if isinstance(span, tuple) and len(span) == 2:
    return int(span[0]), int(span[1])

  if span is not None:
    span_start = getattr(span, 'start', None)
    span_stop = getattr(span, 'stop', None)
    if isinstance(span_start, int) and isinstance(span_stop, int):
      return span_start, span_stop

  return None


@lru_cache(maxsize=20000)
def parse_word(word: str, morph: object):
  return tuple(morph.parse(word))


def token_normal_forms(token_text: str, morph: object) -> set[str]:
  return {parse.normal_form for parse in parse_word(token_text, morph)}


def token_top_pos(token_text: str, morph: object) -> str | None:
  parses = parse_word(token_text, morph)
  if not parses:
    return None
  return parses[0].tag.POS


def token_grammemes(token_text: str, morph: object) -> set[str]:
  grammemes: set[str] = set()
  for parse in parse_word(token_text, morph):
    grammemes.update(parse.tag.grammemes)
  return grammemes


def token_has_grammeme(token_text: str, morph: object, grammeme: str) -> bool:
  return grammeme in token_grammemes(token_text, morph)


def token_is_word(token: TokenSpan) -> bool:
  return bool(CYRILLIC_WORD_RE.fullmatch(token.text))


def token_is_capitalized(token: TokenSpan) -> bool:
  return bool(CAPITALIZED_WORD_RE.fullmatch(token.text))


def token_is_lowercase(token: TokenSpan) -> bool:
  return bool(LOWER_WORD_RE.fullmatch(token.text))


def token_has_person_signal(token: TokenSpan, morph: object) -> bool:
  if not token_is_word(token):
    return False
  if PATRONYMIC_TOKEN_RE.search(token.text):
    return True
  grammemes = token_grammemes(token.text, morph)
  return bool({'Name', 'Surn', 'Patr'} & grammemes)


def token_has_name_signal(token: TokenSpan, morph: object) -> bool:
  return token_is_word(token) and token_has_grammeme(token.text, morph, 'Name')


def token_has_surname_signal(token: TokenSpan, morph: object) -> bool:
  return token_is_word(token) and token_has_grammeme(token.text, morph, 'Surn')


def token_has_patronymic_signal(token: TokenSpan, morph: object) -> bool:
  return token_is_word(token) and (PATRONYMIC_TOKEN_RE.search(token.text) is not None or token_has_grammeme(token.text, morph, 'Patr'))


def token_has_geographical_signal(token: TokenSpan, morph: object) -> bool:
  return token_is_word(token) and token_has_grammeme(token.text, morph, 'Geox')


def token_is_name_component_candidate(token: TokenSpan, morph: object) -> bool:
  if not token_is_capitalized(token):
    return False
  if token_is_kinship(token, morph) and not token_has_person_signal(token, morph):
    return False
  if token_has_person_signal(token, morph):
    return True
  if token_has_geographical_signal(token, morph):
    return False

  top_pos = token_top_pos(token.text, morph)
  return top_pos not in BLOCKED_NAME_POS


def token_is_likely_surname_fallback(token: TokenSpan, morph: object) -> bool:
  return (
    token_is_capitalized(token)
    and not token_is_kinship(token, morph)
    and not token_has_geographical_signal(token, morph)
    and token_top_pos(token.text, morph) not in BLOCKED_NAME_POS
  )


def is_kinship_lemma(lemma: str) -> bool:
  if lemma in KINSHIP_LEMMAS:
    return True
  return any(pattern.fullmatch(lemma) for pattern in KINSHIP_LEMMA_PATTERNS)


def token_is_kinship(token: TokenSpan, morph: object) -> bool:
  if not token_is_word(token):
    return False
  return any(is_kinship_lemma(lemma) for lemma in token_normal_forms(token.text, morph))


def token_is_kinship_modifier(token: TokenSpan, morph: object) -> bool:
  if not token_is_word(token):
    return False
  return any(lemma in KINSHIP_MODIFIER_LEMMAS for lemma in token_normal_forms(token.text, morph))


def token_has_name_context(token: TokenSpan, morph: object) -> bool:
  if not token_is_word(token):
    return False
  lemmas = token_normal_forms(token.text, morph)
  return (
    any(is_kinship_lemma(lemma) for lemma in lemmas)
    or bool(lemmas & (NAME_CONTEXT_LEMMAS | ORDINAL_CONTEXT_LEMMAS))
  )


def collect_name_candidate(tokens: list[TokenSpan], start_index: int, morph: object) -> NameCandidate | None:
  if start_index >= len(tokens) or not token_is_name_component_candidate(tokens[start_index], morph):
    return None

  index = start_index
  token_indexes: list[int] = []
  end = tokens[start_index].end

  while index < len(tokens):
    token = tokens[index]
    if token_is_name_component_candidate(token, morph):
      token_indexes.append(index)
      end = token.end
      index += 1
      continue

    if token.text in {'(', '['} and index + 2 < len(tokens):
      middle = tokens[index + 1]
      closing = tokens[index + 2]
      if closing.text in {')', ']'} and token_is_name_component_candidate(middle, morph):
        token_indexes.append(index + 1)
        end = closing.end
        index += 3
        continue

    break

  if not token_indexes:
    return None

  return NameCandidate(
    start=tokens[start_index].start,
    end=end,
    next_index=index,
    token_indexes=tuple(token_indexes),
  )


def is_valid_single_name(tokens: list[TokenSpan], candidate: NameCandidate, morph: object) -> bool:
  token = tokens[candidate.token_indexes[0]]
  if token_has_name_signal(token, morph) or token_has_patronymic_signal(token, morph):
    pass
  elif token_has_surname_signal(token, morph):
    prev_token = tokens[candidate.token_indexes[0] - 1] if candidate.token_indexes[0] > 0 else None
    return bool(prev_token and token_has_name_context(prev_token, morph))
  else:
    return False

  prev_token = tokens[candidate.token_indexes[0] - 1] if candidate.token_indexes[0] > 0 else None
  next_token = tokens[candidate.next_index] if candidate.next_index < len(tokens) else None

  if prev_token and token_has_name_context(prev_token, morph):
    return True
  if next_token and token_is_lowercase(next_token):
    return True
  if prev_token is None and next_token and token_is_lowercase(next_token):
    return True
  return False


def is_valid_name_candidate(tokens: list[TokenSpan], candidate: NameCandidate, morph: object) -> bool:
  components = [tokens[index] for index in candidate.token_indexes]
  if len(components) > 4:
    return False

  strong_components = [token for token in components if token_has_person_signal(token, morph)]
  has_name = any(token_has_name_signal(token, morph) for token in components)
  has_surname = any(token_has_surname_signal(token, morph) for token in components)
  has_patronymic = any(token_has_patronymic_signal(token, morph) for token in components)

  if len(components) == 1:
    return is_valid_single_name(tokens, candidate, morph)

  if len(components) == 2:
    if has_patronymic:
      return True
    if has_name and has_surname:
      return True
    if len(strong_components) == 2:
      return True

    weak_components = [token for token in components if token not in strong_components]
    return has_name and len(weak_components) == 1 and token_is_likely_surname_fallback(weak_components[0], morph)

  if has_name and has_patronymic:
    return True
  if has_name and has_surname:
    return True
  if len(strong_components) >= 2:
    return True

  return len(strong_components) >= 1 and any(token_is_likely_surname_fallback(token, morph) for token in components)


def build_entity(entity_id: str, candidate: EntityCandidate, text: str) -> EntitySpan:
  return EntitySpan(
    id=entity_id,
    kind=candidate.kind,
    text=text[candidate.start:candidate.end],
    start=candidate.start,
    end=candidate.end,
    prefix=text[max(0, candidate.start - 24):candidate.start],
    suffix=text[candidate.end:candidate.end + 24],
    source=candidate.source,
    confidence=candidate.confidence,
  )


def extract_natasha_name_candidates(text: str, resources: NlpResources) -> list[EntityCandidate]:
  candidates: list[EntityCandidate] = []

  for match in resources.name_extractor(text):
    bounds = get_match_bounds(match)
    if not bounds:
      continue

    start, end = trim_span(text, bounds[0], bounds[1])
    if end <= start:
      continue

    fragment = text[start:end]
    fragment_tokens = tokenize_text(fragment)
    if not fragment_tokens:
      continue

    fragment_candidate = collect_name_candidate(fragment_tokens, 0, resources.morph)
    if fragment_candidate is None:
      continue
    if fragment_candidate.start != 0 or fragment_candidate.end != len(fragment):
      continue
    if not is_valid_name_candidate(fragment_tokens, fragment_candidate, resources.morph):
      continue

    candidates.append(
      EntityCandidate(
        kind='name',
        start=start,
        end=end,
        source='natasha_names',
        confidence='high',
      ),
    )

  return candidates


def extract_pattern_name_candidates(text: str, resources: NlpResources) -> list[EntityCandidate]:
  tokens = tokenize_text(text)
  candidates: list[EntityCandidate] = []

  for index in range(len(tokens)):
    candidate = collect_name_candidate(tokens, index, resources.morph)
    if candidate is None or not is_valid_name_candidate(tokens, candidate, resources.morph):
      continue

    start, end = trim_span(text, candidate.start, candidate.end)
    if end <= start:
      continue

    candidates.append(
      EntityCandidate(
        kind='name',
        start=start,
        end=end,
        source='morph_name_pattern',
        confidence='medium',
      ),
    )

  return candidates


def extract_name_entities(text: str, resources: NlpResources) -> list[EntityCandidate]:
  return [
    *extract_natasha_name_candidates(text, resources),
    *extract_pattern_name_candidates(text, resources),
  ]


def extract_kinship_entities(text: str, resources: NlpResources) -> list[EntityCandidate]:
  tokens = tokenize_text(text)
  candidates: list[EntityCandidate] = []

  for index, token in enumerate(tokens):
    if not token_is_kinship(token, resources.morph):
      continue

    start = token.start
    end = token.end

    left_index = index - 1
    modifier_budget = 2
    while left_index >= 0 and modifier_budget > 0 and token_is_kinship_modifier(tokens[left_index], resources.morph):
      start = tokens[left_index].start
      left_index -= 1
      modifier_budget -= 1

    if index + 1 < len(tokens):
      name_candidate = collect_name_candidate(tokens, index + 1, resources.morph)
      if name_candidate and is_valid_name_candidate(tokens, name_candidate, resources.morph):
        end = name_candidate.end

    start, end = trim_span(text, start, end)
    if end <= start:
      continue

    candidates.append(
      EntityCandidate(
        kind='kinship',
        start=start,
        end=end,
        source='kinship_lemma',
        confidence='medium',
      ),
    )

  return candidates


def entity_sort_key(entity: EntityCandidate) -> tuple[int, int, int]:
  return (entity.start, -(entity.end - entity.start), SOURCE_PRIORITY.get(entity.source, 0))


def entity_score(entity: EntityCandidate) -> tuple[int, int, int]:
  return (entity.end - entity.start, SOURCE_PRIORITY.get(entity.source, 0), 1 if entity.kind == 'kinship' else 0)


def sort_entities(entities: list[EntityCandidate]) -> list[EntityCandidate]:
  return sorted(entities, key=entity_sort_key)


def deduplicate_entities(entities: list[EntityCandidate]) -> list[EntityCandidate]:
  accepted: list[EntityCandidate] = []

  for entity in sorted(entities, key=lambda item: (-entity_score(item)[0], -entity_score(item)[1], -entity_score(item)[2], item.start)):
    if any(entity.start < existing.end and entity.end > existing.start for existing in accepted):
      continue
    accepted.append(entity)

  return sort_entities(accepted)


def build_document_payload(entry: dict[str, str], resources: NlpResources) -> dict[str, object]:
  blocks = extract_blocks(entry)
  entity_counter = 1
  payload_blocks: list[dict[str, object]] = []

  for block in blocks:
    raw_entities = [
      *extract_kinship_entities(block.text, resources),
      *extract_name_entities(block.text, resources),
    ]
    entities = deduplicate_entities(raw_entities)
    payload_entities = []

    for entity in entities:
      payload_entities.append(asdict(build_entity(f'E{entity_counter:05d}', entity, block.text)))
      entity_counter += 1

    payload_blocks.append({
      'index': block.index,
      'kind': block.kind,
      'text': block.text,
      'entities': payload_entities,
    })

  entity_count = sum(len(block['entities']) for block in payload_blocks)
  return {
    'document_id': entry['id'],
    'title': entry.get('title') or entry['id'],
    'source_type': entry['type'],
    'source_path': entry['path'],
    'generated_at': datetime.now(UTC).isoformat(),
    'extractor': {
      'name': 'natasha-morph-kinship-hybrid',
      'version': 2,
    },
    'block_count': len(payload_blocks),
    'entity_count': entity_count,
    'blocks': payload_blocks,
  }


def write_payload(payload: dict[str, object]) -> Path:
  ENTITIES_DIR.mkdir(parents=True, exist_ok=True)
  target_path = ENTITIES_DIR / f"{payload['document_id']}.json"
  target_path.write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + '\n',
    encoding='utf-8',
  )
  return target_path


def build_resources() -> NlpResources:
  morph_vocab = MorphVocab()
  name_extractor = NamesExtractor(morph_vocab)
  morph = pymorphy2.MorphAnalyzer()
  return NlpResources(name_extractor=name_extractor, morph=morph)


def main() -> None:
  args = parse_args()
  entries = load_manifest_entries()
  if args.document_id:
    entries = [entry for entry in entries if str(entry.get('id')) == args.document_id]
    if not entries:
      raise RuntimeError(f'Document {args.document_id} was not found in manifest.')

  resources = build_resources()

  summary: list[dict[str, object]] = []
  for entry in entries:
    payload = build_document_payload(entry, resources)
    target_path = write_payload(payload)
    summary.append({
      'document_id': payload['document_id'],
      'entity_count': payload['entity_count'],
      'block_count': payload['block_count'],
      'path': str(target_path.relative_to(ROOT_DIR)).replace('\\', '/'),
    })
    print(f"{payload['document_id']}: {payload['entity_count']} entities -> {target_path.relative_to(ROOT_DIR)}")

  (ENTITIES_DIR / 'index.json').write_text(
    json.dumps({'documents': summary}, ensure_ascii=False, indent=2) + '\n',
    encoding='utf-8',
  )


if __name__ == '__main__':
  try:
    main()
  except Exception as exc:  # noqa: BLE001
    print(str(exc), file=sys.stderr)
    sys.exit(1)
