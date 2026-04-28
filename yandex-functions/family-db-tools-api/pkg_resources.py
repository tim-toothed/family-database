from __future__ import annotations

import importlib
from dataclasses import dataclass
from pathlib import Path


class Requirement:
  @staticmethod
  def parse(value):
    return str(value).split('>=', 1)[0].split('==', 1)[0].strip()


def _package_name(package_or_requirement) -> str:
  value = str(package_or_requirement)
  return value.split('>=', 1)[0].split('==', 1)[0].strip().replace('-', '_')


def resource_filename(package_or_requirement, resource_name: str) -> str:
  package_name = _package_name(package_or_requirement)
  module = importlib.import_module(package_name)
  module_path = Path(module.__file__ or '').resolve()
  return str(module_path.parent / resource_name)


def resource_stream(package_or_requirement, resource_name: str):
  return open(resource_filename(package_or_requirement, resource_name), 'rb')


@dataclass(slots=True)
class Distribution:
  project_name: str
  version: str = '0'


@dataclass(slots=True)
class EntryPoint:
  name: str
  module_name: str

  def load(self):
    return importlib.import_module(self.module_name)


class WorkingSet:
  def __iter__(self):
    return iter(())

  def find(self, requirement):
    return Distribution(project_name=_package_name(requirement))

  def require(self, *requirements):
    return [Distribution(project_name=_package_name(requirement)) for requirement in requirements]

  def iter_entry_points(self, group: str, name: str | None = None):
    if group != 'pymorphy2_dicts':
      return iter(())

    candidates = [
      EntryPoint('ru', 'pymorphy2_dicts_ru'),
      EntryPoint('ru', 'pymorphy2_dicts'),
    ]

    available = []
    for entry_point in candidates:
      if name and entry_point.name != name:
        continue
      try:
        importlib.import_module(entry_point.module_name)
      except ImportError:
        continue
      available.append(entry_point)
      break

    return iter(available)


working_set = WorkingSet()


def iter_entry_points(group: str, name: str | None = None):
  return working_set.iter_entry_points(group, name)


def require(*requirements):
  return working_set.require(*requirements)


def get_distribution(requirement):
  return working_set.find(requirement)


def parse_version(value):
  return tuple(int(part) if part.isdigit() else part for part in str(value).replace('-', '.').split('.'))
