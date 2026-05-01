# family-db-api

HTTP API для Yandex Cloud Functions поверх YDB.

## Runtime

- Runtime: Node.js 22
- Handler: `index.handler`
- Function URL: `https://functions.yandexcloud.net/d4ebrmtiseqef31cdo03`

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

Если `FAMILY_DB_API_TOKEN` задан, все endpoints, кроме `OPTIONS`, требуют:

```text
Authorization: Bearer <shared-api-token>
```

В Cloud Functions предпочтительно привязать service account к функции и дать ему права на YDB. Тогда `YDB_ACCESS_TOKEN` не нужен.

## Endpoints

```text
GET  /health
GET  /people
GET  /people-index
GET  /people/{personId}
PUT  /people/{personId}
POST /people/{personId}
GET  /documents
GET  /documents/{documentId}
DELETE /documents/{documentId}
GET  /documents/{documentId}/chunk?from=0&chunkSize=200
GET  /agent/jobs?limit=20
POST /agent/jobs
GET  /agent/jobs/{jobId}
POST /agent/jobs/{jobId}/status
POST /agent/jobs/{jobId}/events
POST /agent/jobs/{jobId}/changes
```

`PUT /people/{personId}` обновляет существующую карточку. `POST /people/{personId}` создает или перезаписывает карточку.
`/agent/*` хранит временную историю AI-задач, событий и AI-изменений карточек; ручные правки редактора туда не пишутся.

## Schema

Перед использованием применить `schema.yql` к YDB через WebSQL или YDB CLI.

```bash
ydb -e grpcs://ydb.serverless.yandexcloud.net:2135 -d /<database-path> scripting yql --file schema.yql
```

## Import / Export

Из корня репозитория:

```bash
python yandex-functions/import_yaml_to_ydb.py --profile family-db
python yandex-functions/import_documents_to_ydb.py --profile family-db
python yandex-functions/export_ydb_to_yaml.py --profile family-db
```

Для проверки сайта через Yandex API можно открыть страницу с query-параметром:

```text
?source=yandex
```

Для постоянного переключения поменяйте `CONFIG.dataSource` в `js/config.js` на `yandex`.
