# family-db-tools-api

Python Cloud Function для NLP-инструментов поверх документов в YDB.

## Runtime

- Runtime: Python 3.12+
- Handler: `index.handler`
- Function URL: `https://functions.yandexcloud.net/d4euqsp0kr657a0iajvb`

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
```

В Cloud Functions лучше привязать service account к функции и дать ему `ydb.editor`.

## Endpoints

```text
GET  /health
POST /documents/{documentId}/ner
```

Тело `POST /documents/{documentId}/ner` опционально:

```json
{
  "includeNames": true,
  "includeKinship": true
}
```

Функция читает уже распакованные блоки из `text_document_blocks`, строит mentions и перезаписывает `text_document_mentions` для документа.
