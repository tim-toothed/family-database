# Семейное древо

Статический сайт для просмотра семейной базы данных. Проект показывает родственные связи в нескольких визуальных режимах, даёт табличное представление людей, открывает подробную карточку выбранного человека и включает отдельную страницу редактора, работающую через Supabase.

Сайт рассчитан на запуск без сборщика и может публиковаться как обычный статический проект, например на GitHub Pages. Персональные данные не должны храниться в публичном репозитории: продовый режим читает их из Supabase, а локальная папка `data/` используется только как приватный рабочий каталог для импорта и обработки.

## Что умеет проект

- строить дерево от выбранного человека;
- переключать визуализацию между режимами `Дерево`, `Радиальная` и `Панорама`;
- переключаться между графом и таблицей;
- показывать подробную карточку человека в боковой панели;
- открывать редактор карточки с главной страницы;
- отображать людей в таблице с сортировкой и группировкой по семьям;
- загружать людей и документы из Supabase;
- создавать и редактировать карточки через Supabase на странице `edit.html`;
- использовать приватные локальные файлы `data/` для подготовки импорта и будущего offline-архива.

## Страницы

### `index.html`

Основная страница просмотра базы:

- выбор человека, от которого строится дерево;
- вкладки `Граф` и `Таблица`;
- меню выбора типа визуализации в правом верхнем углу графа;
- боковая панель с карточкой выбранного человека;
- кнопка перехода в редактор карточки.

### `edit.html`

Отдельная страница редактора:

- переход к существующей карточке через dropdown;
- создание новой карточки;
- редактирование полей по схеме;
- сохранение в Supabase;
- базовая валидация и предупреждение о несохранённых изменениях.

## Стек

- `HTML` + `CSS` + `JavaScript` без сборщика;
- `js-yaml` для legacy/local YAML-режима;
- `d3` для всех графических режимов;
- `@supabase/supabase-js` для чтения и редактирования данных;
- `Python` для локальной подготовки данных и импорта в Supabase.

## Структура проекта

```text
.
|-- index.html
|-- edit.html
|-- styles.css
|-- README.md
|-- js/
|   |-- app.js
|   |-- config.js
|   |-- editor/
|   |   |-- editor-page.js
|   |   |-- person-editor.js
|   |   `-- supabase-editor-store.js
|   |-- render/
|   |   |-- data-loader.js
|   |   |-- person-name.js
|   |   `-- renderers.js
|   `-- visualization/
|       |-- family-colors.js
|       |-- graph.js
|       |-- graph-ancestral.js
|       |-- graph-panorama.js
|       |-- graph-radial.js
|       |-- graph-shared.js
|       |-- graph_old.js
|       |-- table-family-groups.js
|       `-- table-view.js
|-- scripts/
`-- supabase/
```

## Как устроены данные

В продовом режиме данные хранятся в Supabase в схеме `family_site`.

Основные таблицы:

- `family_yaml` — нормализованные карточки людей в JSONB;
- `family_people` — индекс отображаемых имён;
- `text_documents` — метаданные текстовых документов;
- `text_document_blocks` — блоки текста документов;
- `text_document_mentions` — найденные имена и родственные упоминания.

Локальная папка `data/` может существовать на рабочей машине, но она добавлена в `.gitignore` и не должна попадать в публичный репозиторий.

В карточках людей используются, в частности, такие поля:

- `id`
- `birth_name`
- `name_changes`
- `sex`
- `birth`
- `death`
- `parents`
- `siblings`
- `spouses`
- `children`
- `education`
- `class_title`
- `religion`
- `nationality`
- `profession`
- `job_places`
- `military`
- `residences`
- `hobbies`
- `character`
- `appearance`
- `health`
- `other_info`
- `sources`
- `media`

Отображаемые подписи и порядок секций задаются в [js/config.js](js/config.js).

## Как загружаются данные

Главная точка входа загрузки — [js/render/data-loader.js](js/render/data-loader.js).

Источник данных задаётся в [js/config.js](js/config.js) через `CONFIG.dataSource`:

- `supabase` — продовый режим: грузить только Supabase и показывать ошибку, если он недоступен;
- `auto` — сначала попробовать Supabase, а если он недоступен, загрузить локальные файлы из приватной `data/`;
- `local` — всегда грузить локальные файлы из приватной `data/`.

По умолчанию используется `supabase`, чтобы опубликованный сайт не зависел от `data/` в репозитории.

Legacy/local fallback всё ещё может читать `data/people/index.json` и YAML-файлы, если они есть на локальной машине.

Для быстрой проверки можно временно переопределить источник через URL: `?source=local`, `?source=supabase` или `?source=auto`.

## Визуализации

На главной странице доступны три режима:

- `Дерево` — древовидная ancestor-визуализация;
- `Радиальная` — радиальная диаграмма поколений;
- `Панорама` — семейные блоки и поколения в более обзорной раскладке.

Маршрутизация между режимами находится в [js/visualization/graph.js](js/visualization/graph.js), общие настройки — в [js/visualization/graph-shared.js](js/visualization/graph-shared.js).

## Таблица

Табличный режим строится из подготовленного dataset и поддерживает:

- сортировку по поколениям и алфавиту;
- группировку по семьям;
- подсветку выбранного человека;
- быстрый переход между таблицей, графом и карточкой.

Основная логика находится в [js/visualization/table-view.js](js/visualization/table-view.js) и [js/visualization/table-family-groups.js](js/visualization/table-family-groups.js).

## Редактор и Supabase

Редактор открывается на странице `edit.html` и использует Supabase как источник и место сохранения редактируемых карточек.

Работа с Supabase реализована в [js/editor/supabase-editor-store.js](js/editor/supabase-editor-store.js).

Сайт использует минимальную авторизацию через Supabase Auth. При первом входе нужно ввести email и пароль существующего пользователя Supabase. Сессия сохраняется в браузере через Supabase client, поэтому повторно вводить пароль обычно не нужно.

Для закрытого семейного режима:

1. Создай пользователя в Supabase Auth.
2. Примени [supabase/schema.sql](supabase/schema.sql), чтобы RLS policies разрешали чтение только роли `authenticated`.
3. Оставь `CONFIG.requireAuth = true` в [js/config.js](js/config.js).
4. В Supabase Dashboard отключи публичную самостоятельную регистрацию, если она не нужна.

Редактор умеет:

- загрузить индекс людей;
- открыть существующую карточку;
- создать новую карточку;
- сохранить нормализованный payload обратно в Supabase.

Важно: в режиме `auto` главная страница обычно читает Supabase, а локальные YAML используются как резервная копия. Если данные в Supabase и YAML расходятся, локальный fallback может показывать более старое состояние.

## Обновление данных

Основной поток обновления данных:

```powershell
python supabase\import_documents_to_supabase.py
```

Для людей используется импорт YAML в Supabase, для документов — [supabase/import_documents_to_supabase.py](supabase/import_documents_to_supabase.py). Локальные файлы `data/` остаются приватным источником подготовки и не коммитятся.

Если нужно проверить старый локальный режим, временно используй `?source=local`.

## NLP для документов

Для страницы `documents.html` можно заранее построить автоentity для текстовых документов:

```powershell
python -m pip install -r requirements-text-entities.txt
python scripts\build_text_entities_ver2.py
```

Скрипт читает приватный локальный `data/docs_processed/index.json`, извлекает блоки текста из `markdown` и `docx`, ищет имена и родственные упоминания, затем сохраняет результат в `data/docs_processed/entities/`.

После этого данные импортируются в Supabase, а `documents.html` читает их из таблиц `text_documents`, `text_document_blocks` и `text_document_mentions`.

## Локальный запуск

Открывать `index.html` или `edit.html` через `file://` не стоит: браузер блокирует `fetch` локальных файлов и CDN-импортов.

Самый простой вариант:

```powershell
python -m http.server 8000
```

После этого открой:

```text
http://localhost:8000/
```

Главная страница будет доступна по `/`, редактор — по `/edit.html`.

## Деплой на GitHub Pages

Для публикации нужны:

- `index.html`
- `edit.html`
- `documents.html`
- `styles.css`
- папка `js/`
- настройки Supabase в [js/config.js](js/config.js)

Проверь перед деплоем:

- что таблицы Supabase созданы через [supabase/schema.sql](supabase/schema.sql);
- что люди и документы импортированы в Supabase;
- что CDN-скрипты доступны;
- что ссылки на `edit.html` и статические ресурсы открываются корректно.

Если после публикации сайт пустой, сначала проверь:

- доступен ли Supabase;
- корректны ли `SUPABASE_CONFIG.url`, `publishableKey`, `schema` и названия таблиц;
- включены ли нужные RLS policy/grant для роли `authenticated`;
- есть ли активная Supabase Auth-сессия в браузере.

## Что за что отвечает

- [js/app.js](js/app.js) управляет главной страницей, вкладками, выбором корневого человека и переключением визуализаций.
- [js/render/data-loader.js](js/render/data-loader.js) загружает манифест, YAML и собирает dataset.
- [js/render/renderers.js](js/render/renderers.js) рендерит карточку человека.
- [js/render/person-name.js](js/render/person-name.js) формирует отображаемые имена.
- [js/visualization/graph.js](js/visualization/graph.js) выбирает нужный графический режим.
- [js/visualization/graph-ancestral.js](js/visualization/graph-ancestral.js) содержит древовидную визуализацию.
- [js/visualization/graph-radial.js](js/visualization/graph-radial.js) содержит радиальную визуализацию.
- [js/visualization/graph-panorama.js](js/visualization/graph-panorama.js) содержит панорамную визуализацию.
- [js/visualization/table-view.js](js/visualization/table-view.js) отвечает за табличный режим.
- [js/visualization/table-family-groups.js](js/visualization/table-family-groups.js) готовит группировку по семьям.
- [js/visualization/family-colors.js](js/visualization/family-colors.js) строит цветовые темы семейных групп.
- [js/editor/editor-page.js](js/editor/editor-page.js) управляет страницей редактора.
- [js/editor/person-editor.js](js/editor/person-editor.js) строит поля формы, валидацию и UI редактора.
- [js/editor/supabase-editor-store.js](js/editor/supabase-editor-store.js) работает с Supabase.
