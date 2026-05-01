import { YANDEX_AI_AGENT_CONFIG } from '../../config.js';

function getAgentApiUrl() {
  const apiUrl = String(YANDEX_AI_AGENT_CONFIG?.apiUrl || '').trim().replace(/\/+$/, '');
  if (!apiUrl) {
    throw new Error('Yandex AI Agent API URL не настроен в js/config.js.');
  }
  return apiUrl;
}

function getAgentApiToken() {
  return String(
    YANDEX_AI_AGENT_CONFIG?.apiToken
    || globalThis.localStorage?.getItem('family-ai-agent-api-token')
    || ''
  ).trim();
}

async function fetchAgentRoute(route, options = {}) {
  const url = new URL(getAgentApiUrl());
  url.searchParams.set('route', route);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const token = getAgentApiToken();
  if (token) {
    url.searchParams.set('apiToken', token);
  }

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Yandex AI Agent API вернул ${response.status}.`);
  }

  return body;
}

export function sendAgentChat(payload) {
  return fetchAgentRoute('/chat', {
    method: 'POST',
    body: payload,
  });
}

export function createAgentJob(payload) {
  return fetchAgentRoute('/chat/jobs', {
    method: 'POST',
    body: payload,
  });
}

export function getAgentJob(jobId, sinceEventIndex = -1) {
  return fetchAgentRoute(`/chat/jobs/${encodeURIComponent(jobId)}`, {
    query: { sinceEventIndex },
  });
}

export function listAgentJobs(limit = 20) {
  return fetchAgentRoute('/chat/jobs', {
    query: { limit },
  });
}

export function runAgentJob(jobId) {
  return fetchAgentRoute(`/chat/jobs/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
    body: {},
  });
}
