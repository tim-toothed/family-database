from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Iterable


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE = 'family-db'
DEFAULT_YDB_BIN = Path.home() / 'ydb' / 'bin' / ('ydb.exe' if os.name == 'nt' else 'ydb')


def find_ydb_bin(explicit_path: str | None = None) -> str:
  if explicit_path:
    return str(Path(explicit_path).expanduser())

  env_path = os.environ.get('YDB_BIN')
  if env_path:
    return str(Path(env_path).expanduser())

  found = shutil.which('ydb')
  if found:
    return found

  if DEFAULT_YDB_BIN.exists():
    return str(DEFAULT_YDB_BIN)

  raise RuntimeError('Не найден ydb CLI. Укажите --ydb-bin или переменную YDB_BIN.')


def sql_quote(value: object) -> str:
  return "'" + str(value).replace("'", "''") + "'"


def raw_string(value: object) -> str:
  return '@@' + str(value).replace('@@', '@@@@') + '@@'


def utf8_literal(value: object) -> str:
  return f'Utf8({raw_string(value)})'


def json_literal(value: object) -> str:
  payload = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
  return f'Json({raw_string(payload)})'


def run_ydb(
  args: Iterable[str],
  *,
  profile: str = DEFAULT_PROFILE,
  ydb_bin: str | None = None,
  cwd: Path = ROOT_DIR,
) -> str:
  command = [find_ydb_bin(ydb_bin), '-p', profile, *args]
  result = subprocess.run(
    command,
    cwd=str(cwd),
    check=False,
    encoding='utf-8',
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
  )
  if result.returncode:
    details = '\n'.join(part for part in [result.stdout, result.stderr] if part)
    raise RuntimeError(details or f'ydb exited with code {result.returncode}')
  return result.stdout


def run_yql_file(path: Path, *, profile: str, ydb_bin: str | None = None) -> None:
  run_ydb(['scripting', 'yql', '--file', str(path)], profile=profile, ydb_bin=ydb_bin)


def fetch_yql_json(script: str, *, profile: str, ydb_bin: str | None = None) -> list[dict[str, object]]:
  output = run_ydb(
    ['scripting', 'yql', '--script', script, '--format', 'json-unicode-array'],
    profile=profile,
    ydb_bin=ydb_bin,
  )
  parsed = json.loads(output or '[]')
  if not isinstance(parsed, list):
    raise RuntimeError('YDB вернул неожиданный JSON-ответ.')
  return parsed
