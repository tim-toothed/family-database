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
  import torch
  from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline
except ImportError as exc:  # pragma: no cover - runtime guard
  raise SystemExit(
    'This experimental script requires transformers, torch and pymorphy2.',
  ) from exc


ROOT_DIR = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT_DIR / 'data' / 'text_processing' / 'index.json'
ENTITIES_DIR = ROOT_DIR / 'data' / 'text_processing' / 'entities'
WORD_NAMESPACE = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

MARKDOWN_HEADING_RE = re.compile(r'^\s{0,3}(#{1,6})\s+(.*)$')
MARKDOWN_LIST_RE = re.compile(r'^\s*(?:[-+*]|\d+[.)])\s+(.*)$')
MARKDOWN_QUOTE_RE = re.compile(r'^\s*>\s?(.*)$')
MARKDOWN_FENCE_RE = re.compile(r'^\s*```')
MARKDOWN_LINK_RE = re.compile(r'!?\[([^\]]*)\]\([^)]+\)')
MARKDOWN_CODE_RE = re.compile(r'`([^`]+)`')
MARKDOWN_TAG_RE = re.compile(r'<[^>]+>')
TOKEN_RE = re.compile(r'[A-Za-zА-ЯЁа-яё]+(?:-[A-Za-zА-ЯЁа-яё]+)*|[^\s]')
WORD_RE = re.compile(r'^[A-Za-zА-ЯЁа-яё-]+$')

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
  'младший',
  'приемный',
  'приёмный',
  'родной',
  'сводный',
  'старший',
  'троюродный',
}
PERSON_LABEL_HINTS = {'PER', 'PERSON', 'FIRST_NAME', 'LAST_NAME', 'MIDDLE_NAME'}
NON_PERSON_LEMMAS = {
  'а',
  'без',
  'в',
  'во',
  'для',
  'до',
  'и',
  'из',
  'или',
  'к',
  'ко',
  'между',
  'на',
  'над',
  'но',
  'о',
  'об',
  'обо',
  'около',
  'от',
  'по',
  'под',
  'при',
  'про',
  'с',
  'со',
  'у',
  'через',
}


@dataclass(slots=True)
class TextBlock:
  index: int
  kind: str
  text: str


@dataclass(slots=True)
class Mention:
  id: str
  kind: str
  text: str
  start: int
  end: int
  source: str
  confidence: float
  extra: dict[str, Any] | None = None


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description='Experimental NER pipeline for text documents.',
  )
  parser.add_argument('--document-id', help='Process only one document from data/text_processing/index.json.')
  parser.add_argument(
    '--model',
    default='Gherman/bert-base-NER-Russian',
    help='Hugging Face token-classification model for Russian NER.',
  )
  parser.add_argument(
    '--output-dir',
    default=str(ENTITIES_DIR),
    help='Directory for experimental output JSON files.',
  )
  parser.add_argument(
    '--local-only',
    action='store_true',
    help='Do not try to download the model, only use local cache.',
  )
  parser.add_argument(
    '--device',
    default='auto',
    help='Inference device: auto, cpu, cuda, cuda:0, cuda:1, ...',
  )
  parser.add_argument(
    '--batch-size',
    type=int,
    default=16,
    help='Batch size for transformer inference.',
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


def resolve_pipeline_device(device_name: str) -> int:
  normalized = str(device_name or 'auto').strip().lower()
  if normalized == 'auto':
    return 0 if torch.cuda.is_available() else -1
  if normalized == 'cpu':
    return -1
  if normalized == 'cuda':
    if not torch.cuda.is_available():
      raise RuntimeError('CUDA was requested, but torch.cuda.is_available() is False.')
    return 0
  if normalized.startswith('cuda:'):
    if not torch.cuda.is_available():
      raise RuntimeError('CUDA was requested, but torch.cuda.is_available() is False.')
    return int(normalized.split(':', 1)[1])
  raise RuntimeError(f'Unsupported device value: {device_name}')


def build_ner_pipeline(model_name: str, local_only: bool, device_name: str, batch_size: int):
  tokenizer = AutoTokenizer.from_pretrained(model_name, local_files_only=local_only)
  model = AutoModelForTokenClassification.from_pretrained(model_name, local_files_only=local_only)
  device = resolve_pipeline_device(device_name)
  return pipeline(
    'token-classification',
    model=model,
    tokenizer=tokenizer,
    aggregation_strategy='simple',
    device=device,
    batch_size=max(1, batch_size),
  )


def token_normal_forms(token_text: str, morph) -> set[str]:
  return {parse.normal_form for parse in morph.parse(token_text)}


def is_kinship_lemma(lemma: str) -> bool:
  return lemma in KINSHIP_LEMMAS or any(pattern.fullmatch(lemma) for pattern in KINSHIP_PATTERNS)


def is_person_label(label: str) -> bool:
  upper = label.upper()
  return any(hint in upper for hint in PERSON_LABEL_HINTS)


def clean_mention_bounds(text: str, start: int, end: int) -> tuple[int, int]:
  fragment = text[start:end]
  left_trimmed = len(fragment) - len(fragment.lstrip(' \t\r\n"«»„“”()[],:;.!?-'))
  right_trimmed = len(fragment.rstrip(' \t\r\n"«»„“”()[],:;.!?-'))
  clean_start = start + left_trimmed
  clean_end = start + right_trimmed
  return clean_start, max(clean_start, clean_end)


def is_word_char(char: str) -> bool:
  return bool(re.fullmatch(r'[A-Za-zА-ЯЁа-яё-]', char))


def expand_left_to_word_boundary(text: str, start: int) -> int:
  while start > 0 and is_word_char(text[start - 1]):
    start -= 1
  return start


def expand_right_to_word_boundary(text: str, end: int) -> int:
  while end < len(text) and is_word_char(text[end]):
    end += 1
  while end < len(text) and text[end] == '[':
    closing = text.find(']', end + 1)
    if closing < 0:
      break
    end = closing + 1
  return end


def is_person_like_token(token_text: str, morph) -> bool:
  if not WORD_RE.fullmatch(token_text):
    return False

  bare = token_text.strip('-')
  if len(bare) < 2:
    return False

  parses = morph.parse(bare)
  for parse in parses[:4]:
    if {'Name', 'Surn', 'Patr'} & parse.tag.grammemes:
      return True

  if not bare[:1].isupper():
    return False

  lemmas = {parse.normal_form for parse in parses[:4]}
  return not bool(lemmas & NON_PERSON_LEMMAS)


def refine_person_mention_bounds(text: str, start: int, end: int, morph) -> tuple[int, int]:
  start, end = clean_mention_bounds(text, start, end)
  if start >= end:
    return start, end

  start = expand_left_to_word_boundary(text, start)
  end = expand_right_to_word_boundary(text, end)
  fragment = text[start:end]
  tokens = list(TOKEN_RE.finditer(fragment))
  valid_indexes = [
    index
    for index, token in enumerate(tokens)
    if is_person_like_token(token.group(0), morph)
  ]
  if not valid_indexes:
    return clean_mention_bounds(text, start, end)

  refined_start = start + tokens[valid_indexes[0]].start()
  refined_end = start + tokens[valid_indexes[-1]].end()
  refined_end = expand_right_to_word_boundary(text, refined_end)
  return clean_mention_bounds(text, refined_start, refined_end)


def extract_person_mentions_from_predictions(text: str, predictions: list[dict[str, Any]], morph) -> list[Mention]:
  raw_mentions: list[Mention] = []
  for index, item in enumerate(predictions):
    label = str(item.get('entity_group') or item.get('entity') or '')
    if not is_person_label(label):
      continue

    start, end = refine_person_mention_bounds(text, int(item['start']), int(item['end']), morph)
    fragment = normalize_whitespace(text[start:end])
    if len(fragment) < 2:
      continue
    if not any(is_person_like_token(token.group(0), morph) for token in TOKEN_RE.finditer(fragment)):
      continue

    raw_mentions.append(
      Mention(
        id=f'P{index + 1:04d}',
        kind='name',
        text=fragment,
        start=start,
        end=end,
        source='hf_token_classification',
        confidence=float(item.get('score', 0.0)),
        extra={'label': label},
      ),
    )

  if not raw_mentions:
    return []

  merged: list[Mention] = []
  for mention in sorted(raw_mentions, key=lambda item: (item.start, item.end)):
    if not merged:
      merged.append(mention)
      continue

    previous = merged[-1]
    gap = text[previous.end:mention.start]
    mergeable_gap = gap and not re.search(r'[^\s()\[\]-]', gap)
    if not mergeable_gap:
      merged.append(mention)
      continue

    start, end = refine_person_mention_bounds(text, previous.start, mention.end, morph)
    merged[-1] = Mention(
      id=previous.id,
      kind='name',
      text=normalize_whitespace(text[start:end]),
      start=start,
      end=end,
      source=previous.source,
      confidence=max(previous.confidence, mention.confidence),
      extra=previous.extra,
    )

  return merged


def extract_person_mentions(text: str, ner_pipe, morph) -> list[Mention]:
  return extract_person_mentions_from_predictions(text, ner_pipe(text), morph)


def consume_bracket_group(tokens: list[tuple[str, int, int]], index: int) -> tuple[int, int] | None:
  if index >= len(tokens) or tokens[index][0] != '[':
    return None
  for candidate in range(index + 1, min(len(tokens), index + 5)):
    if tokens[candidate][0] == ']':
      return tokens[candidate][2], candidate + 1
  return None


def extract_kinship_mentions(text: str, morph) -> list[Mention]:
  tokens = [(match.group(0), match.start(), match.end()) for match in TOKEN_RE.finditer(text)]
  mentions: list[Mention] = []
  index = 0

  while index < len(tokens):
    token_text, token_start, token_end = tokens[index]
    if not WORD_RE.fullmatch(token_text):
      index += 1
      continue

    lemmas = token_normal_forms(token_text, morph)
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
      left_lemmas = token_normal_forms(left_text, morph)
      if not any(lemma in KINSHIP_MODIFIER_LEMMAS for lemma in left_lemmas):
        break
      start = left_start
      modifier_budget -= 1
      left -= 1

    right = index + 1
    name_budget = 4
    while right < len(tokens) and name_budget > 0:
      bracket_group = consume_bracket_group(tokens, right)
      if bracket_group is not None:
        end, right = bracket_group
        continue

      right_text, _, right_end = tokens[right]
      if right_text in {'(', ')'}:
        end = right_end
        right += 1
        continue
      if not WORD_RE.fullmatch(right_text):
        break
      if not is_person_like_token(right_text, morph):
        break

      end = right_end
      right += 1
      name_budget -= 1

    start, end = clean_mention_bounds(text, start, end)
    mentions.append(
      Mention(
        id=f'K{len(mentions) + 1:04d}',
        kind='kinship',
        text=normalize_whitespace(text[start:end]),
        start=start,
        end=end,
        source='lemma_kinship',
        confidence=0.7,
        extra={'lemma': matched_lemma},
      ),
    )
    index = max(index + 1, right)

  return mentions


def remove_overlaps(mentions: list[Mention]) -> list[Mention]:
  accepted: list[Mention] = []
  for mention in sorted(mentions, key=lambda item: (item.start, -(item.end - item.start), item.kind)):
    overlap = next(
      (
        item for item in accepted
        if item.kind == mention.kind and mention.start < item.end and mention.end > item.start
      ),
      None,
    )
    if overlap is None:
      accepted.append(mention)
      continue

    current_score = (mention.end - mention.start, mention.confidence)
    overlap_score = (overlap.end - overlap.start, overlap.confidence)
    if current_score > overlap_score:
      accepted.remove(overlap)
      accepted.append(mention)

  return sorted(accepted, key=lambda item: (item.start, item.end))


def build_block_payload(block: TextBlock, ner_pipe, morph) -> dict[str, Any]:
  mentions = remove_overlaps([
    *extract_person_mentions(block.text, ner_pipe, morph),
    *extract_kinship_mentions(block.text, morph),
  ])
  return {
    'index': block.index,
    'kind': block.kind,
    'text': block.text,
    'mentions': [asdict(mention) for mention in mentions],
  }


def build_document_payload(entry: dict[str, str], ner_pipe, morph) -> dict[str, Any]:
  blocks = extract_blocks(entry)
  ner_predictions = ner_pipe([block.text for block in blocks]) if blocks else []
  payload_blocks = []
  for block, predictions in zip(blocks, ner_predictions):
    mentions = remove_overlaps([
      *extract_person_mentions_from_predictions(block.text, predictions, morph),
      *extract_kinship_mentions(block.text, morph),
    ])
    payload_blocks.append({
      'index': block.index,
      'kind': block.kind,
      'text': block.text,
      'mentions': [asdict(mention) for mention in mentions],
    })
  mention_count = sum(len(block['mentions']) for block in payload_blocks)
  return {
    'document_id': entry['id'],
    'title': entry.get('title') or entry['id'],
    'source_type': entry['type'],
    'source_path': entry['path'],
    'generated_at': datetime.now(UTC).isoformat(),
    'extractor': {
      'name': 'hf-ner-mentions-only',
      'model': getattr(getattr(ner_pipe, 'model', None), 'name_or_path', 'unknown'),
      'kinship_source': 'lemma_kinship',
      'device': str(getattr(ner_pipe, 'device', 'unknown')),
    },
    'block_count': len(payload_blocks),
    'mention_count': mention_count,
    'blocks': payload_blocks,
  }


def write_payload(payload: dict[str, Any], output_dir: Path) -> Path:
  output_dir.mkdir(parents=True, exist_ok=True)
  target_path = output_dir / f"{payload['document_id']}.json"
  target_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
  return target_path


def main() -> None:
  args = parse_args()
  entries = load_manifest_entries()
  if args.document_id:
    entries = [entry for entry in entries if str(entry.get('id')) == args.document_id]
    if not entries:
      raise RuntimeError(f'Document {args.document_id} was not found in manifest.')

  ner_pipe = build_ner_pipeline(
    args.model,
    local_only=args.local_only,
    device_name=args.device,
    batch_size=args.batch_size,
  )
  morph = pymorphy2.MorphAnalyzer()
  output_dir = Path(args.output_dir)

  summary: list[dict[str, Any]] = []
  for entry in entries:
    payload = build_document_payload(entry, ner_pipe, morph)
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
