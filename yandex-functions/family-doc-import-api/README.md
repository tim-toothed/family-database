# family-doc-import-api

Python Cloud Function для импорта документов в YDB.

## Runtime

- Runtime: Python 3.12+
- Handler: `index.handler`

## Environment

Обязательные переменные:

```text
YDB_CONNECTION_STRING=grpcs://ydb.serverless.yandexcloud.net:2135/<database-path>
YDB_METADATA_CREDENTIALS=1
```

Опциональные переменные:

```text
FAMILY_DB_API_TOKEN=<shared-api-token>
CORS_ORIGIN=https://your-site.example
YDB_ACCESS_TOKEN=<iam-token-for-local-debug-or-manual-auth>
MAX_UPLOAD_BYTES=8388608
```

## Endpoints

Yandex Cloud Functions прокидывает route через query string так же, как `family-db-api`:

```text
GET  /health
POST /documents/import
```

Тело `POST /documents/import`:

```json
{
  "filename": "notes.docx",
  "contentBase64": "...",
  "title": "Записи",
  "description": ""
}
```

Поддерживаемые форматы: `.txt`, `.md`, `.markdown`, `.docx`, `.pdf`.

Функция сохраняет документ, блоки и очищает старые mentions для такого же `document_id`. NLP-mentions добавляются отдельной функцией.
