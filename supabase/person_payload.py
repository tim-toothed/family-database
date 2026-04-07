from __future__ import annotations

from copy import deepcopy
import re


DATE_TRIPLET_RE = re.compile(r'([A-Za-z?0-9]{1,3})\.([A-Za-z?0-9]{1,3})\.([A-Za-z?0-9]{1,4})')
DROP_VALUE = object()


def _is_object(value: object) -> bool:
  return isinstance(value, dict)


def _as_text(value: object) -> str:
  return str(value or '').strip()


def _normalize_numeric_part(value: object, max_length: int) -> int | None:
  text = _as_text(value)
  if not text or re.fullmatch(r'[dmy?]+', text, flags=re.IGNORECASE):
    return None
  if not re.fullmatch(rf'\d{{1,{max_length}}}', text):
    return None
  return int(text)


def migrate_date_value(value: object) -> dict[str, int] | None:
  if value is None:
    return None

  if isinstance(value, dict):
    day = _normalize_numeric_part(value.get('day'), 2)
    month = _normalize_numeric_part(value.get('month'), 2)
    year = _normalize_numeric_part(value.get('year'), 4)
    result: dict[str, int] = {}
    if day is not None:
      result['day'] = day
    if month is not None:
      result['month'] = month
    if year is not None:
      result['year'] = year
    return result

  text = _as_text(value)
  if not text:
    return {}

  match = DATE_TRIPLET_RE.search(text)
  if match:
    day = _normalize_numeric_part(match.group(1), 2)
    month = _normalize_numeric_part(match.group(2), 2)
    year = _normalize_numeric_part(match.group(3), 4)
    result: dict[str, int] = {}
    if day is not None:
      result['day'] = day
    if month is not None:
      result['month'] = month
    if year is not None:
      result['year'] = year
    return result

  if re.fullmatch(r'\d{4}', text):
    return {'year': int(text)}

  return {}


def _migrate_life_event_block(block: object) -> object:
  if not _is_object(block):
    return block

  migrated = dict(block)
  if 'date' in migrated:
    migrated['date'] = None if migrated['date'] is None else migrate_date_value(migrated['date'])
  return migrated


def _migrate_date_entry_block(block: object, key: str = 'date') -> object:
  if not _is_object(block):
    return block

  migrated = dict(block)
  if key in migrated:
    migrated[key] = None if migrated[key] is None else migrate_date_value(migrated[key])
  return migrated


def _migrate_child_relation_block(block: object) -> object:
  if not _is_object(block):
    return block

  migrated = dict(block)
  migrated.pop('birth_date', None)
  migrated.pop('second_parent_id', None)
  return migrated


def _has_date_value(value: object) -> bool:
  if value is None:
    return True
  if not isinstance(value, dict):
    return bool(_as_text(value))
  return any(part in value for part in ('day', 'month', 'year'))


def _migrate_event_list(value: object, legacy_date_value: object, detail_key: str) -> list[dict[str, object]]:
  if isinstance(value, list):
    source_items = value
  elif _is_object(value):
    source_items = [value]
  else:
    source_items = []

  items: list[dict[str, object]] = []
  for raw_item in source_items:
    if not _is_object(raw_item):
      continue
    item = dict(raw_item)
    if 'date' in item:
      item['date'] = None if item['date'] is None else migrate_date_value(item['date'])
    if not _as_text(item.get(detail_key)):
      item.pop(detail_key, None)
    if not _as_text(item.get('place')):
      item.pop('place', None)
    if not _as_text(item.get('other')):
      item.pop('other', None)

    if item.get('date') is None or _has_date_value(item.get('date')) or item.get('place') or item.get('other'):
      items.append(item)

  if items:
    return items

  if legacy_date_value in (None, ''):
    return []

  migrated_date = migrate_date_value(legacy_date_value)
  if not _has_date_value(migrated_date):
    return []

  return [{'date': migrated_date}]


def _normalize_other_info_entry(value: object, fallback_label: str = '') -> dict[str, str] | None:
  if isinstance(value, str):
    text = value.strip()
    if not text:
      return None
    return {
      **({'label': fallback_label} if fallback_label else {}),
      'text': text,
    }

  if not _is_object(value):
    return None

  text = _as_text(value.get('text') or value.get('value') or value.get('content'))
  label = _as_text(value.get('label') or fallback_label)
  if not text:
    return None

  return {
    **({'label': label} if label else {}),
    'text': text,
  }


def _normalize_other_info(value: object) -> list[dict[str, str]]:
  if isinstance(value, list):
    return [
      entry for entry in (_normalize_other_info_entry(item) for item in value)
      if entry is not None
    ]

  if isinstance(value, str):
    entry = _normalize_other_info_entry(value, 'Заметка')
    return [entry] if entry else []

  if not _is_object(value):
    return []

  entries: list[dict[str, str]] = []
  for raw_key, raw_value in value.items():
    fallback_label = '' if str(raw_key).startswith('other_info') else str(raw_key)
    entry = _normalize_other_info_entry(raw_value, fallback_label)
    if entry is not None:
      entries.append(entry)

  return entries


def migrate_person_schema(payload: object, fallback_id: str = '') -> dict[str, object]:
  source = deepcopy(payload) if isinstance(payload, dict) else {}
  source['id'] = _as_text(source.get('id') or fallback_id) or fallback_id

  if _is_object(source.get('birth')):
    source['birth'] = _migrate_life_event_block(source['birth'])

  if _is_object(source.get('death')):
    source['death'] = _migrate_life_event_block(source['death'])

  if isinstance(source.get('name_changes'), list):
    source['name_changes'] = [_migrate_date_entry_block(item, 'date') for item in source['name_changes']]

  if isinstance(source.get('children'), list):
    source['children'] = [_migrate_child_relation_block(item) for item in source['children']]

  if isinstance(source.get('spouses'), list):
    migrated_spouses = []
    for raw_spouse in source['spouses']:
      spouse = dict(raw_spouse) if _is_object(raw_spouse) else {}
      marriage = _migrate_event_list(spouse.get('marriage'), spouse.get('marriage_date'), 'place')
      divorce = _migrate_event_list(spouse.get('divorce'), spouse.get('divorce_date'), 'other')
      spouse.pop('marriage_date', None)
      spouse.pop('divorce_date', None)
      if marriage:
        spouse['marriage'] = marriage
      else:
        spouse.pop('marriage', None)
      if divorce:
        spouse['divorce'] = divorce
      else:
        spouse.pop('divorce', None)
      migrated_spouses.append(spouse)
    source['spouses'] = migrated_spouses

  if 'other_info' in source:
    source['other_info'] = _normalize_other_info(source.get('other_info'))

  return source


def prune_person_schema(value: object, path: tuple[str | int, ...] = ()) -> object | None:
  if isinstance(value, list):
    items = [
      pruned for pruned in (
        prune_person_schema(item, (*path, index))
        for index, item in enumerate(value)
      )
      if pruned is not DROP_VALUE
    ]
    if items:
      return items
    return None if not path else DROP_VALUE

  if isinstance(value, dict):
    ordered: dict[str, object] = {}
    for key, nested_value in value.items():
      pruned = prune_person_schema(nested_value, (*path, key))
      if pruned is not DROP_VALUE:
        ordered[key] = pruned
    if ordered:
      return ordered
    return None if not path else DROP_VALUE

  if value is None:
    return None if path == ('death', 'date') else DROP_VALUE

  if isinstance(value, str) and not value.strip():
    return DROP_VALUE

  return value
