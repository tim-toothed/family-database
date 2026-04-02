import {
  addDraftArrayItem,
  buildPersonOptionEntries,
  createDraftFromSchema,
  hydrateDraftForEditor,
  loadEditorDescriptions,
  loadEditorSchema,
  removeDraftArrayItem,
  renderEditablePersonDetails,
  setAliveState,
  setDivorcedState,
  syncNameChangeDateField,
  updateDraftValue,
  validateEditorPersonDraft,
} from './person-editor.js';
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
const savePersonButton = document.getElementById('savePersonButton');
const newPersonButton = document.getElementById('newPersonButton');
const personJumpSelect = document.getElementById('personJumpSelect');
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
  editorSubtitle.textContent = isCreatingNew
    ? 'Новая карточка'
    : preview.subtitle;
  document.title = `${preview.title} — редактор карточки`;
}

function bindEditorEvents() {
  editorBody.querySelectorAll('[data-path]').forEach((input) => {
    const syncDraftValue = () => {
      const pathString = String(input.dataset.path || '');
      if (pathString.endsWith('.reason') && pathString.includes('name_changes.')) {
        syncNameChangeDateField(draft, pathString, input.value);
        renderEditor();
        setBannerMessage('');
        return;
      }

      updateDraftValue(draft, pathString, input.value);
      refreshHeader();
      setBannerMessage('');
    };

    input.addEventListener('input', syncDraftValue);
    input.addEventListener('change', syncDraftValue);
  });

  editorBody.querySelectorAll('[data-action="add-array-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      addDraftArrayItem(draft, schema, button.dataset.arrayPath);
      renderEditor();
      setBannerMessage('');
    });
  });

  editorBody.querySelectorAll('[data-action="remove-array-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      removeDraftArrayItem(draft, button.dataset.arrayPath, Number(button.dataset.index));
      renderEditor();
      setBannerMessage('');
    });
  });

  editorBody.querySelectorAll('[data-action="toggle-alive"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      setAliveState(draft, checkbox.checked);
      renderEditor();
      setBannerMessage('');
    });
  });

  editorBody.querySelectorAll('[data-action="toggle-divorced"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      setDivorcedState(draft, checkbox.dataset.divorcePath, checkbox.checked);
      renderEditor();
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
}

function populatePersonOptions() {
  const { entries, optionValueToId: lookup } = buildPersonOptionEntries(dataset);
  personOptionEntries = entries;
  optionValueToId = lookup;
  personOptions.innerHTML = entries
    .map((entry) => `<option value="${entry.label}"></option>`)
    .join('');

  if (personJumpSelect) {
    personJumpSelect.innerHTML = [
      '<option value="">Перейти к карточке...</option>',
      ...entries.map((entry) => `<option value="${entry.id}">${entry.label}</option>`),
    ].join('');
    personJumpSelect.value = personId || '';
  }
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

function openNewPersonDraft() {
  isCreatingNew = true;
  personId = null;
  draft = createDraftFromSchema(schema);
  draft.id = computeNextPersonId();
  renderEditor();
  syncSaveButtonState();
  if (personJumpSelect) personJumpSelect.value = '';
  setBannerMessage('Заполните обязательные поля и сохраните новую карточку.', 'info');

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete('id');
  nextUrl.searchParams.set('new', '1');
  window.history.replaceState({}, '', nextUrl);
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
    if (isCreatingNew) {
      await createEditablePerson(nextPersonId, validation.normalized);
      personId = nextPersonId;
      isCreatingNew = false;
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('id', personId);
      nextUrl.searchParams.delete('new');
      window.history.replaceState({}, '', nextUrl);
    } else {
      await saveEditablePerson(personId, validation.normalized);
    }

    draft = hydrateDraftForEditor(validation.normalized, schema, dataset.indexById);
    const nextTitle = renderEditablePersonDetails(personId, validation.normalized, schema, descriptions, {
      personOptionEntries,
      enumListIdPrefix: 'editorEnum',
    })?.title || personId;
    dataset.indexById.set(personId, nextTitle);
    populatePersonOptions();
    renderEditor();
    setBannerMessage(
      wasCreatingNew
        ? 'Карточка создана в Supabase.'
        : 'Изменения сохранены в Supabase.',
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
  personJumpSelect?.addEventListener('change', () => {
    const targetId = String(personJumpSelect.value || '').trim();
    if (!targetId) return;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('id', targetId);
    nextUrl.searchParams.delete('new');
    window.location.href = nextUrl.toString();
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
      openNewPersonDraft();
    } else if (requestedId) {
      personId = requestedId;
      const loadedPerson = await loadEditablePerson(personId);
      if (!loadedPerson) {
        showError(`Карточка ${personId} не найдена в Supabase.`);
        return;
      }
      draft = hydrateDraftForEditor(loadedPerson, schema, dataset.indexById);
      renderEditor();
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

init();
