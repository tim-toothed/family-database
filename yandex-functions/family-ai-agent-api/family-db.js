'use strict';

function getFamilyDbApiUrl() {
  const apiUrl = String(process.env.FAMILY_DB_API_URL || '').trim().replace(/\/+$/, '');
  if (!apiUrl) throw new Error('FAMILY_DB_API_URL environment variable is required.');
  return apiUrl;
}

async function fetchFamilyDbApi(path, options = {}) {
  const url = new URL(getFamilyDbApiUrl());
  const routeUrl = new URL(path.startsWith('/') ? path : `/${path}`, 'https://family-db.local');
  url.searchParams.set('route', routeUrl.pathname);
  for (const [key, value] of routeUrl.searchParams.entries()) url.searchParams.set(key, value);

  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  };
  if (process.env.FAMILY_DB_API_TOKEN) headers.Authorization = `Bearer ${process.env.FAMILY_DB_API_TOKEN}`;

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `family-db-api returned ${response.status}.`);
  return payload;
}

async function listPeopleIndex() {
  const payload = await fetchFamilyDbApi('/people-index');
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

function getPerson(personId) {
  return fetchFamilyDbApi(`/people/${encodeURIComponent(personId)}`);
}

function createPerson(personId, payload) {
  return fetchFamilyDbApi(`/people/${encodeURIComponent(personId)}`, {
    method: 'POST',
    body: { payload },
  });
}

function updatePerson(personId, payload) {
  return fetchFamilyDbApi(`/people/${encodeURIComponent(personId)}`, {
    method: 'PUT',
    body: { payload },
  });
}

function createAgentJob(requestPayload) {
  return fetchFamilyDbApi('/agent/jobs', {
    method: 'POST',
    body: { request_payload: requestPayload },
  });
}

function getAgentJob(jobId, sinceEventIndex = -1) {
  return fetchFamilyDbApi(`/agent/jobs/${encodeURIComponent(jobId)}?sinceEventIndex=${encodeURIComponent(sinceEventIndex)}`);
}

function listAgentJobs(limit = 20) {
  return fetchFamilyDbApi(`/agent/jobs?limit=${encodeURIComponent(limit)}`);
}

function updateAgentJobStatus(jobId, body) {
  return fetchFamilyDbApi(`/agent/jobs/${encodeURIComponent(jobId)}/status`, {
    method: 'POST',
    body,
  });
}

function addAgentEvent(jobId, kind, payload = {}) {
  return fetchFamilyDbApi(`/agent/jobs/${encodeURIComponent(jobId)}/events`, {
    method: 'POST',
    body: { kind, payload },
  });
}

function addAgentChange(jobId, change) {
  return fetchFamilyDbApi(`/agent/jobs/${encodeURIComponent(jobId)}/changes`, {
    method: 'POST',
    body: change,
  });
}

module.exports = {
  addAgentChange,
  addAgentEvent,
  createAgentJob,
  createPerson,
  getAgentJob,
  getPerson,
  listAgentJobs,
  listPeopleIndex,
  updateAgentJobStatus,
  updatePerson,
};
