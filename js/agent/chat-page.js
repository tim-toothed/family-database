import { requireAuth } from '../auth.js';
import { deleteEditablePerson, saveEditablePerson } from '../db/editor-store.js';
import { createAgentJob, getAgentJob, listAgentJobs, runAgentJob } from '../db/yandex/agent-client.js';
import {
  AGENT_PROVIDER_OPTIONS,
  AGENT_THINKING_MODES,
  AGENT_TASK_TYPES,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_THINKING_MODE,
  DEFAULT_AGENT_TASK_TYPE,
} from './model-options.js';

const agentStatus = document.getElementById('agentStatus');
const agentProviderSelect = document.getElementById('agentProviderSelect');
const agentModelSelect = document.getElementById('agentModelSelect');
const agentTaskSelect = document.getElementById('agentTaskSelect');
const agentThinkingSelect = document.getElementById('agentThinkingSelect');
const agentMessages = document.getElementById('agentMessages');
const agentForm = document.getElementById('agentForm');
const agentPrompt = document.getElementById('agentPrompt');
const agentSubmitButton = document.getElementById('agentSubmitButton');
const agentChangeCount = document.getElementById('agentChangeCount');
const agentChangeList = document.getElementById('agentChangeList');

let messages = [];
let changeHistory = [];
let isSending = false;
let nextMessageId = 1;
const jobReasoningById = new Map();
const AGENT_SETTINGS_STORAGE_KEY = 'family-agent-settings';
const MAX_CONTEXT_MESSAGES = 3;
const JOB_POLL_INTERVAL_MS = 5000;
const MAX_JOB_POLL_MS = 15 * 60 * 1000;
const RESTORED_JOB_LIMIT = 20;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setStatus(message = '', tone = 'info') {
  agentStatus.textContent = message;
  agentStatus.classList.toggle('is-error', tone === 'error');
  agentStatus.classList.toggle('is-valid', tone === 'valid');
  agentStatus.classList.toggle('is-info', tone === 'info');
}

function pushMessage(message) {
  const nextMessage = {
    id: nextMessageId,
    ...message,
  };
  nextMessageId += 1;
  messages.push(nextMessage);
  renderMessages();
  return nextMessage.id;
}

function updateMessage(messageId, patch) {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return;
  messages[index] = {
    ...messages[index],
    ...patch,
  };
  renderMessages();
}

function removeMessage(messageId) {
  const nextMessages = messages.filter((message) => message.id !== messageId);
  if (nextMessages.length === messages.length) return;
  messages = nextMessages;
  renderMessages();
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function syncSendingState() {
  agentSubmitButton.disabled = isSending;
  agentPrompt.disabled = isSending;
  agentProviderSelect.disabled = isSending;
  agentModelSelect.disabled = isSending;
  agentTaskSelect.disabled = isSending;
  agentThinkingSelect.disabled = isSending;
  agentSubmitButton.textContent = isSending ? 'Думаю...' : 'Отправить';
}

function formatMessageText(text) {
  return escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
}

function renderMessages() {
  if (!messages.length) {
    agentMessages.innerHTML = `
      <div class="agent-empty-state">
        Спросите агента о карточке или попросите внести правку. Перед сохранением формулируйте изменение явно.
      </div>
    `;
    return;
  }

  agentMessages.innerHTML = messages.map((message) => {
    const roleLabel = message.role === 'user'
      ? 'Вы'
      : message.role === 'status'
        ? (message.tone === 'error' ? 'Ошибка' : 'Статус')
        : 'ИИ';
    const toneClass = message.role === 'status' && message.tone ? ` agent-message-status-${message.tone}` : '';
    const toolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length
      ? `
        <div class="agent-tool-trace">
          ${message.toolCalls.map((toolCall) => `
            <span>${escapeHtml(toolCall.name)}${toolCall.ok === false ? ': ошибка' : ''}</span>
          `).join('')}
        </div>
      `
      : '';
    const reasoning = String(message.reasoning || '').trim();
    const reasoningBlock = reasoning
      ? `
        <details class="agent-reasoning">
          <summary>Обдумывание</summary>
          <div>${formatMessageText(reasoning)}</div>
        </details>
      `
      : '';
    return `
      <article class="agent-message agent-message-${message.role}${toneClass}">
        <div class="agent-message-role">${roleLabel}</div>
        <div class="agent-message-body">${formatMessageText(message.content)}</div>
        ${reasoningBlock}
        ${toolCalls}
      </article>
    `;
  }).join('');
  agentMessages.scrollTop = agentMessages.scrollHeight;
}

function buildConversationPayload() {
  const recentMessages = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .filter((message) => !message.isTechnical)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));

  return {
    messages: recentMessages,
    provider: agentProviderSelect.value,
    model: agentModelSelect.value,
    taskType: agentTaskSelect.value,
    thinkingMode: agentThinkingSelect.value,
    context: {},
  };
}

function normalizeJobChange(change) {
  return {
    jobId: change.job_id,
    changeIndex: change.change_index,
    personId: change.person_id,
    displayName: change.display_name,
    action: change.action,
    changedPaths: Array.isArray(change.changed_paths) ? change.changed_paths : [],
    beforePayload: change.before_payload,
    afterPayload: change.after_payload,
    reverted: Boolean(change.reverted_at),
  };
}

function mergeJobChanges(changes) {
  if (!Array.isArray(changes) || !changes.length) return false;
  let didChange = false;
  for (const change of changes.map(normalizeJobChange)) {
    const key = `${change.jobId}:${change.changeIndex}`;
    const existingIndex = changeHistory.findIndex((item) => `${item.jobId}:${item.changeIndex}` === key);
    if (existingIndex >= 0) {
      changeHistory[existingIndex] = {
        ...changeHistory[existingIndex],
        ...change,
        reverted: changeHistory[existingIndex].reverted || change.reverted,
      };
    } else {
      changeHistory = [change, ...changeHistory];
    }
    didChange = true;
  }
  if (didChange) renderChangeHistory();
  return didChange;
}

function getLastUserMessage(snapshot) {
  const messagesPayload = snapshot?.job?.request_payload?.messages;
  if (!Array.isArray(messagesPayload)) return '';
  const message = [...messagesPayload].reverse().find((item) => item?.role === 'user');
  return String(message?.content || '').trim();
}

function getAssistantReasoning(snapshot) {
  const event = [...(Array.isArray(snapshot?.events) ? snapshot.events : [])]
    .reverse()
    .find((item) => item.kind === 'assistant_message' && item.payload?.reasoning);
  return String(event?.payload?.reasoning || '').trim();
}

function restoreMessagesFromJobs(snapshots) {
  const restoredMessages = [];
  const restoredChanges = [];
  const sortedSnapshots = [...snapshots].sort((left, right) => (
    String(left?.job?.created_at || '').localeCompare(String(right?.job?.created_at || ''))
  ));

  for (const snapshot of sortedSnapshots) {
    const prompt = getLastUserMessage(snapshot);
    if (prompt) {
      restoredMessages.push({
        id: nextMessageId,
        role: 'user',
        content: prompt,
      });
      nextMessageId += 1;
    }

    const job = snapshot?.job || {};
    if (job.status === 'completed') {
      restoredMessages.push({
        id: nextMessageId,
        role: 'assistant',
        content: String(job.final_message || '').trim() || 'Готово.',
        reasoning: getAssistantReasoning(snapshot),
      });
      nextMessageId += 1;
    } else if (job.status === 'failed' || job.status === 'timeout') {
      restoredMessages.push({
        id: nextMessageId,
        role: 'status',
        tone: 'error',
        content: job.error
          ? `Задача завершилась ошибкой: ${job.error}`
          : (job.final_message || 'Задача остановлена по timeout.'),
        isTechnical: true,
      });
      nextMessageId += 1;
    } else if (job.id) {
      restoredMessages.push({
        id: nextMessageId,
        role: 'status',
        tone: 'info',
        content: `Задача ${job.status || 'создана'}: ${job.id}`,
        isTechnical: true,
      });
      nextMessageId += 1;
    }

    for (const change of (Array.isArray(snapshot?.changes) ? snapshot.changes : [])) {
      restoredChanges.push(normalizeJobChange(change));
    }
  }

  messages = restoredMessages;
  changeHistory = restoredChanges.reverse();
}

async function restoreChatHistory() {
  const response = await listAgentJobs(RESTORED_JOB_LIMIT);
  const snapshots = Array.isArray(response?.jobs) ? response.jobs : [];
  restoreMessagesFromJobs(snapshots);
}

function formatEventStatus(event) {
  const payload = event?.payload || {};
  if (event.kind === 'tool_call') return `Инструмент: ${payload.name || 'tool'}`;
  if (event.kind === 'tool_error') return `Ошибка инструмента: ${payload.name || 'tool'}`;
  if (event.kind === 'change') return `Изменена карточка ${payload.person_id || ''}`.trim();
  if (event.kind === 'run_requested') return 'Запуск задачи отправлен на сервер...';
  if (event.kind === 'run_started') return 'Задача запущена на сервере.';
  if (event.kind === 'model_request') return `Запрос к модели, шаг ${payload.round || '?'}`;
  if (event.kind === 'assistant_message') return 'Финальный ответ получен.';
  if (event.kind === 'timeout') return payload.message || 'Задача остановлена по timeout.';
  if (event.kind === 'max_rounds') return payload.message || 'Достигнут лимит шагов.';
  if (event.kind === 'status') {
    if (payload.status === 'queued') return 'Задача ожидает запуска...';
    if (payload.status === 'running') return 'Агент выполняет задачу...';
    if (payload.status === 'completed') return 'Задача завершена.';
    if (payload.status === 'failed') return payload.error || 'Задача завершилась ошибкой.';
    if (payload.status === 'timeout') return payload.final_message || 'Задача остановлена по timeout.';
  }
  return '';
}

function applyJobSnapshot(snapshot, statusMessageId, lastEventIndex) {
  mergeJobChanges(snapshot?.changes || []);

  let nextLastEventIndex = lastEventIndex;
  const jobId = snapshot?.job?.id || '';
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  for (const event of events) {
    nextLastEventIndex = Math.max(nextLastEventIndex, Number(event.event_index || nextLastEventIndex));
    if (event.kind === 'assistant_message' && event.payload?.reasoning) {
      jobReasoningById.set(jobId, String(event.payload.reasoning || ''));
    }
    const status = formatEventStatus(event);
    if (status) updateMessage(statusMessageId, { content: status, tone: event.kind === 'tool_error' ? 'error' : 'info' });
  }

  const job = snapshot?.job || {};
  if (job.status === 'completed') {
    removeMessage(statusMessageId);
    pushMessage({
      role: 'assistant',
      content: String(job.final_message || '').trim() || 'Готово.',
      reasoning: jobReasoningById.get(job.id) || '',
    });
  } else if (job.status === 'failed') {
    updateMessage(statusMessageId, {
      tone: 'error',
      content: `Задача завершилась ошибкой: ${job.error || 'неизвестная ошибка'}`,
    });
  } else if (job.status === 'timeout') {
    updateMessage(statusMessageId, {
      tone: 'error',
      content: job.final_message || 'Задача остановлена по timeout.',
    });
  }

  return nextLastEventIndex;
}

async function pollAgentJob(jobId, statusMessageId, getRunError) {
  let lastEventIndex = -1;
  const deadlineAt = Date.now() + MAX_JOB_POLL_MS;
  while (isSending) {
    const runError = getRunError?.();
    if (runError) throw runError;

    const snapshot = await getAgentJob(jobId, lastEventIndex);
    lastEventIndex = applyJobSnapshot(snapshot, statusMessageId, lastEventIndex);
    const status = snapshot?.job?.status;
    if (status === 'completed' || status === 'failed' || status === 'timeout') return snapshot;
    if (!Array.isArray(snapshot?.events) || !snapshot.events.length) {
      updateMessage(statusMessageId, {
        content: `Задача ${status || 'создана'}; новых событий пока нет. Следующая проверка через ${JOB_POLL_INTERVAL_MS / 1000} сек.`,
      });
    }
    if (Date.now() >= deadlineAt) {
      updateMessage(statusMessageId, {
        tone: 'error',
        content: 'Ожидание задачи остановлено на клиенте. Уже записанные изменения останутся в истории задачи.',
      });
      return snapshot;
    }
    await delay(JOB_POLL_INTERVAL_MS);
  }
  return null;
}

function getProviderOption(providerId) {
  return AGENT_PROVIDER_OPTIONS.find((provider) => provider.id === providerId)
    || AGENT_PROVIDER_OPTIONS.find((provider) => provider.id === DEFAULT_AGENT_PROVIDER)
    || AGENT_PROVIDER_OPTIONS[0];
}

function readAgentSettings() {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(AGENT_SETTINGS_STORAGE_KEY) || '{}');
    return {
      provider: String(parsed.provider || DEFAULT_AGENT_PROVIDER),
      model: String(parsed.model || DEFAULT_AGENT_MODEL),
      taskType: String(parsed.taskType || DEFAULT_AGENT_TASK_TYPE),
      thinkingMode: String(parsed.thinkingMode || DEFAULT_AGENT_THINKING_MODE),
    };
  } catch {
    return {
      provider: DEFAULT_AGENT_PROVIDER,
      model: DEFAULT_AGENT_MODEL,
      taskType: DEFAULT_AGENT_TASK_TYPE,
      thinkingMode: DEFAULT_AGENT_THINKING_MODE,
    };
  }
}

function saveAgentSettings() {
  try {
    window.localStorage?.setItem(AGENT_SETTINGS_STORAGE_KEY, JSON.stringify({
      provider: agentProviderSelect.value,
      model: agentModelSelect.value,
      taskType: agentTaskSelect.value,
      thinkingMode: agentThinkingSelect.value,
    }));
  } catch {
    // Local storage is optional.
  }
}

function renderProviderOptions(selectedProvider) {
  agentProviderSelect.innerHTML = AGENT_PROVIDER_OPTIONS
    .map((provider) => `<option value="${escapeHtml(provider.id)}"${provider.id === selectedProvider ? ' selected' : ''}>${escapeHtml(provider.label)}</option>`)
    .join('');
}

function renderTaskOptions(selectedTaskType) {
  agentTaskSelect.innerHTML = AGENT_TASK_TYPES
    .map((task) => `<option value="${escapeHtml(task.id)}"${task.id === selectedTaskType ? ' selected' : ''}>${escapeHtml(task.label)}</option>`)
    .join('');
}

function renderThinkingOptions(selectedThinkingMode) {
  const selected = AGENT_THINKING_MODES.some((mode) => mode.id === selectedThinkingMode)
    ? selectedThinkingMode
    : DEFAULT_AGENT_THINKING_MODE;
  agentThinkingSelect.innerHTML = AGENT_THINKING_MODES
    .map((mode) => `<option value="${escapeHtml(mode.id)}"${mode.id === selected ? ' selected' : ''}>${escapeHtml(mode.label)}</option>`)
    .join('');
}

function renderModelOptions(providerId, selectedModel) {
  const provider = getProviderOption(providerId);
  const hasSelectedModel = provider.models.some((model) => model.id === selectedModel);
  const nextSelectedModel = hasSelectedModel ? selectedModel : provider.models[0]?.id || '';

  agentModelSelect.innerHTML = provider.models
    .map((model) => `<option value="${escapeHtml(model.id)}"${model.id === nextSelectedModel ? ' selected' : ''}>${escapeHtml(model.label)}</option>`)
    .join('');
}

function initializeAgentSettings() {
  const settings = readAgentSettings();
  const provider = getProviderOption(settings.provider);

  renderProviderOptions(provider.id);
  renderTaskOptions(settings.taskType);
  renderModelOptions(provider.id, settings.model);
  renderThinkingOptions(settings.thinkingMode);

  agentProviderSelect.addEventListener('change', () => {
    renderModelOptions(agentProviderSelect.value, '');
    saveAgentSettings();
  });
  agentModelSelect.addEventListener('change', saveAgentSettings);
  agentTaskSelect.addEventListener('change', saveAgentSettings);
  agentThinkingSelect.addEventListener('change', saveAgentSettings);
}

function formatChangeSummary(change) {
  const paths = Array.isArray(change.changedPaths) ? change.changedPaths : [];
  return paths.length ? paths.join(', ') : 'Payload изменен.';
}

function renderChangeHistory() {
  agentChangeCount.textContent = String(changeHistory.length);

  if (!changeHistory.length) {
    agentChangeList.innerHTML = `
      <div class="agent-empty-state agent-empty-state-compact">
        Здесь появятся карточки, которые агент изменил в этой сессии.
      </div>
    `;
    return;
  }

  agentChangeList.innerHTML = changeHistory.map((change, index) => {
    const title = change.displayName && change.displayName !== change.personId
      ? `${escapeHtml(change.displayName)} [${escapeHtml(change.personId)}]`
      : escapeHtml(change.personId);
    const summary = escapeHtml(formatChangeSummary(change));
    const previousJson = escapeHtml(JSON.stringify(change.beforePayload || {}, null, 2));
    const nextJson = escapeHtml(JSON.stringify(change.afterPayload || {}, null, 2));
    const disabled = change.reverted ? ' disabled' : '';

    return `
      <details class="agent-change-card" ${index === 0 ? 'open' : ''}>
        <summary>
          <span>${title}</span>
          <small>${change.reverted ? 'отменено' : summary}</small>
        </summary>
        <div class="agent-change-body">
          <div class="agent-change-summary">${summary}</div>
          <div class="agent-change-actions">
            <a class="toolbar-link toolbar-link-subtle" href="./edit.html?id=${encodeURIComponent(change.personId)}">Открыть в редакторе</a>
            <button class="toolbar-button toolbar-button-subtle" type="button" data-revert-change="${index}"${disabled}>${change.beforePayload ? 'Откатить' : 'Удалить созданную'}</button>
          </div>
          <div class="agent-change-json-grid">
            <section>
              <h3>До</h3>
              <pre>${previousJson}</pre>
            </section>
            <section>
              <h3>После</h3>
              <pre>${nextJson}</pre>
            </section>
          </div>
        </div>
      </details>
    `;
  }).join('');
}

async function revertChange(index) {
  const change = changeHistory[index];
  if (!change || change.reverted || isSending) return;

  const confirmed = window.confirm(`Откатить изменения карточки ${change.personId}?`);
  if (!confirmed) return;

  isSending = true;
  syncSendingState();
  setStatus('');
  const statusMessageId = pushMessage({
    role: 'status',
    tone: 'info',
    content: `Откатываю ${change.personId}...`,
    isTechnical: true,
  });

  try {
    if (change.beforePayload) {
      await saveEditablePerson(change.personId, change.beforePayload);
    } else {
      await deleteEditablePerson(change.personId);
    }
    change.reverted = true;
    renderChangeHistory();
    updateMessage(statusMessageId, {
      tone: 'valid',
      content: `Изменения ${change.personId} отменены.`,
    });
  } catch (error) {
    console.error(error);
    updateMessage(statusMessageId, {
      tone: 'error',
      content: `Не удалось откатить ${change.personId}: ${error.message}`,
    });
  } finally {
    isSending = false;
    syncSendingState();
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (isSending) return;

  const prompt = String(agentPrompt.value || '').trim();
  if (!prompt) return;

  pushMessage({ role: 'user', content: prompt });
  agentPrompt.value = '';

  isSending = true;
  syncSendingState();
  setStatus('');
  const statusMessageId = pushMessage({
    role: 'status',
    tone: 'info',
    content: 'Запрос отправлен агенту...',
    isTechnical: true,
  });

  try {
    const created = await createAgentJob(buildConversationPayload());
    const jobId = created?.job?.id;
    if (!jobId) throw new Error('AI job не был создан.');
    updateMessage(statusMessageId, {
      content: `Задача создана: ${jobId}`,
    });

    let runError = null;
    const runPromise = runAgentJob(jobId).catch((error) => {
      runError = error;
      return { runError: error };
    });
    const snapshot = await pollAgentJob(jobId, statusMessageId, () => runError);
    if (['completed', 'failed', 'timeout'].includes(snapshot?.job?.status)) {
      const runResult = await runPromise;
      if (runResult?.runError && snapshot.job.status !== 'failed') throw runResult.runError;
    }
  } catch (error) {
    console.error(error);
    updateMessage(statusMessageId, {
      role: 'status',
      tone: 'error',
      content: `Не удалось выполнить запрос: ${error.message}`,
    });
  } finally {
    isSending = false;
    syncSendingState();
  }
}

async function init() {
  try {
    await requireAuth();
    initializeAgentSettings();
    await restoreChatHistory();
    renderMessages();
    renderChangeHistory();
    syncSendingState();
    agentForm.addEventListener('submit', handleSubmit);
    agentChangeList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-revert-change]');
      if (!button) return;
      revertChange(Number(button.dataset.revertChange));
    });
    agentPrompt.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !event.ctrlKey) return;
      event.preventDefault();
      agentForm.requestSubmit();
    });
    setStatus('');
  } catch (error) {
    console.error(error);
    setStatus('');
    pushMessage({
      role: 'status',
      tone: 'error',
      content: error.message,
      isTechnical: true,
    });
  }
}

init();
