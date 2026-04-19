from __future__ import annotations

import shutil
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT_DIR / '.pages-build'

ROOT_FILES = (
  'index.html',
  'edit.html',
  'documents.html',
  'styles.css',
  'structure.yaml',
)

ROOT_DIRS = (
  'js',
)

DATA_DIRS = (
  'people',
  'text_processing',
)

TEXT_DOCUMENTS_DIR = Path('data') / 'sources' / 'text_documents'


def reset_output_dir() -> None:
  if OUTPUT_DIR.exists():
    shutil.rmtree(OUTPUT_DIR)
  OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def copy_file(relative_path: str | Path) -> None:
  source = ROOT_DIR / relative_path
  target = OUTPUT_DIR / relative_path
  target.parent.mkdir(parents=True, exist_ok=True)
  shutil.copy2(source, target)


def copy_tree(relative_path: str | Path) -> None:
  source = ROOT_DIR / relative_path
  target = OUTPUT_DIR / relative_path
  shutil.copytree(source, target)


def main() -> None:
  reset_output_dir()

  for file_name in ROOT_FILES:
    copy_file(file_name)

  for dir_name in ROOT_DIRS:
    copy_tree(dir_name)

  for dir_name in DATA_DIRS:
    copy_tree(Path('data') / dir_name)

  if (ROOT_DIR / TEXT_DOCUMENTS_DIR).exists():
    copy_tree(TEXT_DOCUMENTS_DIR)

  print(f'Pages publish directory ready: {OUTPUT_DIR}')


if __name__ == '__main__':
  main()
