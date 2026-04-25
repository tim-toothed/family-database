import { CONFIG } from './config.js';
import {
  getSupabaseAuthSession,
  signInWithSupabasePassword,
  signOutFromSupabase,
} from './db/supabase/client.js';
import { getRemoteDataSource } from './db/source.js';

let authSessionPromise = null;
const SUPABASE_AUTH_STORAGE_KEY = 'family-database-auth';

function getCachedAuthSession() {
  try {
    const raw = window.localStorage?.getItem(SUPABASE_AUTH_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const session = parsed?.currentSession || parsed;
    const expiresAt = Number(session?.expires_at || 0);
    if (!session?.access_token || (expiresAt && expiresAt * 1000 <= Date.now())) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function ensureAuthShell() {
  let shell = document.getElementById('authGate');
  if (shell) return shell;

  shell = document.createElement('section');
  shell.id = 'authGate';
  shell.className = 'auth-gate hidden';
  shell.innerHTML = `
    <form id="authGateForm" class="auth-card">
      <p class="auth-eyebrow">Закрытый семейный архив</p>
      <h2>Вход</h2>
      <p class="auth-copy">Введите email и пароль Supabase. Сессия сохранится в этом браузере.</p>
      <label class="auth-field">
        <span>Email</span>
        <input id="authEmailInput" type="email" autocomplete="email" required />
      </label>
      <label class="auth-field">
        <span>Пароль</span>
        <input id="authPasswordInput" type="password" autocomplete="current-password" required />
      </label>
      <button id="authSubmitButton" type="submit">Войти</button>
      <div id="authStatus" class="auth-status" aria-live="polite"></div>
    </form>
  `;
  document.body.append(shell);
  return shell;
}

function setAuthStatus(message = '', tone = 'neutral') {
  const status = document.getElementById('authStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function setAuthFormBusy(isBusy) {
  const submitButton = document.getElementById('authSubmitButton');
  const emailInput = document.getElementById('authEmailInput');
  const passwordInput = document.getElementById('authPasswordInput');
  if (submitButton) {
    submitButton.disabled = Boolean(isBusy);
    submitButton.textContent = isBusy ? 'Проверяю...' : 'Войти';
  }
  if (emailInput) emailInput.disabled = Boolean(isBusy);
  if (passwordInput) passwordInput.disabled = Boolean(isBusy);
}

function renderAuthToolbar(session) {
  if (!CONFIG.requireAuth) return;

  let container = document.getElementById('authToolbar');
  if (!container) {
    container = document.createElement('div');
    container.id = 'authToolbar';
    container.className = 'auth-toolbar';
    const target = document.querySelector('.toolbar, .editor-actions') || document.body;
    target.append(container);
  }

  const email = session?.user?.email || 'пользователь';
  container.innerHTML = `
    <span class="auth-toolbar-email">${email}</span>
    <button id="authSignOutButton" class="toolbar-button toolbar-button-subtle" type="button">Выйти</button>
  `;
  document.getElementById('authSignOutButton')?.addEventListener('click', async () => {
    await signOutFromSupabase();
    window.location.reload();
  });
}

async function waitForPasswordSignIn() {
  const shell = ensureAuthShell();
  const form = document.getElementById('authGateForm');
  const emailInput = document.getElementById('authEmailInput');
  const passwordInput = document.getElementById('authPasswordInput');
  shell.classList.remove('hidden');

  return new Promise((resolve, reject) => {
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      setAuthStatus('');
      setAuthFormBusy(true);

      try {
        const email = String(emailInput?.value || '').trim();
        const password = String(passwordInput?.value || '');
        const { data, error } = await signInWithSupabasePassword({ email, password });
        if (error) throw error;
        if (!data.session) throw new Error('Supabase не вернул сессию.');

        shell.classList.add('hidden');
        renderAuthToolbar(data.session);
        resolve(data.session);
      } catch (error) {
        setAuthStatus(error?.message || 'Не удалось войти.', 'error');
        setAuthFormBusy(false);
      }
    });
  });
}

export async function requireAuth() {
  if (!CONFIG.requireAuth) {
    return null;
  }

  if (!authSessionPromise) {
    authSessionPromise = (async () => {
      const cachedSession = getCachedAuthSession();
      if (cachedSession && getRemoteDataSource() === 'yandex') {
        renderAuthToolbar(cachedSession);
        return cachedSession;
      }

      const { data, error } = await getSupabaseAuthSession();
      if (error) throw error;

      if (data.session) {
        renderAuthToolbar(data.session);
        return data.session;
      }

      return waitForPasswordSignIn();
    })();
  }

  return authSessionPromise;
}
