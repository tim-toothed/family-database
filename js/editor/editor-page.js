import {
  addOtherInfoEntry,
  addDraftArrayItem,
  buildPersonOptionEntries,
  createDraftFromSchema,
  hydrateDraftForEditor,
  loadEditorDescriptions,
  loadEditorSchema,
  removeOtherInfoEntry,
  removeDraftArrayItem,
  renderEditablePersonDetails,
  setAliveState,
  setDivorcedState,
  syncNameChangeDateField,
  updateDraftValue,
  validateEditorPersonDraft,
} from './person-editor.js';
import { collectDocumentSnippetTokens } from '../document-links.js';
import {
  createEditablePerson,
  loadEditablePerson,
  loadPeopleIndex,
  saveEditablePerson,
} from './supabase-editor-store.js';

const editorLoading = document.getElementById('editorLoading');
const editorError = document.getElementById('editorError');
const editorShell = document.getElementById('editorShell');
const editorTitle = document.getElementById('editorTitle');
const editorSubtitle = document.getElementById('editorSubtitle');
const editorBody = document.getElementById('editorBody');
const editorSectionNav = document.getElementById('editorSectionNav');
const editorSectionNavToggle = document.getElementById('editorSectionNavToggle');
const editorSectionNavCurrent = document.getElementById('editorSectionNavCurrent');
const editorSectionNavList = document.getElementById('editorSectionNavList');
const savePersonButton = document.getElementById('savePersonButton');
const newPersonButton = document.getElementById('newPersonButton');
const personJumpInput = document.getElementById('personJumpInput');
const validationMessage = document.getElementById('validationMessage');
const personOptions = document.getElementById('editorPersonOptions');

let dataset;
let schema;
let descriptions;
let personId = null;
let draft = null;
let optionValueToId = new Map();
let personOptionEntries = [];
let isSaving = false;
let isCreatingNew = false;
let lastSavedDraftSnapshot = '';
let hasUnsavedChanges = false;
let suppressBeforeUnloadPrompt = false;
let sectionObserver = null;
let sectionNavOpen = false;
let activeEditorSectionId = '';
const LINK_MASK_URL_RE = /(https?:\/\/[^\s<>"']+|doc:\/\/[^\s<>"']+)/giu;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function collectLinkMaskTokens(value) {
  const source = String(value || '');
  const tokens = collectDocumentSnippetTokens(source).map((token) => ({
    text: token.raw,
    start: token.start,
    end: token.end,
  }));
  let match;

  LINK_MASK_URL_RE.lastIndex = 0;
  while ((match = LINK_MASK_URL_RE.exec(source))) {
    let url = match[0];
    let end = match.index + url.length;

    while (url && /[),.;!?]$/.test(url)) {
      url = url.slice(0, -1);
      end -= 1;
    }

    if (!url) continue;
    tokens.push({
      text: url,
      start: match.index,
      end,
    });
  }

  return tokens.sort((left, right) => left.start - right.start || left.end - right.end);
}

function buildMaskedLinkHtml(value) {
  const source = String(value || '');
  const tokens = collectLinkMaskTokens(source);
  if (!tokens.length) {
    return '';
  }

  let cursor = 0;
  let html = '';

  for (const token of tokens) {
    if (token.start > cursor) {
      html += escapeHtml(source.slice(cursor, token.start));
    }

    html += `<span class="editor-link-token" data-link-start="${token.start}" data-link-end="${token.end}">[link]</span>`;
    cursor = token.end;
  }

  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor));
  }

  return html
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>');
}

function updateLinkMaskedField(shell) {
  const input = shell.querySelector('.editor-link-mask-target');
  const overlay = shell.querySelector('[data-link-mask-overlay]');
  if (!input || !overlay) return;

  const maskedHtml = buildMaskedLinkHtml(input.value);
  const hasLinks = Boolean(maskedHtml);
  const isEditing = document.activeElement === input && !input.disabled;

  shell.classList.toggle('has-links', hasLinks);
  shell.classList.toggle('is-editing', isEditing);
  shell.classList.toggle('is-masked', hasLinks && !isEditing);
  overlay.classList.toggle('hidden', !hasLinks || isEditing);
  overlay.innerHTML = hasLinks ? maskedHtml : '';
}

function focusMaskedLinkTarget(input, token) {
  if (input.disabled) return;
  input.focus();

  if (!token) return;
  const start = Number(token.dataset.linkStart);
  const end = Number(token.dataset.linkEnd);
  if (Number.isFinite(start) && Number.isFinite(end) && typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(start, end);
  }
}

function initializeLinkMaskedFields() {
  editorBody.querySelectorAll('[data-link-mask-shell]').forEach((shell) => {
    const input = shell.querySelector('.editor-link-mask-target');
    const overlay = shell.querySelector('[data-link-mask-overlay]');
    if (!input || !overlay) return;

    const refresh = () => updateLinkMaskedField(shell);

    input.addEventListener('focus', refresh);
    input.addEventListener('blur', () => {
      window.requestAnimationFrame(refresh);
    });
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);

    overlay.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    overlay.addEventListener('click', (event) => {
      const token = event.target.closest('.editor-link-token');
      focusMaskedLinkTarget(input, token);
    });

    refresh();
  });
}

function getEditorSections() {
  return Array.from(editorBody.querySelectorAll('[data-editor-section]'));
}

function setSectionNavOpen(nextOpen) {
  if (!editorSectionNav || editorSectionNav.hidden) {
    sectionNavOpen = false;
    return;
  }

  sectionNavOpen = Boolean(nextOpen);
  editorSectionNav.classList.toggle('is-open', sectionNavOpen);
  editorSectionNavToggle?.setAttribute('aria-expanded', String(sectionNavOpen));
}

function setActiveEditorSection(sectionId) {
  activeEditorSectionId = sectionId || '';

  let currentLabel = 'Навигация';
  editorSectionNavList?.querySelectorAll('[data-target-section]').forEach((button) => {
    const isActive = button.dataset.targetSection === activeEditorSectionId;
    button.classList.toggle('is-active', isActive);
    if (isActive) {
      currentLabel = button.dataset.sectionLabel || button.textContent || currentLabel;
    }
  });

  if (editorSectionNavCurrent) {
    editorSectionNavCurrent.textContent = currentLabel;
  }
}

function syncSectionNavVisibility() {
  if (!editorSectionNav || editorSectionNav.hidden) return;

  const shouldShow = getEditorSections().length > 1 && window.scrollY > 180;
  editorSectionNav.classList.toggle('is-visible', shouldShow);

  if (!shouldShow) {
    setSectionNavOpen(false);
  }
}

function rebuildSectionObserver(sections) {
  if (sectionObserver) {
    sectionObserver.disconnect();
    sectionObserver = null;
  }

  if (!sections.length) return;

  sectionObserver = new IntersectionObserver((entries) => {
    const visibleEntries = entries
      .filter((entry) => entry.isIntersecting)
      .sort((left, right) => (
        right.intersectionRatio - left.intersectionRatio
        || left.boundingClientRect.top - right.boundingClientRect.top
      ));

    if (visibleEntries[0]) {
      setActiveEditorSection(visibleEntries[0].target.id);
      return;
    }

    const closestSection = sections.find((section) => section.getBoundingClientRect().top >= 120)
      || sections[sections.length - 1];
    if (closestSection) {
      setActiveEditorSection(closestSection.id);
    }
  }, {
    rootMargin: '-18% 0px -58% 0px',
    threshold: [0, 0.1, 0.25, 0.5, 0.8],
  });

  sections.forEach((section) => {
    sectionObserver.observe(section);
  });
}

function buildSectionNavigation() {
  if (!editorSectionNav || !editorSectionNavList) return;

  const sections = getEditorSections();
  editorSectionNavList.replaceChildren();

  if (sections.length <= 1) {
    editorSectionNav.hidden = true;
    setSectionNavOpen(false);
    if (sectionObserver) {
      sectionObserver.disconnect();
      sectionObserver = null;
    }
    return;
  }

  sections.forEach((section) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'editor-section-nav-item';
    button.dataset.targetSection = section.id;
    button.dataset.sectionLabel = section.dataset.sectionLabel || section.id;
    button.textContent = section.dataset.sectionLabel || section.id;
    button.addEventListener('click', () => {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveEditorSection(section.id);
      setSectionNavOpen(false);
    });
    editorSectionNavList.append(button);
  });

  editorSectionNav.hidden = false;
  const preferredSection = sections.find((section) => section.id === activeEditorSectionId) || sections[0];
  setActiveEditorSection(preferredSection.id);
  rebuildSectionObserver(sections);
  syncSectionNavVisibility();
}

function serializeDraftSnapshot(personDraft = draft) {
  return JSON.stringify(personDraft ?? {});
}

function syncUnsavedChangesState() {
  hasUnsavedChanges = Boolean(draft) && serializeDraftSnapshot() !== lastSavedDraftSnapshot;
}

function markDraftAsSaved() {
  lastSavedDraftSnapshot = serializeDraftSnapshot();
  hasUnsavedChanges = false;
}

function confirmDiscardUnsavedChanges() {
  if (!hasUnsavedChanges) return true;
  return window.confirm('Есть несохраненные изменения. Если продолжить, они будут потеряны.');
}

function handleBeforeUnload(event) {
  if (!hasUnsavedChanges || suppressBeforeUnloadPrompt) return;
  event.preventDefault();
  event.returnValue = '';
}

function setBannerMessage(message = '', tone = 'info') {
  validationMessage.textContent = message;
  validationMessage.classList.toggle('is-error', tone === 'error');
  validationMessage.classList.toggle('is-valid', tone === 'valid');
  validationMessage.classList.toggle('is-info', tone === 'info');
}

function showError(message) {
  editorLoading.hidden = true;
  editorShell.hidden = true;
  editorError.hidden = false;
  editorError.textContent = message;
}

function getDraftPersonId() {
  return String(draft?.id || personId || '').trim();
}

function getPreviewPersonId() {
  return getDraftPersonId() || 'Новая карточка';
}

function syncSaveButtonState() {
  if (!savePersonButton) return;
  savePersonButton.disabled = isSaving;
  savePersonButton.textContent = isSaving
    ? 'Сохранение...'
    : isCreatingNew
      ? 'Создать в Supabase'
      : 'Сохранить в Supabase';
}

function refreshHeader() {
  const preview = renderEditablePersonDetails(getPreviewPersonId(), draft, schema, descriptions, {
    personOptionEntries,
    enumListIdPrefix: 'editorEnum',
  });
  if (!preview) return;

  editorTitle.textContent = preview.title;
  editorSubtitle.textContent = isCreatingNew ? 'Новая карточка' : preview.subtitle;
  document.title = `${preview.title} — редактор карточки`;
}

function bindEditorEvents() {
  editorBody.querySelectorAll('[data-path]').forEach((input) => {
    const syncDraftValue = () => {
      const pathString = String(input.dataset.path || '');
      if (pathString.endsWith('.reason') && pathString.includes('name_changes.')) {
        syncNameChangeDateField(draft, pathString, input.value);
        renderEditor();
        syncUnsavedChangesState();
        setBannerMessage('');
        return;
      }

      updateDraftValue(draft, pathString, input.value);
      refreshHeader();
      syncUnsavedChangesState();
      setBannerMessage('');
    };

    input.addEventListener('input', syncDraftValue);
    input.addEventListener('change', syncDraftValue);
  });

  initializeLinkMaskedFields();

  editorBody.querySelectorAll('[data-action="add-array-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      addDraftArrayItem(draft, schema, button.dataset.arrayPath);
      renderEditor();
      syncUnsavedChangesState();
      setBannerMessage('');
    });
  });

  editorBody.querySelectorAll('[data-action="remove-array-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      removeDraftArrayItem(draft, button.dataset.arrayPath, Number(button.dataset.index));
      renderEditor();
      syncUnsavedChangesState();
      setBannerMessage('');
    });
  });

  editorBody.querySelectorAll('[data-action="toggle-alive"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      setAliveState(draft, checkbox.checked);
      renderEditor();
      syncUnsavedChangesState();
      setBannerMessage('');
    });
  });

  editorBody.querySelectorAll('[data-action="toggle-divorced"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      setDivorcedState(draft, checkbox.dataset.divorcePath, checkbox.checked);
      renderEditor();
      syncUnsavedChangesState();
      setBannerMessage('');
    });
  });

  editorBody.querySelectorAll('[data-action="add-other-info-entry"]').forEach((button) => {
    button.addEventListener('click', () => {
      addOtherInfoEntry(draft, button.dataset.otherInfoPath);
      renderEditor();
      syncUnsavedChangesState();
      setBannerMessage('');
    });
  });

  editorBody.querySelectorAll('[data-action="remove-other-info-entry"]').forEach((button) => {
    button.addEventListener('click', () => {
      removeOtherInfoEntry(draft, button.dataset.otherInfoPath, button.dataset.otherInfoKey);
      renderEditor();
      syncUnsavedChangesState();
      setBannerMessage('');
    });
  });
}

function renderEditor() {
  const view = renderEditablePersonDetails(getPreviewPersonId(), draft, schema, descriptions, {
    personOptionEntries,
    enumListIdPrefix: 'editorEnum',
  });
  if (!view) {
    showError('Не удалось построить форму редактирования.');
    return;
  }

  editorTitle.textContent = view.title;
  editorSubtitle.textContent = isCreatingNew ? 'Новая карточка' : view.subtitle;
  editorBody.innerHTML = view.html;
  bindEditorEvents();
  buildSectionNavigation();
}

function resolvePersonJumpTarget(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (dataset?.indexById?.has(normalized)) return normalized;
  if (optionValueToId.has(normalized)) return optionValueToId.get(normalized);

  const match = normalized.match(/\[(P\d+)\]$/i) || normalized.match(/^(P\d+)$/i);
  if (!match) return null;

  const normalizedId = match[1].toUpperCase();
  return dataset?.indexById?.has(normalizedId) ? normalizedId : null;
}

function syncPersonJumpInputValue() {
  if (!personJumpInput) return;
  personJumpInput.value = '';
}

function populatePersonOptions() {
  const { entries, optionValueToId: lookup } = buildPersonOptionEntries(dataset);
  personOptionEntries = entries;
  optionValueToId = lookup;
  personOptions.innerHTML = entries
    .map((entry) => `<option value="${entry.label}"></option>`)
    .join('');
  syncPersonJumpInputValue();
}

function computeNextPersonId() {
  const ids = Array.from(dataset.indexById.keys());
  const numericIds = ids
    .map((id) => String(id || '').trim().match(/^P(\d+)$/i))
    .filter(Boolean)
    .map((match) => Number(match[1]));

  if (!numericIds.length) return 'P001';

  const maxId = Math.max(...numericIds);
  const width = Math.max(3, String(maxId + 1).length);
  return `P${String(maxId + 1).padStart(width, '0')}`;
}

function openNewPersonDraft(options = {}) {
  const { force = false } = options;
  if (!force && !confirmDiscardUnsavedChanges()) {
    return false;
  }

  isCreatingNew = true;
  personId = null;
  draft = createDraftFromSchema(schema);
  draft.id = computeNextPersonId();
  markDraftAsSaved();
  renderEditor();
  syncSaveButtonState();
  syncPersonJumpInputValue();
  setBannerMessage('Заполните обязательные поля и сохраните новую карточку.', 'info');

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete('id');
  nextUrl.searchParams.set('new', '1');
  window.history.replaceState({}, '', nextUrl);
  return true;
}

async function saveCurrentPerson() {
  if (!draft || !schema || isSaving) return;
  const wasCreatingNew = isCreatingNew;

  const validation = validateEditorPersonDraft(draft, schema, {
    peopleById: dataset.indexById,
    optionValueToId,
    requireNonIdContent: isCreatingNew,
  });

  if (!validation.valid) {
    setBannerMessage(validation.errors[0] || 'Не удалось проверить карточку.', 'error');
    return;
  }

  const nextPersonId = String(validation.normalized.id || '').trim();
  if (!nextPersonId) {
    setBannerMessage('Укажите ID для карточки.', 'error');
    return;
  }

  if (isCreatingNew && dataset.indexById.has(nextPersonId)) {
    setBannerMessage(`Карточка ${nextPersonId} уже существует. Укажите другой ID.`, 'error');
    return;
  }

  if (!isCreatingNew && nextPersonId !== personId) {
    setBannerMessage('Изменение ID у существующей карточки через онлайн-редактор пока не поддерживается.', 'error');
    return;
  }

  isSaving = true;
  syncSaveButtonState();

  try {
    let saveResult;
    if (isCreatingNew) {
      saveResult = await createEditablePerson(nextPersonId, validation.normalized);
      personId = nextPersonId;
      isCreatingNew = false;
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('id', personId);
      nextUrl.searchParams.delete('new');
      window.history.replaceState({}, '', nextUrl);
    } else {
      saveResult = await saveEditablePerson(personId, validation.normalized);
    }

    draft = hydrateDraftForEditor(validation.normalized, schema, dataset.indexById);
    markDraftAsSaved();
    const nextTitle = renderEditablePersonDetails(personId, validation.normalized, schema, descriptions, {
      personOptionEntries,
      enumListIdPrefix: 'editorEnum',
    })?.title || personId;
    dataset.indexById.set(personId, nextTitle);
    populatePersonOptions();
    renderEditor();
    syncPersonJumpInputValue();
    const synchronizedIds = Array.isArray(saveResult?.synchronizedIds) ? saveResult.synchronizedIds : [];
    const skippedIds = Array.isArray(saveResult?.skippedIds) ? saveResult.skippedIds : [];
    const baseMessage = wasCreatingNew
      ? 'Карточка создана в Supabase.'
      : 'Изменения сохранены в Supabase.';
    const syncMessage = synchronizedIds.length
      ? ` Синхронизированы карточки: ${synchronizedIds.join(', ')}.`
      : '';
    const skippedMessage = skippedIds.length
      ? ` Не удалось обновить карточки: ${skippedIds.join(', ')}.`
      : '';
    setBannerMessage(
      `${baseMessage}${syncMessage}${skippedMessage}`,
      'valid'
    );
  } catch (error) {
    console.error(error);
    setBannerMessage(`Не удалось сохранить карточку: ${error.message}`, 'error');
  } finally {
    isSaving = false;
    syncSaveButtonState();
  }
}

function setupToolbarActions() {
  savePersonButton.addEventListener('click', saveCurrentPerson);
  newPersonButton?.addEventListener('click', () => {
    openNewPersonDraft();
  });

  editorSectionNavToggle?.addEventListener('click', () => {
    setSectionNavOpen(!sectionNavOpen);
  });

  document.addEventListener('click', (event) => {
    if (!sectionNavOpen || !editorSectionNav) return;
    if (editorSectionNav.contains(event.target)) return;
    setSectionNavOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sectionNavOpen) {
      setSectionNavOpen(false);
    }
  });

  window.addEventListener('scroll', syncSectionNavVisibility, { passive: true });
  window.addEventListener('resize', syncSectionNavVisibility);

  const openSelectedPerson = () => {
    const rawValue = String(personJumpInput?.value || '').trim();
    const targetId = resolvePersonJumpTarget(rawValue);

    if (targetId === '') return;
    if (!targetId) {
      setBannerMessage('Выберите существующую карточку из подсказок или введите ID в формате P123.', 'error');
      return;
    }
    if (targetId === personId && !isCreatingNew) {
      syncPersonJumpInputValue();
      return;
    }
    if (!confirmDiscardUnsavedChanges()) {
      syncPersonJumpInputValue();
      return;
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('id', targetId);
    nextUrl.searchParams.delete('new');
    suppressBeforeUnloadPrompt = true;
    window.location.href = nextUrl.toString();
  };

  personJumpInput?.addEventListener('input', () => {
    if (validationMessage.classList.contains('is-error')) {
      setBannerMessage('');
    }
  });
  personJumpInput?.addEventListener('change', openSelectedPerson);
  personJumpInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    openSelectedPerson();
  });
}

async function init() {
  try {
    const params = new URLSearchParams(window.location.search);
    const requestedId = params.get('id');
    const requestedNew = params.get('new') === '1';

    const [indexById, loadedSchema, loadedDescriptions] = await Promise.all([
      loadPeopleIndex(),
      loadEditorSchema(),
      loadEditorDescriptions(),
    ]);

    dataset = { indexById };
    schema = loadedSchema;
    descriptions = loadedDescriptions;

    populatePersonOptions();

    if (requestedNew) {
      openNewPersonDraft({ force: true });
    } else if (requestedId) {
      personId = requestedId;
      const loadedPerson = await loadEditablePerson(personId);
      if (!loadedPerson) {
        showError(`Карточка ${personId} не найдена в Supabase.`);
        return;
      }
      draft = hydrateDraftForEditor(loadedPerson, schema, dataset.indexById);
      markDraftAsSaved();
      renderEditor();
      syncPersonJumpInputValue();
    } else {
      showError('Не указан ID карточки. Откройте редактор с основной страницы или создайте новую карточку.');
      return;
    }

    editorLoading.remove();
    editorError.hidden = true;
    editorShell.hidden = false;
    if (!requestedNew) setBannerMessage('');

    setupToolbarActions();
    syncSaveButtonState();
  } catch (error) {
    console.error(error);
    showError(`Не удалось открыть редактор.\n\n${error.message}`);
  }
}

window.addEventListener('beforeunload', handleBeforeUnload);

init();
