import { requireAuth } from '../auth.js';
import { deleteEditablePerson, saveEditablePerson } from '../db/editor-store.js';
import { cancelAgentJob, createAgentJob, getAgentJob, listAgentJobs, runAgentJob } from '../db/yandex/agent-client.js';
import { getPersonFieldLabel } from '../person/labels.js';
import { renderField } from '../render/renderers.js';
import { escapeHtml, isPlainObject } from '../utils/normalize.js';
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
let isStopping = false;
let activeJobId = '';
let activeRunAbortController = null;
let editingMessageId = null;
let nextMessageId = 1;
const jobReasoningById = new Map();
const jobAssistantMessageIdById = new Map();
const jobPartialSegmentsById = new Map();
const jobToolCallRoundsById = new Map();
const AGENT_SETTINGS_STORAGE_KEY = 'family-agent-settings';
const MAX_CONTEXT_MESSAGES = 3;
const JOB_POLL_INTERVAL_MS = 5000;
const MAX_JOB_POLL_MS = 15 * 60 * 1000;
const RESTORED_JOB_LIMIT = 20;

function iconSvg(name) {
  const paths = {
    send: '<path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path>',
    stop: '<rect width="14" height="14" x="5" y="5" rx="2"></rect>',
    edit: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>',
    retry: '<path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path>',
  };
  return `
    <svg class="agent-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      ${paths[name] || ''}
    </svg>
  `;
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
  agentSubmitButton.disabled = isStopping;
  agentPrompt.disabled = isSending;
  agentProviderSelect.disabled = isSending;
  agentModelSelect.disabled = isSending;
  agentTaskSelect.disabled = isSending;
  agentThinkingSelect.disabled = isSending;
  agentSubmitButton.classList.toggle('agent-submit-button', true);
  agentSubmitButton.classList.toggle('is-stop', isSending);
  agentSubmitButton.innerHTML = isSending ? iconSvg('stop') : iconSvg('send');
  agentSubmitButton.setAttribute('aria-label', isSending ? 'Остановить запрос' : 'Отправить сообщение');
  agentSubmitButton.title = isSending ? 'Остановить' : 'Отправить';
}

function formatInlineMarkdown(text) {
  const placeholders = [];
  const protect = (html) => {
    const token = `@@INLINE_${placeholders.length}@@`;
    placeholders.push([token, html]);
    return token;
  };

  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, (_, code) => protect(`<code>${code}</code>`));
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  for (const [token, value] of placeholders) html = html.replaceAll(token, value);
  return html;
}

function parseMarkdownTable(lines, startIndex) {
  const header = lines[startIndex];
  const separator = lines[startIndex + 1];
  if (!header?.trim().startsWith('|') || !separator?.trim().startsWith('|')) return null;

  const separatorCells = separator
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
  const isSeparator = separatorCells.length > 0 && separatorCells.every((cell) => /^:?-{3,}:?$/.test(cell));
  if (!isSeparator) return null;

  const rows = [];
  let index = startIndex;
  while (index < lines.length && lines[index].trim().startsWith('|')) {
    rows.push(
      lines[index]
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
    );
    index += 1;
  }

  if (rows.length < 2) return null;
  const [head, , ...body] = rows;
  const table = `
    <div class="agent-markdown-table-wrap">
      <table class="agent-markdown-table">
        <thead>
          <tr>${head.map((cell) => `<th>${formatInlineMarkdown(cell)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${body.map((row) => `<tr>${row.map((cell) => `<td>${formatInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  return { html: table, nextIndex: index };
}

function formatMarkdown(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let inCodeBlock = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${formatInlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };

  const parseList = (startIndex) => {
    const first = lines[startIndex]?.trim() || '';
    const ordered = /^\d+\.\s+/.test(first);
    const unordered = /^[-*]\s+/.test(first);
    if (!ordered && !unordered) return null;

    const items = [];
    let index = startIndex;
    const pattern = ordered ? /^\d+\.\s+(.+)$/ : /^[-*]\s+(.+)$/;
    while (index < lines.length) {
      const match = (lines[index]?.trim() || '').match(pattern);
      if (!match) break;
      items.push(match[1]);
      index += 1;
    }

    const tag = ordered ? 'ol' : 'ul';
    return {
      html: `<${tag}>${items.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</${tag}>`,
      nextIndex: index,
    };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        flushParagraph();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table) {
      flushParagraph();
      blocks.push(table.html);
      index = table.nextIndex - 1;
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      blocks.push('<hr>');
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push(`<h${level}>${formatInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const list = parseList(index);
    if (list) {
      flushParagraph();
      blocks.push(list.html);
      index = list.nextIndex - 1;
      continue;
    }

    paragraph.push(line);
  }

  if (inCodeBlock) blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushParagraph();
  return blocks.join('');
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

  const lastUserMessageId = [...messages].reverse().find((message) => message.role === 'user')?.id ?? null;
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
          <div>${formatMarkdown(reasoning)}</div>
        </details>
      `
      : '';
    const actions = [];
    if (message.role === 'user' && message.id === lastUserMessageId && !isSending) {
      actions.push(`
        <button class="agent-message-action" type="button" data-edit-message="${message.id}" title="Редактировать" aria-label="Редактировать сообщение">
          ${iconSvg('edit')}
        </button>
      `);
    }
    if (message.role === 'assistant' && !message.isPartial && !isSending) {
      actions.push(`
        <button class="agent-message-action" type="button" data-retry-message="${message.id}" title="Повторить запрос" aria-label="Повторить запрос">
          ${iconSvg('retry')}
        </button>
      `);
    }
    if ((message.role === 'user' || message.role === 'assistant') && String(message.content || '').trim()) {
      actions.push(`
        <button class="agent-message-action" type="button" data-copy-message="${message.id}" title="Скопировать" aria-label="Скопировать сообщение">
          ${iconSvg('copy')}
        </button>
      `);
    }
    const actionBlock = actions.length
      ? `<div class="agent-message-actions">${actions.join('')}</div>`
      : '';
    return `
      <article class="agent-message agent-message-${message.role}${toneClass}">
        <div class="agent-message-head">
          <div class="agent-message-role">${roleLabel}</div>
          ${actionBlock}
        </div>
        <div class="agent-message-body">${formatMarkdown(message.content)}</div>
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

function truncateMessagesAfter(messageId) {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return;
  messages = messages.slice(0, index + 1);
  renderMessages();
}

function findPreviousUserMessageIndex(messageIndex) {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
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
  if (snapshot?.job?.request_payload?.thinkingMode === 'non_thinking') return '';
  const event = [...(Array.isArray(snapshot?.events) ? snapshot.events : [])]
    .reverse()
    .find((item) => item.kind === 'assistant_message' && item.payload?.reasoning);
  return String(event?.payload?.reasoning || '').trim();
}

function getSortedJobSegments(jobId) {
  const segments = jobPartialSegmentsById.get(jobId);
  if (!segments) return [];
  return getSortedJobSegmentEntries(jobId)
    .map(([, content]) => String(content || '').trim())
    .filter(Boolean);
}

function getSortedJobSegmentEntries(jobId) {
  const segments = jobPartialSegmentsById.get(jobId);
  if (!segments) return [];
  return Array.from(segments.entries())
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([round, content]) => [Number(round), String(content || '').trim()])
    .filter(([, content]) => Boolean(content));
}

function normalizeTranscriptText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function mergeTranscriptParts(parts) {
  const merged = [];
  for (const part of parts.map((item) => String(item || '').trim()).filter(Boolean)) {
    const normalizedPart = normalizeTranscriptText(part);
    if (merged.some((existing) => normalizeTranscriptText(existing) === normalizedPart)) continue;
    if (merged.length && normalizedPart.startsWith(normalizeTranscriptText(merged[merged.length - 1]))) {
      merged[merged.length - 1] = part;
      continue;
    }
    if (merged.length && normalizeTranscriptText(merged[merged.length - 1]).startsWith(normalizedPart)) continue;
    merged.push(part);
  }
  return merged.join('\n\n');
}

function dedupeTranscriptBlocks(text) {
  const blocks = String(text || '').trim().split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const deduped = [];
  for (const block of blocks) {
    const normalizedBlock = normalizeTranscriptText(block);
    if (deduped.some((existing) => normalizeTranscriptText(existing) === normalizedBlock)) continue;
    deduped.push(block);
  }
  return deduped.join('\n\n');
}

function rememberToolCallRound(jobId, round) {
  if (!jobId) return;
  if (!Number.isFinite(Number(round))) return;
  const normalizedRound = Number(round);
  const rounds = jobToolCallRoundsById.get(jobId) || new Set();
  rounds.add(normalizedRound);
  jobToolCallRoundsById.set(jobId, rounds);
}

function setJobSegment(jobId, round, content) {
  if (!jobId) return '';
  const normalizedRound = Number.isFinite(Number(round)) ? Number(round) : 0;
  const segments = jobPartialSegmentsById.get(jobId) || new Map();
  segments.set(normalizedRound, String(content || ''));
  jobPartialSegmentsById.set(jobId, segments);
  return getSortedJobSegments(jobId).join('\n\n');
}

function getVisibleJobTranscript(job) {
  const jobId = job?.id || '';
  const finalMessage = dedupeTranscriptBlocks(job?.final_message || '');
  if (job?.request_payload?.thinkingMode === 'non_thinking') {
    return finalMessage || getSortedJobSegments(jobId).at(-1) || '';
  }

  const toolCallRounds = jobToolCallRoundsById.get(jobId) || new Set();
  const segments = (jobPartialSegmentsById.get(jobId) ? Array.from(jobPartialSegmentsById.get(jobId).entries()) : [])
    .sort(([left], [right]) => Number(left) - Number(right))
    .filter(([round]) => !toolCallRounds.has(Number(round)))
    .map(([, content]) => content);
  return mergeTranscriptParts([...segments, finalMessage]);
}

function getJobWorkNotes(jobId) {
  const toolCallRounds = jobToolCallRoundsById.get(jobId) || new Set();
  if (!toolCallRounds.size) return '';
  const segments = getSortedJobSegmentEntries(jobId)
    .filter(([round]) => toolCallRounds.has(Number(round)))
    .map(([, content]) => content);
  const notes = mergeTranscriptParts(segments);
  return notes ? `Ход выполнения:\n\n${notes}` : '';
}

function getFinalJobReasoning(job, snapshotReasoning = '') {
  const jobId = job?.id || '';
  const modelReasoning = job?.request_payload?.thinkingMode === 'non_thinking'
    ? ''
    : (jobReasoningById.get(jobId) || snapshotReasoning || '');
  return mergeTranscriptParts([
    modelReasoning,
    getJobWorkNotes(jobId),
  ]);
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
    const jobId = job.id || '';
    for (const event of (Array.isArray(snapshot?.events) ? snapshot.events : [])) {
      if (event.kind === 'tool_call' || event.kind === 'tool_result' || event.kind === 'tool_error') {
        rememberToolCallRound(jobId, event.payload?.round);
      }
      if (event.kind === 'assistant_message_segment' && event.payload?.content) {
        rememberToolCallRound(jobId, event.payload?.round);
        setJobSegment(jobId, event.payload.round, event.payload.content);
      }
      if (event.kind === 'partial_message' && event.payload?.content) {
        setJobSegment(jobId, event.payload.round, event.payload.content);
      }
      if (event.kind === 'assistant_message' && event.payload?.reasoning) {
        jobReasoningById.set(jobId, String(event.payload.reasoning || ''));
      }
    }

    if (job.status === 'completed') {
      restoredMessages.push({
        id: nextMessageId,
        role: 'assistant',
        content: getVisibleJobTranscript(job) || 'Готово.',
        reasoning: getFinalJobReasoning(job, getAssistantReasoning(snapshot)),
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
  if (event.kind === 'partial_message') return '';
  if (event.kind === 'assistant_message') return 'Финальный ответ получен.';
  if (event.kind === 'timeout') return payload.message || 'Задача остановлена по timeout.';
  if (event.kind === 'cancel_requested') return 'Останавливаю запрос...';
  if (event.kind === 'cancelled') return payload.message || 'Запрос остановлен пользователем.';
  if (event.kind === 'max_rounds') return payload.message || 'Достигнут лимит шагов.';
  if (event.kind === 'status') {
    if (payload.status === 'queued') return 'Задача ожидает запуска...';
    if (payload.status === 'running') return 'Агент выполняет задачу...';
    if (payload.status === 'completed') return 'Задача завершена.';
    if (payload.status === 'failed') return payload.error || 'Задача завершилась ошибкой.';
    if (payload.status === 'timeout') return payload.final_message || 'Задача остановлена по timeout.';
    if (payload.status === 'cancelled') return payload.final_message || 'Запрос остановлен пользователем.';
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
    if (event.kind === 'tool_call' || event.kind === 'tool_result' || event.kind === 'tool_error') {
      rememberToolCallRound(jobId, event.payload?.round);
    }
    if (event.kind === 'partial_message' && event.payload?.content) {
      setJobSegment(jobId, event.payload.round, event.payload.content);
      const content = getVisibleJobTranscript(snapshot?.job || { id: jobId });
      const existingMessageId = jobAssistantMessageIdById.get(jobId);
      if (existingMessageId) {
        updateMessage(existingMessageId, { content });
      } else {
        const messageId = pushMessage({
          role: 'assistant',
          content,
          isPartial: true,
        });
        jobAssistantMessageIdById.set(jobId, messageId);
      }
    }
    if (event.kind === 'assistant_message_segment' && event.payload?.content) {
      rememberToolCallRound(jobId, event.payload?.round);
      setJobSegment(jobId, event.payload.round, event.payload.content);
      const content = getVisibleJobTranscript(snapshot?.job || { id: jobId });
      const existingMessageId = jobAssistantMessageIdById.get(jobId);
      if (existingMessageId) updateMessage(existingMessageId, { content });
    }
    if (event.kind === 'assistant_message' && event.payload?.reasoning) {
      if (snapshot?.job?.request_payload?.thinkingMode !== 'non_thinking') {
        jobReasoningById.set(jobId, String(event.payload.reasoning || ''));
      }
    }
    const status = formatEventStatus(event);
    if (status) updateMessage(statusMessageId, { content: status, tone: event.kind === 'tool_error' ? 'error' : 'info' });
  }

  const job = snapshot?.job || {};
  if (job.status === 'completed') {
    removeMessage(statusMessageId);
    const existingMessageId = jobAssistantMessageIdById.get(job.id);
    const content = getVisibleJobTranscript(job);
    const finalMessage = {
      role: 'assistant',
      content: content || 'Готово.',
      reasoning: getFinalJobReasoning(job),
      isPartial: false,
    };
    if (existingMessageId) {
      updateMessage(existingMessageId, finalMessage);
    } else {
      pushMessage(finalMessage);
    }
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
  } else if (job.status === 'cancelled') {
    updateMessage(statusMessageId, {
      tone: 'info',
      content: job.final_message || 'Запрос остановлен пользователем.',
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
    if (status === 'completed' || status === 'failed' || status === 'timeout' || status === 'cancelled') return snapshot;
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

function formatRelationItem(item) {
  if (!isPlainObject(item)) return formatSectionValue(item);
  const parts = [
    item.person_id ? `<span class="agent-relation-id">ID: ${escapeHtml(item.person_id)}</span>` : '',
    item.relation_type ? `<span class="badge family-role-badge role-neutral">${escapeHtml(item.relation_type)}</span>` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : escapeHtml(JSON.stringify(item));
}

function getSingleTextValue(item) {
  if (!isPlainObject(item)) return '';
  const preferredKeys = [
    'text',
    'source',
    'achievement',
    'job',
    'education_info',
    'residence_info',
    'service_info',
    'war',
    'media',
    'description',
    'hobby',
    'character',
    'appearance',
    'health',
  ];
  for (const key of preferredKeys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const stringEntries = Object.entries(item).filter(([, value]) => typeof value === 'string' && value.trim());
  return stringEntries.length === 1 ? stringEntries[0][1].trim() : '';
}

function formatArrayItem(item) {
  if (!isPlainObject(item)) return formatSectionValue(item);
  if (item.person_id) return formatRelationItem(item);

  const label = String(item.label || item.title || '').trim();
  const nestedText = String(item.text || item.value || '').trim();
  if (label && nestedText) {
    return `<span class="agent-item-label">${escapeHtml(label)}:</span> ${escapeHtml(nestedText)}`;
  }

  const text = getSingleTextValue(item);
  if (text) return escapeHtml(text);

  return formatSectionValue(item);
}

function formatNameObject(value) {
  return [value.surname, value.first_name, value.patronymic]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

function formatDateObject(value) {
  const day = value.day ? String(value.day).padStart(2, '0') : '';
  const month = value.month ? String(value.month).padStart(2, '0') : '';
  const year = value.year ? String(value.year) : '';
  return [day, month, year].filter(Boolean).join('.');
}

function getValueAtPath(payload, path) {
  if (!path) return payload;
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => (current == null ? undefined : current[key]), payload);
}

function formatSectionValue(value) {
  if (value === undefined) return '<span class="agent-empty-value">не было</span>';
  if (value === null || value === '') return '<span class="agent-empty-value">пусто</span>';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return escapeHtml(value);
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="agent-empty-value">пустой список</span>';
    return `<ul>${value.map((item) => `<li>${formatArrayItem(item)}</li>`).join('')}</ul>`;
  }
  if (isPlainObject(value)) {
    const name = formatNameObject(value);
    if (name) return escapeHtml(name);
    const date = formatDateObject(value);
    if (date) return escapeHtml(date);
    return `
      <div class="kv-list">
        ${Object.entries(value).map(([key, nested]) => `
          <div class="kv-label">${escapeHtml(key)}</div>
          <div>${formatSectionValue(nested)}</div>
        `).join('')}
      </div>
    `;
  }
  return escapeHtml(String(value));
}

function createDiffDataset(change) {
  const people = new Map();
  const indexById = new Map();
  for (const payload of [change.beforePayload, change.afterPayload]) {
    if (!payload?.id) continue;
    people.set(payload.id, payload);
    indexById.set(payload.id, change.displayName || payload.id);
  }
  return {
    people,
    indexById,
    availableIds: new Set(indexById.keys()),
  };
}

function renderSharedFieldValue(sectionKey, value, change) {
  if (value === undefined) return '<span class="agent-empty-value">не было</span>';
  if (value === null || value === '') return '<span class="agent-empty-value">пусто</span>';
  const rendered = renderField(sectionKey, value, createDiffDataset(change));
  return rendered || formatSectionValue(value);
}

function formatDiffLineValue(sectionKey, value, change) {
  const html = renderSharedFieldValue(sectionKey, value, change);
  return html.replace(/^<ul>|<\/ul>$/g, '');
}

function buildCompactDiffRows(sectionKey, beforeValue, afterValue, change) {
  if (Array.isArray(beforeValue) || Array.isArray(afterValue)) {
    const beforeItems = Array.isArray(beforeValue) ? beforeValue : [];
    const afterItems = Array.isArray(afterValue) ? afterValue : [];
    const maxLength = Math.max(beforeItems.length, afterItems.length);
    const rows = [];
    for (let index = 0; index < maxLength; index += 1) {
      const beforeItem = beforeItems[index];
      const afterItem = afterItems[index];
      if (JSON.stringify(beforeItem) === JSON.stringify(afterItem)) continue;
      if (beforeItem !== undefined) rows.push({ tone: 'removed', html: formatDiffLineValue(sectionKey, [beforeItem], change) });
      if (afterItem !== undefined) rows.push({ tone: 'added', html: formatDiffLineValue(sectionKey, [afterItem], change) });
    }
    return rows;
  }

  if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) return [];
  return [
    ...(beforeValue !== undefined ? [{ tone: 'removed', html: formatDiffLineValue(sectionKey, beforeValue, change) }] : []),
    ...(afterValue !== undefined ? [{ tone: 'added', html: formatDiffLineValue(sectionKey, afterValue, change) }] : []),
  ];
}

function renderCompactDiffRows(sectionKey, beforeValue, afterValue, change) {
  const rows = buildCompactDiffRows(sectionKey, beforeValue, afterValue, change);
  if (!rows.length) return '<div class="agent-compact-diff-empty">Нет отображаемых изменений.</div>';
  return `
    <div class="agent-compact-diff">
      ${rows.map((row) => `
        <div class="agent-compact-diff-row is-${row.tone}">
          <span>${row.tone === 'removed' ? '−' : '+'}</span>
          <div>${row.html}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function getChangedSectionKeys(change) {
  const paths = Array.isArray(change.changedPaths) ? change.changedPaths : [];
  const keys = paths
    .map((path) => String(path || '').split('.')[0])
    .filter(Boolean);
  if (keys.length) return [...new Set(keys)];
  if (!change.beforePayload && change.afterPayload) return Object.keys(change.afterPayload);
  return [];
}

function getRelativeChangedPaths(change, sectionKey) {
  const paths = Array.isArray(change.changedPaths) ? change.changedPaths : [];
  return paths
    .filter((path) => String(path || '').split('.')[0] === sectionKey)
    .map((path) => String(path).split('.').slice(1).join('.'))
    .filter(Boolean);
}

function getSectionDiffEntries(change, sectionKey) {
  const beforeSection = change.beforePayload ? change.beforePayload[sectionKey] : undefined;
  const afterSection = change.afterPayload ? change.afterPayload[sectionKey] : undefined;
  const relativePaths = getRelativeChangedPaths(change, sectionKey);

  if (!relativePaths.length) {
    return [{ label: getPersonFieldLabel(sectionKey), beforeValue: beforeSection, afterValue: afterSection }];
  }

  const entries = [];
  const seen = new Set();
  for (const relativePath of relativePaths) {
    const parts = relativePath.split('.').filter(Boolean);
    let entryPath = relativePath;
    if (Array.isArray(beforeSection) || Array.isArray(afterSection)) {
      entryPath = parts[0] || relativePath;
    } else if (parts.length > 1 && isPlainObject(beforeSection?.[parts[0]]) && isPlainObject(afterSection?.[parts[0]])) {
      entryPath = parts[0];
    }

    if (seen.has(entryPath)) continue;
    seen.add(entryPath);
    entries.push({
      label: entryPath,
      beforeValue: getValueAtPath(beforeSection, entryPath),
      afterValue: getValueAtPath(afterSection, entryPath),
    });
  }

  return entries.length ? entries : [{ label: getPersonFieldLabel(sectionKey), beforeValue: beforeSection, afterValue: afterSection }];
}

function renderChangedSectionCard(change, sectionKey) {
  const label = getPersonFieldLabel(sectionKey);
  const entries = getSectionDiffEntries(change, sectionKey);

  return `
    <section class="field-block person-card-section agent-section-diff" data-section-key="${escapeHtml(sectionKey)}">
      <h3 class="field-title">${escapeHtml(label)}</h3>
      ${entries.map((entry) => `
        <div class="agent-section-subdiff">
          ${entries.length > 1 ? `<div class="agent-section-subtitle">${escapeHtml(entry.label)}</div>` : ''}
          ${renderCompactDiffRows(sectionKey, entry.beforeValue, entry.afterValue, change)}
        </div>
      `).join('')}
    </section>
  `;
}

function renderChangeDiff(change) {
  const sections = getChangedSectionKeys(change);
  if (!sections.length) {
    return `
      <section class="field-block person-card-section agent-section-diff">
        <h3 class="field-title">Изменение</h3>
        ${renderCompactDiffRows('payload', change.beforePayload, change.afterPayload, change)}
      </section>
    `;
  }

  return sections.map((sectionKey) => renderChangedSectionCard(change, sectionKey)).join('');
}

function formatChangeSummary(change) {
  const paths = Array.isArray(change.changedPaths) ? change.changedPaths : [];
  const sections = [...new Set(paths.map((path) => String(path || '').split('.')[0]).filter(Boolean))];
  return sections.length
    ? sections.map((sectionKey) => getPersonFieldLabel(sectionKey)).join(', ')
    : 'Карточка изменена.';
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
    const diff = renderChangeDiff(change);
    const disabled = change.reverted ? ' disabled' : '';

    return `
      <details class="agent-change-card" ${index === 0 ? 'open' : ''}>
        <summary>
          <span>${title}</span>
          <small>${change.reverted ? 'отменено' : summary}</small>
        </summary>
        <div class="agent-change-body">
          <div class="agent-change-actions">
            <a class="toolbar-link toolbar-link-subtle" href="./edit.html?id=${encodeURIComponent(change.personId)}">Открыть в редакторе</a>
            <button class="toolbar-button toolbar-button-subtle" type="button" data-revert-change="${index}"${disabled}>${change.beforePayload ? 'Откатить' : 'Удалить созданную'}</button>
          </div>
          <div class="agent-diff-list">${diff}</div>
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

async function stopActiveJob() {
  if (!isSending || isStopping) return;
  isStopping = true;
  syncSendingState();
  try {
    if (activeJobId) await cancelAgentJob(activeJobId);
    activeRunAbortController?.abort();
  } catch (error) {
    console.error(error);
    pushMessage({
      role: 'status',
      tone: 'error',
      content: `Не удалось остановить запрос: ${error.message}`,
      isTechnical: true,
    });
  }
}

async function sendPromptToAgent(prompt, { replaceUserMessageId = null } = {}) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) return;

  if (replaceUserMessageId) {
    updateMessage(replaceUserMessageId, { content: normalizedPrompt });
    truncateMessagesAfter(replaceUserMessageId);
  } else {
    pushMessage({ role: 'user', content: normalizedPrompt });
  }
  agentPrompt.value = '';
  editingMessageId = null;

  isSending = true;
  isStopping = false;
  activeJobId = '';
  activeRunAbortController = null;
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
    activeJobId = jobId;
    updateMessage(statusMessageId, {
      content: `Задача создана: ${jobId}`,
    });

    let runError = null;
    activeRunAbortController = new AbortController();
    const runPromise = runAgentJob(jobId, { signal: activeRunAbortController.signal }).catch((error) => {
      if (error?.name === 'AbortError') return { aborted: true };
      runError = error;
      return { runError: error };
    });
    const snapshot = await pollAgentJob(jobId, statusMessageId, () => runError);
    if (['completed', 'failed', 'timeout', 'cancelled'].includes(snapshot?.job?.status)) {
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
    isStopping = false;
    activeJobId = '';
    activeRunAbortController = null;
    syncSendingState();
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (isSending) {
    await stopActiveJob();
    return;
  }

  const prompt = String(agentPrompt.value || '').trim();
  if (!prompt) return;
  await sendPromptToAgent(prompt, { replaceUserMessageId: editingMessageId });
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
    agentMessages.addEventListener('click', async (event) => {
      const editButton = event.target.closest('[data-edit-message]');
      const copyButton = event.target.closest('[data-copy-message]');
      const retryButton = event.target.closest('[data-retry-message]');

      if (editButton) {
        const message = messages.find((item) => item.id === Number(editButton.dataset.editMessage));
        if (!message || message.role !== 'user' || isSending) return;
        editingMessageId = message.id;
        agentPrompt.value = message.content || '';
        agentPrompt.focus();
        return;
      }

      if (copyButton) {
        const message = messages.find((item) => item.id === Number(copyButton.dataset.copyMessage));
        if (!message) return;
        await copyTextToClipboard(message.content || '');
        return;
      }

      if (retryButton) {
        if (isSending) return;
        const messageIndex = messages.findIndex((item) => item.id === Number(retryButton.dataset.retryMessage));
        if (messageIndex < 0) return;
        const userMessageIndex = findPreviousUserMessageIndex(messageIndex);
        if (userMessageIndex < 0) return;
        const userMessage = messages[userMessageIndex];
        await sendPromptToAgent(userMessage.content, { replaceUserMessageId: userMessage.id });
      }
    });
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
