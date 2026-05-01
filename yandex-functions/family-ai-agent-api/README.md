# family-ai-agent-api

Yandex Cloud Function для ИИ-чата семейной базы. Функция сама выполняет agent loop, вызывает DeepSeek API, читает/редактирует карточки через `family-db-api`, обращается к packaged guides и может читать публичные URL.

## Runtime

- Runtime: Node.js 22
- Handler: `index.handler`

## Environment

Обязательные переменные:

```text
FAMILY_DB_API_URL=https://functions.yandexcloud.net/<family-db-api-id>
DEEPSEEK_API_KEY=<deepseek-api-key>
```

Опциональные переменные:

```text
FAMILY_AI_AGENT_API_TOKEN=<shared-api-token>
FAMILY_DB_API_TOKEN=<family-db-api-token>
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
DEEPSEEK_ENABLE_THINKING=true
DEEPSEEK_TIMEOUT_MS=300000
FAMILY_AI_AGENT_TIMEOUT_MS=540000
FAMILY_AI_AGENT_MAX_TOOL_ROUNDS=30
CORS_ORIGIN=https://your-site.example
```

Если `FAMILY_AI_AGENT_API_TOKEN` задан, endpoint требует:

```text
Authorization: Bearer <shared-api-token>
```

Браузерный клиент передает этот же токен query-параметром `apiToken`, чтобы не провоцировать CORS preflight при локальной разработке.

## Active Models

Активный провайдер только один:

```text
deepseek
```

Разрешенные модели:

```text
DeepSeek-V4-Flash
deepseek-v4-pro
```

Запросы к DeepSeek отправляются с `stream: true` и `enable_thinking: true`, если `DEEPSEEK_ENABLE_THINKING` явно не равен `false`.
Стрим сейчас читается внутри функции и собирается в финальный JSON-ответ. Для защиты от platform timeout функция использует `context.getRemainingTimeInMillis()`, soft-timeout `FAMILY_AI_AGENT_TIMEOUT_MS`, timeout одного DeepSeek-вызова `DEEPSEEK_TIMEOUT_MS` и env-настройку tool loop `FAMILY_AI_AGENT_MAX_TOOL_ROUNDS`.

## Endpoints

```text
GET  /health
POST /chat
GET  /chat/jobs?limit=20
POST /chat/jobs
GET  /chat/jobs/{jobId}
POST /chat/jobs/{jobId}/run
```

`POST /chat` оставлен как синхронный fallback. Основной UI использует job flow: создает job, запускает долгий `/run` отдельным запросом и polling-ом читает `/chat/jobs/{jobId}`.

Тело `POST /chat`:

```json
{
  "provider": "deepseek",
  "model": "DeepSeek-V4-Flash",
  "taskType": "person_editing",
  "thinkingMode": "thinking",
  "messages": [
    { "role": "user", "content": "Прочитай P001 и добавь источник ..." }
  ]
}
```

Ответ:

```json
{
  "provider": "deepseek",
  "model": "DeepSeek-V4-Flash",
  "taskType": "person_editing",
  "message": "Готово: ...",
  "toolCalls": [
    { "name": "get_person", "arguments": "{\"person_id\":\"P001\"}", "result": {} }
  ],
  "changes": [
    {
      "personId": "P001",
      "displayName": "Фамилия Имя",
      "changedPaths": ["sources"],
      "beforePayload": {},
      "afterPayload": {}
    }
  ]
}
```

## Code Map

- `index.js` - HTTP entrypoint `/health` и `/chat`.
- `runner.js` - валидация provider/model/task и запуск активного provider.
- `provider-deepseek.js` - DeepSeek Chat Completions streaming loop с tools/thinking.
- `tools.js` - tools для поиска/чтения/создания/редактирования персон, guides и публичных URL.
- `family-db.js` - HTTP-клиент к `family-db-api`.
- `agent-guides.js`, `prompts.js`, `person-utils.js`, `constants.js` - guides, системные инструкции и helpers.
- `legacy-provider-openai.js`, `legacy-provider-google.js`, `legacy-provider-openrouter.js` - отключенные legacy-провайдеры, не импортируются активным runner.
- `http.js` - CORS, auth, route/body helpers.
