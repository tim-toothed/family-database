import {
  addDraftArrayItem,
  buildPersonOptionEntries,
  hydrateDraftForEditor,
  loadEditorDescriptions,
  loadEditorSchema,
  removeDraftArrayItem,
  renderEditablePersonDetails,
  setAliveState,
  updateDraftValue,
  validatePersonDraft,
} from './person-editor.js';
import {
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
const validationMessage = document.getElementById('validationMessage');
const personOptions = document.getElementById('editorPersonOptions');

let dataset;
let schema;
let descriptions;
let personId = null;
let draft = null;
let optionValueToId = new Map();
let isSaving = false;

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

function syncSaveButtonState() {
  if (!savePersonButton) return;
  savePersonButton.disabled = isSaving;
  savePersonButton.textContent = isSaving
    ? 'Сохранение...'
    : 'Сохранить в Supabase';
}

function refreshHeader() {
  const preview = renderEditablePersonDetails(personId, draft, schema, descriptions, {
    personListId: 'editorPersonOptions',
    enumListIdPrefix: 'editorEnum',
  });
  if (!preview) return;
  editorTitle.textContent = preview.title;
  editorSubtitle.textContent = preview.subtitle;
  document.title = `${preview.title} — редактор карточки`;
}

function bindEditorEvents() {
  editorBody.querySelectorAll('[data-path]').forEach((input) => {
    input.addEventListener('input', () => {
      updateDraftValue(draft, input.dataset.path, input.value);
      refreshHeader();
      setBannerMessage('');
    });
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
}

function renderEditor() {
  const view = renderEditablePersonDetails(personId, draft, schema, descriptions, {
    personListId: 'editorPersonOptions',
    enumListIdPrefix: 'editorEnum',
  });
  if (!view) {
    showError('Не удалось построить форму редактирования.');
    return;
  }

  editorTitle.textContent = view.title;
  editorSubtitle.textContent = view.subtitle;
  editorBody.innerHTML = view.html;
  bindEditorEvents();
}

function populatePersonOptions() {
  const { entries, optionValueToId: lookup } = buildPersonOptionEntries(dataset);
  optionValueToId = lookup;
  personOptions.innerHTML = entries
    .map((entry) => `<option value="${entry.label}"></option>`)
    .join('');
}

async function saveCurrentPerson() {
  if (!draft || !schema || isSaving) return;

  const validation = validatePersonDraft(draft, schema, {
    peopleById: dataset.indexById,
    optionValueToId,
  });

  if (!validation.valid) {
    setBannerMessage(validation.errors[0] || 'Не удалось проверить карточку.', 'error');
    return;
  }

  if (validation.normalized.id !== personId) {
    setBannerMessage('Изменение ID через онлайн-редактор пока не поддерживается.', 'error');
    return;
  }

  isSaving = true;
  syncSaveButtonState();

  try {
    await saveEditablePerson(personId, validation.normalized);
    const nextTitle = renderEditablePersonDetails(personId, validation.normalized, schema, descriptions, {
      personListId: 'editorPersonOptions',
      enumListIdPrefix: 'editorEnum',
    })?.title || personId;
    dataset.indexById.set(personId, nextTitle);
    populatePersonOptions();
    setBannerMessage('Изменения сохранены в Supabase.', 'valid');
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
}

async function init() {
  try {
    const params = new URLSearchParams(window.location.search);
    personId = params.get('id');

    if (!personId) {
      showError('Не указан ID карточки. Откройте редактор с основной страницы.');
      return;
    }

    const [indexById, loadedPerson, loadedSchema, loadedDescriptions] = await Promise.all([
      loadPeopleIndex(),
      loadEditablePerson(personId),
      loadEditorSchema(),
      loadEditorDescriptions(),
    ]);

    dataset = { indexById };
    schema = loadedSchema;
    descriptions = loadedDescriptions;

    if (!loadedPerson) {
      showError(`Карточка ${personId} не найдена в Supabase.`);
      return;
    }

    populatePersonOptions();
    draft = hydrateDraftForEditor(loadedPerson, schema, dataset.indexById);
    renderEditor();

    editorLoading.remove();
    editorError.hidden = true;
    editorShell.hidden = false;
    setBannerMessage('');

    setupToolbarActions();
    syncSaveButtonState();
  } catch (error) {
    console.error(error);
    showError(`Не удалось открыть редактор.\n\n${error.message}`);
  }
}

init();
