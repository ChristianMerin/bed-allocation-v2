/* Login page */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const form = $('#login-form');
  const errBox = $('#login-error');
  const btn = $('#login-btn');

  // Where to go after login (the page the user was trying to open)
  const params = new URLSearchParams(location.search);
  const next = params.get('next') || '';
  const target = `./${/^#[a-z]+$/.test(next) ? next : ''}`;

  // Already signed in? Skip the form.
  fetch('/api/v1/auth/me', { credentials: 'same-origin' })
    .then((r) => { if (r.ok) location.replace(target); })
    .catch(() => {});

  if (params.get('reason') === 'expired') showError('Your session has ended. Please sign in again.');
  if (params.get('reason') === 'logout') showError('You have been signed out.', true);

  function showError(msg, info = false) {
    errBox.querySelector('span').textContent = msg;
    errBox.classList.toggle('info', info);
    errBox.classList.remove('hidden');
  }

  $('#reveal').addEventListener('click', () => {
    const p = $('#password');
    p.type = p.type === 'password' ? 'text' : 'password';
    $('#reveal').setAttribute('aria-label', p.type === 'password' ? 'Show password' : 'Hide password');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) return showError('Enter your username and password.');

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || 'Sign in failed');
      location.replace(target);
    } catch (err) {
      showError(err.message === 'Failed to fetch' ? 'Cannot reach the server. Is it running?' : err.message);
      $('#password').value = '';
      $('#password').focus();
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
})();
