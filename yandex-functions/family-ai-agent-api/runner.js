'use strict';

const {
  ALLOWED_MODELS_BY_PROVIDER,
  ALLOWED_TASK_TYPES,
  ALLOWED_THINKING_MODES,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER,
  MAX_MESSAGES,
} = require('./constants');
const { runDeepSeekAgent } = require('./provider-deepseek');

function normalizeRole(role) {
  return role === 'assistant' ? 'assistant' : 'user';
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      role: normalizeRole(message?.role),
      content: String(message?.content || '').slice(0, 12000),
    }))
    .filter((message) => message.content.trim());
}

function normalizeProvider(provider) {
  const normalized = String(provider || DEFAULT_PROVIDER).trim().toLowerCase();
  return normalized === 'deepseek' ? 'deepseek' : DEFAULT_PROVIDER;
}

function normalizeModel(provider, model) {
  const fallback = DEFAULT_MODEL_BY_PROVIDER[provider] || DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER];
  const normalized = String(model || fallback).trim();
  const allowed = ALLOWED_MODELS_BY_PROVIDER[provider];
  if (!allowed?.has(normalized)) {
    const error = new Error(`Model ${normalized || '(empty)'} is not allowed for provider ${provider}.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeTaskType(taskType) {
  const normalized = String(taskType || 'person_editing').trim();
  if (!ALLOWED_TASK_TYPES.has(normalized)) {
    const error = new Error(`Task type ${normalized || '(empty)'} is not supported.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeThinkingMode(thinkingMode) {
  const normalized = String(thinkingMode || 'thinking').trim();
  if (!ALLOWED_THINKING_MODES.has(normalized)) {
    const error = new Error(`Thinking mode ${normalized || '(empty)'} is not supported.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function prepareAgentRequest(body = {}) {
  const provider = normalizeProvider(body.provider);
  const model = normalizeModel(provider, body.model);
  const taskType = normalizeTaskType(body.taskType);
  const thinkingMode = normalizeThinkingMode(body.thinkingMode);
  const messages = normalizeMessages(body.messages);

  if (!messages.length) {
    const error = new Error('At least one message is required.');
    error.statusCode = 400;
    throw error;
  }

  return {
    provider,
    model,
    taskType,
    thinkingMode,
    messages,
  };
}

async function runAgentChat(body = {}, options = {}) {
  const {
    provider,
    model,
    taskType,
    thinkingMode,
    messages,
  } = prepareAgentRequest(body);

  const result = await runDeepSeekAgent({
    model,
    messages,
    context: {
      taskType,
      provider,
      model,
      thinkingMode,
      jobId: options.jobId,
      runtimeRemainingTimeMs: options.remainingTimeMs,
    },
  });

  return {
    provider,
    model,
    taskType,
    thinkingMode,
    ...result,
  };
}

module.exports = {
  prepareAgentRequest,
  runAgentChat,
};
