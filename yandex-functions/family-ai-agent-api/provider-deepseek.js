'use strict';

const { AGENT_TOOLS } = require('./constants');
const { addAgentChange, addAgentEvent } = require('./family-db');
const { buildInstructions } = require('./prompts');
const { executeToolCall } = require('./tools');

const DEFAULT_AGENT_TIMEOUT_MS = 540000;
const DEFAULT_DEEPSEEK_TIMEOUT_MS = 300000;

function getDeepSeekApiUrl() {
  return String(process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions').trim();
}

function getDeepSeekApiKey() {
  const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY environment variable is required.');
  return apiKey;
}

function isThinkingEnabled(context = {}) {
  if (context.thinkingMode === 'thinking') return true;
  if (context.thinkingMode === 'non_thinking') return false;
  return String(process.env.DEEPSEEK_ENABLE_THINKING || 'true').toLowerCase() !== 'false';
}

function getPositiveIntegerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(process.env[name]);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function getAgentTimeoutMs(context) {
  const configuredTimeoutMs = getPositiveIntegerEnv('FAMILY_AI_AGENT_TIMEOUT_MS', DEFAULT_AGENT_TIMEOUT_MS, {
    min: 15000,
  });
  const runtimeRemainingTimeMs = Number(context?.runtimeRemainingTimeMs);
  if (!Number.isFinite(runtimeRemainingTimeMs) || runtimeRemainingTimeMs <= 0) return configuredTimeoutMs;
  return Math.max(1000, Math.min(configuredTimeoutMs, runtimeRemainingTimeMs - 10000));
}

function getDeepSeekTimeoutMs() {
  return getPositiveIntegerEnv('DEEPSEEK_TIMEOUT_MS', DEFAULT_DEEPSEEK_TIMEOUT_MS, {
    min: 5000,
  });
}

function getMaxToolRounds() {
  return getPositiveIntegerEnv('FAMILY_AI_AGENT_MAX_TOOL_ROUNDS', 30, {
    min: 1,
  });
}

function appendToolCallDelta(map, deltaToolCall) {
  const index = Number.isFinite(Number(deltaToolCall.index)) ? Number(deltaToolCall.index) : map.size;
  const current = map.get(index) || {
    id: '',
    type: 'function',
    function: {
      name: '',
      arguments: '',
    },
  };

  if (deltaToolCall.id) current.id = deltaToolCall.id;
  if (deltaToolCall.type) current.type = deltaToolCall.type;
  if (deltaToolCall.function?.name) current.function.name += deltaToolCall.function.name;
  if (deltaToolCall.function?.arguments) current.function.arguments += deltaToolCall.function.arguments;
  map.set(index, current);
}

async function parseStreamingChatCompletion(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('DeepSeek response body is not readable.');

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const toolCallsByIndex = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      const delta = event?.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) appendToolCallDelta(toolCallsByIndex, toolCall);
      }
    }
  }

  return {
    content,
    reasoning,
    tool_calls: Array.from(toolCallsByIndex.entries())
      .sort(([left], [right]) => left - right)
      .map(([index, toolCall]) => ({
        ...toolCall,
        id: toolCall.id || `call_${index}`,
      })),
  };
}

async function createStreamingChatCompletion({ model, messages, timeoutMs, thinkingMode }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(getDeepSeekApiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getDeepSeekApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        tools: AGENT_TOOLS,
        tool_choice: 'auto',
        stream: true,
        enable_thinking: isThinkingEnabled({ thinkingMode }),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`DeepSeek API returned ${response.status}: ${text.slice(0, 500)}`);
    }

    return await parseStreamingChatCompletion(response);
  } finally {
    clearTimeout(timeout);
  }
}

function toAssistantToolCall(toolCall, fallbackId) {
  return {
    id: toolCall.id || fallbackId,
    type: 'function',
    function: {
      name: toolCall.function?.name || '',
      arguments: toolCall.function?.arguments || '{}',
    },
  };
}

async function safeAddAgentEvent(context, kind, payload) {
  if (!context?.jobId) return;
  try {
    await addAgentEvent(context.jobId, kind, payload);
  } catch (error) {
    console.error('Failed to write agent event', error);
  }
}

async function safeAddAgentChange(context, change) {
  if (!context?.jobId || !change) return;
  try {
    await addAgentChange(context.jobId, change);
  } catch (error) {
    console.error('Failed to write agent change', error);
  }
}

async function runDeepSeekAgent({ model, messages, context }) {
  const deadlineAt = Date.now() + getAgentTimeoutMs(context);
  const maxToolRounds = getMaxToolRounds();
  const chatMessages = [
    { role: 'system', content: buildInstructions(context) },
    ...messages,
  ];
  const changes = [];
  const toolCalls = [];
  let lastReasoning = '';
  await safeAddAgentEvent(context, 'status', { status: 'running' });

  for (let round = 0; round < maxToolRounds; round += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 5000) {
      const timeoutResult = {
        message: 'Я остановился перед лимитом времени функции. Уже выполненные изменения показаны в истории; для продолжения отправьте уточняющий запрос.',
        reasoning: lastReasoning,
        toolCalls,
        changes,
        incomplete: true,
      };
      await safeAddAgentEvent(context, 'timeout', { message: timeoutResult.message });
      return timeoutResult;
    }

    let assistantMessage;
    try {
      await safeAddAgentEvent(context, 'model_request', { round: round + 1, model });
      assistantMessage = await createStreamingChatCompletion({
        model,
        messages: chatMessages,
        timeoutMs: Math.max(1000, Math.min(getDeepSeekTimeoutMs(), remainingMs - 2500)),
        thinkingMode: context?.thinkingMode,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutResult = {
          message: 'DeepSeek не успел ответить до лимита времени. Уже выполненные изменения показаны в истории; попробуйте разбить задачу на меньшие шаги.',
          reasoning: lastReasoning,
          toolCalls,
          changes,
          incomplete: true,
        };
        await safeAddAgentEvent(context, 'timeout', { message: timeoutResult.message });
        return timeoutResult;
      }
      throw error;
    }
    lastReasoning = assistantMessage.reasoning || lastReasoning;

    const rawToolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    if (!rawToolCalls.length) {
      await safeAddAgentEvent(context, 'assistant_message', {
        content: assistantMessage.content || 'Готово.',
        reasoning: lastReasoning,
      });
      return {
        message: assistantMessage.content || 'Готово.',
        reasoning: lastReasoning,
        toolCalls,
        changes,
      };
    }

    const assistantToolCalls = rawToolCalls.map((toolCall, index) => (
      toAssistantToolCall(toolCall, `call_${round}_${index}`)
    ));

    const nextAssistantMessage = {
      role: 'assistant',
      content: assistantMessage.content || '',
      tool_calls: assistantToolCalls,
    };
    if (assistantMessage.reasoning) {
      nextAssistantMessage.reasoning_content = assistantMessage.reasoning;
    }
    chatMessages.push(nextAssistantMessage);

    for (const toolCall of assistantToolCalls) {
      const name = toolCall.function.name;
      const args = toolCall.function.arguments || '{}';
      let result;
      await safeAddAgentEvent(context, 'tool_call', { name, arguments: args });
      try {
        result = await executeToolCall({ name, arguments: args });
      } catch (error) {
        result = { error: error.message };
      }

      toolCalls.push({ name, arguments: args, result });
      await safeAddAgentEvent(context, result?.error ? 'tool_error' : 'tool_result', {
        name,
        result: result?.error ? { error: result.error } : result?.result || result,
      });
      if (result?.change) {
        changes.push(result.change);
        await safeAddAgentChange(context, result.change);
      }
      chatMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  const maxRoundsResult = {
    message: 'Я остановился после максимального числа шагов. Проверьте историю инструментов и при необходимости отправьте уточняющий запрос.',
    reasoning: lastReasoning,
    toolCalls,
    changes,
  };
  await safeAddAgentEvent(context, 'max_rounds', { message: maxRoundsResult.message });
  return maxRoundsResult;
}

module.exports = {
  runDeepSeekAgent,
};
