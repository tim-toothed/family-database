import * as supabaseEditorStore from './supabase/editor-store.js';
import * as yandexEditorStore from './yandex/editor-store.js';
import { getRemoteDataSource } from './source.js';

function getStore() {
  return getRemoteDataSource() === 'yandex' ? yandexEditorStore : supabaseEditorStore;
}

export function loadPeopleIndex() {
  return getStore().loadPeopleIndex();
}

export function loadEditablePerson(personId) {
  return getStore().loadEditablePerson(personId);
}

export function saveEditablePerson(personId, payload) {
  return getStore().saveEditablePerson(personId, payload);
}

export function createEditablePerson(personId, payload) {
  return getStore().createEditablePerson(personId, payload);
}
