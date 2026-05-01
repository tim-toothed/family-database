'use strict';

const MAX_BODY_BYTES = 256 * 1024;

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers: {
      ...getCorsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: JSON.stringify(payload),
    isBase64Encoded: false,
  };
}

function emptyResponse(statusCode) {
  return {
    statusCode,
    headers: getCorsHeaders(),
    body: '',
    isBase64Encoded: false,
  };
}

function getHeader(event, name) {
  const normalizedName = String(name || '').toLowerCase();
  const headers = event?.headers || {};
  const pair = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  return pair ? String(pair[1] || '') : '';
}

function requireApiToken(event) {
  const expectedToken = process.env.FAMILY_AI_AGENT_API_TOKEN;
  if (!expectedToken) return;

  const authorization = getHeader(event, 'authorization');
  const queryToken = String(
    event?.queryStringParameters?.apiToken
    || event?.queryStringParameters?.token
    || ''
  );

  if (authorization !== `Bearer ${expectedToken}` && queryToken !== expectedToken) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
}

function parseBody(event) {
  if (!event?.body) return {};

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : String(event.body);

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    const error = new Error('Request body is too large.');
    error.statusCode = 413;
    throw error;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function normalizePath(event) {
  const queryRoute = event?.queryStringParameters?.route || event?.queryStringParameters?.path;
  if (queryRoute) {
    const route = String(queryRoute);
    return (route.startsWith('/') ? route : `/${route}`).replace(/\/+$/, '') || '/';
  }

  const rawPath = String(event?.path || event?.requestContext?.path || '/');
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return path.replace(/\/+$/, '') || '/';
}

function getHttpMethod(event) {
  return String(
    event?.httpMethod
    || event?.requestContext?.http?.method
    || event?.requestContext?.httpMethod
    || event?.method
    || 'GET'
  ).toUpperCase();
}

module.exports = {
  emptyResponse,
  getHttpMethod,
  jsonResponse,
  normalizePath,
  parseBody,
  requireApiToken,
};
