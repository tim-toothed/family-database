from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT_DIR / '.env'
DEFAULT_DATABASE_NAME = 'family-tree-db'
ANSI_ESCAPE_RE = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')


def parse_env_file(path: Path) -> dict[str, str]:
  values: dict[str, str] = {}

  if not path.exists():
    return values

  for raw_line in path.read_text(encoding='utf-8').splitlines():
    line = raw_line.strip()
    if not line or line.startswith('#') or '=' not in line:
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


def get_database_name(cli_value: str | None = None) -> str:
  if cli_value:
    return cli_value.strip()

  env_values = parse_env_file(ENV_PATH)
  configured = (
    env_values.get('cloudflareD1Database')
    or env_values.get('CLOUDFLARE_D1_DATABASE')
  )
  return (configured or DEFAULT_DATABASE_NAME).strip()


def build_location_args(*, remote: bool) -> list[str]:
  return ['--remote'] if remote else ['--local']


def extract_json_payload(stdout: str) -> str:
  cleaned = ANSI_ESCAPE_RE.sub('', stdout or '').strip()
  if not cleaned:
    raise RuntimeError('Wrangler не вернул JSON-ответ.')

  decoder = json.JSONDecoder()
  for index, char in enumerate(cleaned):
    if char not in '[{':
      continue
    try:
      _, end = decoder.raw_decode(cleaned[index:])
      return cleaned[index:index + end]
    except json.JSONDecodeError:
      continue

  raise RuntimeError(
    'Не удалось найти JSON-блок в ответе Wrangler.\n'
    f'STDOUT:\n{stdout}'
  )


def run_wrangler_d1(
  command_args: list[str],
  *,
  expect_json: bool = False,
) -> object:
  npx_command = 'npx.cmd' if os.name == 'nt' else 'npx'
  command = [npx_command, 'wrangler', 'd1', *command_args]
  if expect_json and '--json' not in command:
    command.append('--json')

  completed = subprocess.run(
    command,
    cwd=ROOT_DIR,
    capture_output=True,
    text=True,
    encoding='utf-8',
  )

  if completed.returncode != 0:
    message_parts = [f'Команда завершилась с кодом {completed.returncode}: {" ".join(command)}']
    if completed.stdout.strip():
      message_parts.append(completed.stdout.strip())
    if completed.stderr.strip():
      message_parts.append(completed.stderr.strip())
    raise RuntimeError('\n'.join(message_parts))

  if not expect_json:
    return completed.stdout

  try:
    return json.loads(extract_json_payload(completed.stdout))
  except json.JSONDecodeError as exc:
    raise RuntimeError(
      'Не удалось разобрать JSON-ответ Wrangler.\n'
      f'STDOUT:\n{completed.stdout}\n\nSTDERR:\n{completed.stderr}'
    ) from exc


def print_hint(message: str) -> None:
  print(message, file=sys.stderr)
