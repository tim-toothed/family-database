# Семейное древо

Статический сайт для просмотра семейной базы данных. Проект показывает родственные связи в нескольких визуальных режимах, даёт табличное представление людей, открывает подробную карточку выбранного человека и включает отдельную страницу редактора, работающую через Supabase.

Сайт рассчитан на запуск без сборщика и может публиковаться как обычный статический проект, например на GitHub Pages.

## Что умеет проект

- строить дерево от выбранного человека;
- переключать визуализацию между режимами `Дерево`, `Радиальная` и `Панорама`;
- переключаться между графом и таблицей;
- показывать подробную карточку человека в боковой панели;
- открывать редактор карточки с главной страницы;
- отображать людей в таблице с сортировкой и группировкой по семьям;
- загружать данные из YAML-файлов через `data/people/index.json`;
- локально падать обратно на чтение директории `data/people/`, если манифест недоступен;
- создавать и редактировать карточки через Supabase на странице `edit.html`.

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
- `js-yaml` для чтения YAML в браузере;
- `d3` для всех графических режимов;
- `@supabase/supabase-js` на странице редактора;
- `Python` только для генерации манифеста `data/people/index.json`.

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
`-- data/
    |-- people/
    |   |-- P001.yaml
    |   |-- P002.yaml
    |   |-- ...
    |   |-- index.json
    |   `-- build_manifest.py
    `-- sources/
```

## Как устроены данные

Каждый человек хранится в отдельном YAML-файле `data/people/PXXX.yaml`, где `PXXX` — уникальный ID.

В проекте используются, в частности, такие поля:

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

Логика такая:

1. Сначала сайт пытается прочитать `data/people/index.json`.
2. Если манифест недоступен, локально пробует получить список YAML-файлов из директории `data/people/`.
3. Затем загружает все найденные `PXXX.yaml`.
4. Собирает `dataset`, индекс имён, данные для таблицы и семейные группы.

Для GitHub Pages нужно ориентироваться именно на актуальный `data/people/index.json`.

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

Редактор умеет:

- загрузить индекс людей;
- открыть существующую карточку;
- создать новую карточку;
- сохранить нормализованный payload обратно в Supabase.

Важно: главная страница читает YAML из `data/people/`, а редактор работает с Supabase. Если данные в Supabase и YAML расходятся, интерфейсы будут показывать разное состояние.

## Обновление данных

Когда добавляется, удаляется или переименовывается файл в `data/people/`, нужно обновить манифест:

```powershell
python data\people\build_manifest.py
```

Скрипт пересоберёт `data/people/index.json` по текущим файлам `P*.yaml`.

Рекомендуемый порядок работы:

1. Изменить YAML-файлы в `data/people/`.
2. Запустить `python data\people\build_manifest.py`.
3. Проверить сайт локально.
4. Закоммитить YAML и обновлённый `index.json`.
5. Задеплоить статическую версию.

## NLP для документов

Для страницы `documents.html` можно заранее построить автоentity для текстовых документов:

```powershell
python -m pip install -r requirements-text-entities.txt
python scripts\build_text_document_entities.py
```

Скрипт читает `data/sources/text_documents/index.json`, извлекает блоки текста из `markdown` и `docx`, ищет имена через `Natasha`, добавляет родственные упоминания по словарным правилам и сохраняет результат в `data/sources/text_documents/entities/`.

После этого `documents.html` подхватывает готовые JSON-файлы и показывает авто-подсветку entity поверх текста.

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
- `styles.css`
- папка `js/`
- папка `data/`

Проверь перед деплоем:

- что `data/people/index.json` актуален;
- что все нужные `PXXX.yaml` попали в репозиторий;
- что CDN-скрипты доступны;
- что ссылки на `edit.html` и статические ресурсы открываются корректно.

Если после публикации сайт пустой, сначала проверь:

- существует ли `data/people/index.json` в опубликованной версии;
- перечислены ли в нём все нужные `PXXX`;
- доступны ли сами файлы `data/people/PXXX.yaml`.

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
