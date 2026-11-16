/* Bed Allocation & Inpatient Ward Management - staff dashboard (vanilla JS) */
(() => {
  'use strict';

  const API = '/api/v1';
  const CATEGORY_LABEL = { private: 'Private', 'semi-private': 'Semi-Private', ward: 'Ward' };

  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  const state = {
    user: null, // the signed-in user, from /auth/me
    meta: null,
    wards: [],
    beds: [],
    admPage: 1,
    filters: { ward: '', category: '', status: '', q: '' },
    collapsed: new Set(JSON.parse(store.get('ipd_collapsed', '[]') || '[]')),
  };

  /* ---------------- helpers ---------------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CURRENCY = '₱';
  const money = (n) => {
    const v = Number(n || 0);
    return CURRENCY + v.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  };
  const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
  const initials = (name) => String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
  const STATUS_LABEL = { available: 'Available', occupied: 'Occupied', reserved: 'Reserved', cleaning: 'Cleaning', maintenance: 'Maintenance' };
  const TYPE_LABEL = {
    general: 'General', medical: 'Medical', surgical: 'Surgical', pediatric: 'Pediatric', maternity: 'Maternity',
    orthopedic: 'Orthopedic', icu: 'Critical care', isolation: 'Isolation', other: 'Other',
  };
  const typeLabel = (t) => TYPE_LABEL[t] || t || '';
  const shortDate = (d) => (d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

  // The server's security headers (CSP) block inline style="" attributes,
  // so bar widths are passed as data-w and applied through the CSSOM instead.
  const applyWidths = () => $$('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  new MutationObserver(applyWidths).observe(document.body, { childList: true, subtree: true });
  const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const days = (from, to) => Math.max(0, ((to ? new Date(to) : new Date()) - new Date(from)) / 86400000);
  const catBadge = (c) => `<span class="badge cat-${esc(c)}">${esc(CATEGORY_LABEL[c] || c)}</span>`;
  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  function toast(msg, isError = false) {
    const t = $('#toast');
    t.innerHTML = `${icon(isError ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
    t.className = `show${isError ? ' error' : ''}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = ''; }, isError ? 5000 : 2800);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const res = await fetch(API + path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) {
      // Not signed in or the session expired -> back to the login page
      location.replace(`login.html?${state.user ? 'reason=expired&' : ''}next=${encodeURIComponent(location.hash)}`);
      throw new Error('Session ended');
    }
    if (!res.ok || json.success === false) {
      const detail = json.details ? ` (${json.details.map((d) => d.message).join('; ')})` : '';
      throw new Error((json.message || res.statusText) + detail);
    }
    return json;
  }

  // Wraps a form submit / button action with loading state + error toast
  async function run(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
  }

  /* ---------------- modal ---------------- */
  const modal = $('#modal');
  function openModal(title, html) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    if (!modal.open) modal.showModal();
    return $('#modal-body');
  }
  const closeModal = () => {
    if (modal.dataset.locked && state.user?.mustChangePassword) return; // must set a new password first
    modal.dataset.locked = '';
    if (modal.open) modal.close();
  };
  $('#modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  /* ---------------- data loading ---------------- */
  async function loadMeta() {
    state.meta = (await api('/meta')).data;
    $('#ward-type').innerHTML = state.meta.wardTypes.map((t) => `<option value="${t}">${t}</option>`).join('');
  }

  async function loadWards() {
    state.wards = (await api('/wards')).data;
    const opts = state.wards.map((w) => `<option value="${w._id}">${esc(w.name)} (${esc(w.code)})</option>`).join('');
    const current = $('#r-ward').value;
    $('#r-ward').innerHTML = `<option value="">All wards</option>${opts}`;
    $('#r-ward').value = current;
    if (state.filters.ward && !state.wards.some((w) => w._id === state.filters.ward)) state.filters.ward = '';
    renderWardTable();
  }

  async function loadBeds() {
    state.beds = (await api('/beds')).data;
    renderBoard();
  }

  // Stacked bar: occupied | reserved | cleaning | maintenance | available
  const stackBar = (c) => {
    const total = c.total || 1;
    return `<div class="stack" title="${c.occupied} occupied, ${c.reserved} reserved, ${c.cleaning} cleaning, ${c.maintenance} maintenance, ${c.available} available">${
      ['occupied', 'reserved', 'cleaning', 'maintenance', 'available'].map((k) => (c[k] ? `<span class="${k}" data-w="${(c[k] / total) * 100}"></span>` : '')).join('')}</div>`;
  };

  async function loadStats() {
    const s = (await api('/dashboard/summary')).data;
    const b = s.beds;
    const a = s.admissions;
    const classRows = Object.entries(s.byCategory).map(([cat, c]) => `
      <div class="class-row">
        <span>${catBadge(cat)}</span>
        ${stackBar(c)}
        <span class="free"><b>${c.available}</b> / ${c.total} free</span>
      </div>`).join('');
    $('#stats').innerHTML = `
      <div class="kpi">
        <div class="k-label">Occupancy</div>
        <div class="k-value">${b.occupancyRate}<small>%</small></div>
        <div class="k-bar"><span data-w="${Math.min(100, b.occupancyRate)}"></span></div>
        <div class="k-hint">${b.occupied} of ${b.total - b.maintenance} beds in service</div>
      </div>
      <div class="kpi good">
        <div class="k-label">Available now</div>
        <div class="k-value">${b.available}</div>
        <div class="k-hint">${b.reserved} reserved · ${b.cleaning} cleaning · ${b.maintenance} maintenance</div>
      </div>
      <div class="kpi">
        <div class="k-label">Inpatients</div>
        <div class="k-value">${a.currentInpatients}</div>
        <div class="k-hint">Avg stay (30 days): ${a.averageLengthOfStayDays30d ?? '—'} ${a.averageLengthOfStayDays30d !== null ? 'days' : ''}</div>
      </div>
      <div class="kpi">
        <div class="k-label">Today</div>
        <div class="k-value">${a.admittedToday}<small> in</small> · ${a.dischargedToday}<small> out</small></div>
        <div class="k-hint">Admissions and discharges since midnight</div>
      </div>
      <div class="kpi wide">
        <div class="k-label">By room class</div>
        <div class="class-rows">${classRows}</div>
      </div>`;
  }

  const refreshAll = () => Promise.all([loadStats(), loadWards(), loadBeds()]).catch((e) => toast(e.message, true));

  /* ---------------- bed board ---------------- */
  function bedMatchesQuery(b, q) {
    if (!q) return true;
    const p = b.currentAdmission?.patient;
    return [b.bedNumber, b.roomNumber, `room ${b.roomNumber}`, p?.name, p?.patientId, b.currentAdmission?.admissionNumber, b.reservation?.patientName, b.reservation?.patientId]
      .some((v) => v && String(v).toLowerCase().includes(q));
  }

  function renderFilters(baseBeds) {
    const f = state.filters;
    $('#f-ward-pills').innerHTML = [`<button type="button" class="pill ${!f.ward ? 'on' : ''}" data-ward="">All wards</button>`]
      .concat(state.wards.map((w) => `<button type="button" class="pill ${f.ward === w._id ? 'on' : ''}" data-ward="${w._id}" title="${esc(w.name)}">${esc(w.name)}</button>`)).join('');

    $('#f-cat-pills').innerHTML = [['', 'All classes'], ['private', 'Private'], ['semi-private', 'Semi-Private'], ['ward', 'Ward']]
      .map(([v, l]) => `<button type="button" data-cat="${v}" class="${f.category === v ? 'on' : ''}">${l}</button>`).join('');

    const counts = { '': baseBeds.length };
    for (const b of baseBeds) counts[b.status] = (counts[b.status] || 0) + 1;
    $('#f-status-pills').innerHTML = [['', 'All beds'], ...Object.entries(STATUS_LABEL)]
      .map(([v, l]) => `<button type="button" class="pill ${f.status === v ? 'on' : ''}" data-status="${v}">${v ? `<i class="dot ${v}"></i>` : ''}${l}<span class="count">${counts[v] || 0}</span></button>`).join('');
  }

  function renderBoard() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    // beds that pass ward/class/search filters (status counts are based on these)
    const base = state.beds.filter((b) => (!f.ward || b.ward?._id === f.ward) && (!f.category || b.category === f.category) && bedMatchesQuery(b, q));
    renderFilters(base);
    const beds = base.filter((b) => !f.status || b.status === f.status);

    if (!beds.length) {
      $('#board-grid').innerHTML = `<div class="card empty">${state.beds.length
        ? `No beds match ${q ? `“${esc(f.q)}”` : 'these filters'}. <button type="button" class="btn sm" data-clear-filters>Clear filters</button>`
        : 'No beds yet. Add wards in <a href="#setup">Wards</a>, then rooms in <a href="#rooms">Rooms</a>.'}</div>`;
      return;
    }

    const byWard = new Map();
    for (const b of beds) {
      const key = b.ward?._id || 'none';
      if (!byWard.has(key)) byWard.set(key, { ward: b.ward, rooms: new Map() });
      const w = byWard.get(key);
      if (!w.rooms.has(b.roomNumber)) w.rooms.set(b.roomNumber, []);
      w.rooms.get(b.roomNumber).push(b);
    }

    // Ward occupancy always uses ALL beds of the ward, not just filtered ones
    const wardTotals = (wardId) => {
      const all = state.beds.filter((b) => b.ward?._id === wardId);
      const c = { total: all.length };
      for (const s of Object.keys(STATUS_LABEL)) c[s] = all.filter((b) => b.status === s).length;
      return c;
    };
    const filtering = !!(q || f.status || f.category);

    $('#board-grid').innerHTML = [...byWard.entries()]
      .sort(([, a], [, b]) => (a.ward?.name || '').localeCompare(b.ward?.name || ''))
      .map(([wardId, { ward, rooms }]) => {
        const t = wardTotals(wardId);
        const collapsed = state.collapsed.has(wardId) && !filtering;
        const gender = ward?.genderPolicy === 'mixed' ? 'mixed gender' : `${ward?.genderPolicy} only`;
        return `
        <section class="ward-card ${collapsed ? 'collapsed' : ''}">
          <button type="button" class="ward-card-head" data-toggle="${wardId}" aria-expanded="${!collapsed}">
            <span class="ward-code">${esc(ward?.code)}</span>
            <span class="ward-ident">
              <h3>${esc(ward?.name)}</h3>
              <div class="ward-meta">${esc(typeLabel(ward?.type))} · Floor ${esc(ward?.floor || '—')} · ${esc(gender)}</div>
            </span>
            <span class="ward-occ">
              <span><b>${t.occupied}</b> / ${t.total} occupied · <b>${t.available}</b> free</span>
              ${stackBar(t)}
            </span>
            <span class="chev">${icon('chevron')}</span>
          </button>
          <div class="room-grid">
            ${[...rooms.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([room, rb]) => {
              const rates = [...new Set(rb.map((x) => x.dailyRate))];
              return `
              <div class="room-card ${rb.length > 2 ? 'wide' : ''}">
                <div class="room-card-head">
                  <span class="room-no">Room ${esc(room)}</span>
                  ${catBadge(rb[0].category)}
                  <span class="room-price">${rates.length === 1 ? money(rates[0]) : `${money(Math.min(...rates))}+`}/day</span>
                </div>
                <div class="bed-grid">${rb.map((b) => bedTile(b, q)).join('')}</div>
              </div>`;
            }).join('')}
          </div>
        </section>`;
      }).join('');
  }

  function bedTile(b, q) {
    const letter = b.bedNumber.split('-').pop();
    let name = STATUS_LABEL[b.status];
    let meta = '';
    if (b.status === 'occupied' && b.currentAdmission) {
      name = b.currentAdmission.patient?.name;
      const d = days(b.currentAdmission.admittedAt);
      meta = `Day ${Math.floor(d) + 1}`;
    } else if (b.status === 'reserved' && b.reservation) {
      meta = b.reservation.patientName || b.reservation.patientId;
    } else if (b.statusNote) {
      meta = b.statusNote;
    } else if (b.status === 'available') {
      meta = 'Ready';
    }
    const isMatch = q && bedMatchesQuery(b, q);
    return `<button type="button" class="bed s-${b.status} ${isMatch ? 'match' : ''}" data-bed="${b._id}" title="${esc(b.bedNumber)} · ${esc(STATUS_LABEL[b.status])}${meta ? ` · ${esc(meta)}` : ''}">
      <span class="bed-letter">${esc(letter)}</span>
      <span class="bed-info"><span class="bed-name">${esc(name)}</span><span class="bed-meta">${esc(meta)}</span></span>
    </button>`;
  }

  $('#board-grid').addEventListener('click', (e) => {
    const tile = e.target.closest('[data-bed]');
    if (tile) return openBed(tile.dataset.bed);
    const head = e.target.closest('[data-toggle]');
    if (head) {
      const id = head.dataset.toggle;
      if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
      store.set('ipd_collapsed', JSON.stringify([...state.collapsed]));
      head.closest('.ward-card').classList.toggle('collapsed', state.collapsed.has(id));
      head.setAttribute('aria-expanded', String(!state.collapsed.has(id)));
      return;
    }
    if (e.target.closest('[data-clear-filters]')) {
      state.filters = { ward: '', category: '', status: '', q: '' };
      $('#f-search').value = '';
      renderBoard();
    }
  });
  $('#f-ward-pills').addEventListener('click', (e) => {
    const p = e.target.closest('[data-ward]'); if (!p) return;
    state.filters.ward = p.dataset.ward; renderBoard();
  });
  $('#f-cat-pills').addEventListener('click', (e) => {
    const p = e.target.closest('[data-cat]'); if (!p) return;
    state.filters.category = p.dataset.cat; renderBoard();
  });
  $('#f-status-pills').addEventListener('click', (e) => {
    const p = e.target.closest('[data-status]'); if (!p) return;
    state.filters.status = p.dataset.status; renderBoard();
  });
  let boardSearchTimer;
  $('#f-search').addEventListener('input', (e) => {
    clearTimeout(boardSearchTimer);
    boardSearchTimer = setTimeout(() => { state.filters.q = e.target.value; renderBoard(); }, 150);
  });
  $('#btn-refresh').addEventListener('click', refreshAll);

  /* ---------------- bed detail modal ---------------- */
  async function openBed(bedId) {
    try {
      const [{ data: bed }, { data: activity }] = await Promise.all([api(`/beds/${bedId}`), api(`/beds/${bedId}/activity?limit=8`)]);
      const a = bed.currentAdmission;
      const rows = [
        ['Room class', catBadge(bed.category)],
        ['Price per day', `<b>${money(bed.dailyRate)}</b>`],
        ['Equipment', esc((bed.features || []).join(', ') || '—')],
      ];
      if (bed.statusNote) rows.push(['Note', esc(bed.statusNote)]);
      if (a) {
        rows.push(['Admission no.', esc(a.admissionNumber)]);
        rows.push(['Admitted', `${fmtDate(a.admittedAt)} <span class="muted">(${days(a.admittedAt).toFixed(1)} days)</span>`]);
        rows.push(['Doctor', esc(a.admittingDoctor?.name || '—')]);
        rows.push(['Diagnosis', esc(a.diagnosis || '—')]);
      }
      if (bed.status === 'reserved' && bed.reservation) {
        rows.push(['Reserved for', `${esc(bed.reservation.patientName || '')} (${esc(bed.reservation.patientId)})`]);
        rows.push(['Until', fmtDate(bed.reservation.reservedUntil)]);
      }

      const btns = [];
      if (bed.status === 'available') {
        btns.push('<button class="btn primary" data-act="admit">Admit patient here</button>');
        btns.push('<button class="btn" data-act="reserve">Reserve</button>');
        btns.push('<button class="btn" data-act="status" data-status="maintenance">Maintenance</button>');
      }
      if (bed.status === 'reserved') {
        btns.push('<button class="btn primary" data-act="admit">Admit reserved patient</button>');
        btns.push('<button class="btn" data-act="release">Release reservation</button>');
      }
      if (bed.status === 'cleaning') {
        btns.push('<button class="btn primary" data-act="status" data-status="available">Mark clean → Available</button>');
        btns.push('<button class="btn" data-act="status" data-status="maintenance">Maintenance</button>');
      }
      if (bed.status === 'maintenance') {
        btns.push('<button class="btn primary" data-act="status" data-status="available">Back in service</button>');
      }
      if (bed.status === 'occupied' && a) {
        btns.push('<button class="btn primary" data-act="transfer">Transfer</button>');
        btns.push('<button class="btn danger" data-act="discharge">Discharge</button>');
        btns.push('<button class="btn" data-act="charges">Room charges</button>');
      }
      if (bed.status !== 'occupied') btns.push('<button class="btn ghost admin-only" data-act="deactivate">Remove bed</button>');

      const body = openModal(`Bed ${bed.bedNumber}`, `
        <div class="bed-hero s-${bed.status}">
          <span class="bed-letter">${esc(bed.bedNumber.split('-').pop())}</span>
          <div>
            <h3>${esc(bed.bedNumber)}</h3>
            <p>${esc(bed.ward?.name)} · Room ${esc(bed.roomNumber)} · ${esc(bed.ward?.floor || '')}</p>
          </div>
          <span class="hero-status">${esc(STATUS_LABEL[bed.status])}</span>
        </div>
        ${a ? `<div class="patient-box"><span class="avatar">${esc(initials(a.patient.name))}</span><div><b>${esc(a.patient.name)}</b><div class="sub">${esc(a.patient.patientId)} · ${esc(a.patient.gender)}</div></div></div>` : ''}
        <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        <div class="btn-row">${btns.join('')}</div>
        <div class="section-title">Recent activity</div>
        <ul class="activity">${activity.map((x) => `<li><time>${fmtDate(x.createdAt)}</time><span><b>${esc(x.action)}</b> ${x.fromStatus ? `${esc(x.fromStatus)} → ${esc(x.toStatus)}` : ''} ${x.admissionNumber ? `· ${esc(x.admissionNumber)}` : ''} ${x.note ? `· ${esc(x.note)}` : ''} <span class="muted">by ${esc(x.actor?.name || 'system')}</span></span></li>`).join('') || '<li class="muted">No activity</li>'}</ul>`);

      body.querySelector('.btn-row').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'admit') return openAdmit({ bed });
        if (act === 'transfer') return openTransfer(a, bed.ward?._id);
        if (act === 'discharge') return openDischarge(a);
        if (act === 'charges') return openCharges(a._id);
        if (act === 'reserve') return openReserve(bed);
        run(btn, async () => {
          if (act === 'status') await api(`/beds/${bed._id}/status`, { method: 'PATCH', body: { status: btn.dataset.status } });
          if (act === 'release') await api(`/beds/${bed._id}/release`, { method: 'POST' });
          if (act === 'deactivate') {
            if (!confirm(`Remove bed ${bed.bedNumber}? Its history is kept.`)) return;
            await api(`/beds/${bed._id}`, { method: 'DELETE' });
          }
          toast('Bed updated');
          closeModal();
          refreshAll();
        });
      });
    } catch (e) { toast(e.message, true); }
  }

  /* ---------------- patient search (HMS patient registry) ---------------- */
  const GENDER_LABEL = { male: 'Male', female: 'Female', other: 'Other' };
  const patientLine = (p) => [p.patientId, GENDER_LABEL[p.gender] || 'Sex not set', p.age !== null && p.age !== undefined ? `${p.age} yrs` : null, p.contactNumber]
    .filter(Boolean).map(esc).join(' · ');

  /**
   * Search box that finds a patient by ID or name and lets the user pick one.
   * onSelect(patient) is called with the chosen patient, or null when cleared.
   */
  function patientPicker(root, { onSelect, initialId } = {}) {
    root.innerHTML = `
      <div class="picker">
        <label class="search picker-search">${icon('search')}
          <input type="search" placeholder="Type patient ID or name (at least 2 letters)…" autocomplete="off" spellcheck="false" />
        </label>
        <div class="picker-results hidden" role="listbox"></div>
        <div class="picked hidden"></div>
      </div>`;
    const input = $('input', root);
    const results = $('.picker-results', root);
    const picked = $('.picked', root);
    let list = [];
    let timer;
    let seq = 0;

    const select = (p) => {
      picked.innerHTML = `
        <span class="avatar">${esc(initials(p.name))}</span>
        <div class="picked-info"><b>${esc(p.name)}</b><div class="sub">${patientLine(p)}</div></div>
        <button type="button" class="btn sm" data-change>Change</button>`;
      picked.classList.remove('hidden');
      $('.picker-search', root).classList.add('hidden');
      results.classList.add('hidden');
      $('[data-change]', picked).addEventListener('click', () => {
        picked.classList.add('hidden');
        $('.picker-search', root).classList.remove('hidden');
        input.value = ''; input.focus();
        onSelect?.(null);
      });
      onSelect?.(p);
    };

    const render = (q) => {
      results.classList.remove('hidden');
      if (!list.length) {
        results.innerHTML = `<div class="picker-empty">No patient found for “${esc(q)}”.<br><span class="sub">Not registered yet? Register the patient in Patient Registration first.</span></div>`;
        return;
      }
      results.innerHTML = list.map((p, i) => {
        const blocked = p.activeAdmission ? `Already admitted · ${esc(p.activeAdmission.bedNumber || '')}${p.activeAdmission.wardName ? ` (${esc(p.activeAdmission.wardName)})` : ''}` : '';
        return `<button type="button" class="picker-item" data-i="${i}" ${blocked ? 'disabled' : ''} role="option">
          <span class="avatar">${esc(initials(p.name))}</span>
          <span class="picker-text"><b>${esc(p.name)}</b><span class="sub">${patientLine(p)}</span></span>
          ${blocked ? `<span class="tag occupied">${blocked}</span>` : ''}
        </button>`;
      }).join('');
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { results.classList.add('hidden'); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        results.classList.remove('hidden');
        results.innerHTML = '<div class="picker-empty">Searching…</div>';
        try {
          const { data } = await api(`/patients/search?q=${encodeURIComponent(q)}&limit=8`);
          if (mine !== seq) return; // a newer search is running
          list = data; render(q);
        } catch (e) { results.innerHTML = `<div class="picker-empty text-danger">${esc(e.message)}</div>`; }
      }, 250);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // don't submit the form
      const first = list.find((p) => !p.activeAdmission);
      if (first && !results.classList.contains('hidden')) select(first);
    });
    results.addEventListener('click', (e) => {
      const item = e.target.closest('[data-i]');
      if (item && !item.disabled) select(list[Number(item.dataset.i)]);
    });

    if (initialId) {
      api(`/patients/${encodeURIComponent(initialId)}`).then(({ data }) => select(data)).catch(() => { input.value = initialId; });
    } else {
      setTimeout(() => input.focus(), 50);
    }
  }

  /* ---------------- admit ---------------- */
  function openAdmit({ bed } = {}) {
    const types = state.meta.admissionTypes.map((t) => `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('');
    const wardOpts = state.wards.map((w) => `<option value="${w._id}">${esc(w.name)}${w.genderPolicy !== 'mixed' ? ` (${esc(w.genderPolicy)} only)` : ''}</option>`).join('');
    const rsv = bed?.status === 'reserved' ? bed.reservation : null;
    let patient = null;
    let chosenBed = bed ? bed._id : ''; // '' = auto-pick

    const body = openModal(bed ? `Admit to bed ${bed.bedNumber}` : 'Admit patient', `
      <form id="form-admit">
        <div class="step"><span class="step-no">1</span><b>Find the patient</b></div>
        <div id="admit-patient"></div>

        <div class="step"><span class="step-no">2</span><b>${bed ? 'Bed' : 'Choose a room and bed'}</b></div>
        ${bed ? `
          <div class="bed-fixed">${catBadge(bed.category)} <b>${esc(bed.bedNumber)}</b> · ${esc(bed.ward?.name)} · Room ${esc(bed.roomNumber)} · ${money(bed.dailyRate)}/day</div>` : `
          <div class="row">
            <label>Ward<select name="wardId"><option value="">Any ward</option>${wardOpts}</select></label>
            <div class="field"><span class="field-label">Room class</span>
              <span class="seg" id="admit-class" role="group" aria-label="Room class">
                <button type="button" data-cat="private">Private</button>
                <button type="button" data-cat="semi-private">Semi-Private</button>
                <button type="button" data-cat="ward" class="on">Ward</button>
              </span>
            </div>
          </div>
          <div id="bed-choices" class="bed-choices"><p class="sub">Select a patient first to see the beds they can use.</p></div>`}

        <div class="step"><span class="step-no">3</span><b>Admission details</b></div>
        <div class="row">
          <label>Admission type<select name="admissionType">${types}</select></label>
          <label>Attending doctor<input name="doctorName" placeholder="Dr. ..." /></label>
        </div>
        <div class="row">
          <label>Admitting diagnosis<input name="diagnosis" /></label>
          <label>Department<input name="department" placeholder="e.g. Internal Medicine" /></label>
        </div>
        <div class="row one"><label>Notes<textarea name="notes" rows="2"></textarea></label></div>
        <div class="btn-row"><button class="btn primary" type="submit" id="admit-submit" disabled>Admit patient</button><button class="btn" type="button" data-close>Cancel</button></div>
      </form>`);

    const form = $('#form-admit', body);
    const submitBtn = $('#admit-submit', body);
    let category = 'ward';

    async function loadBedChoices() {
      const box = $('#bed-choices', body);
      if (!box) return;
      chosenBed = '';
      if (!patient) { box.innerHTML = '<p class="sub">Select a patient first to see the beds they can use.</p>'; return; }
      box.innerHTML = '<p class="sub">Loading free beds…</p>';
      const q = new URLSearchParams({ gender: patient.gender || 'other', category, patientId: patient.patientId });
      if (form.wardId.value) q.set('wardId', form.wardId.value);
      try {
        const { data: beds } = await api(`/beds/available?${q}`);
        if (!beds.length) {
          box.innerHTML = `<p class="picker-empty">No free ${esc(CATEGORY_LABEL[category])} beds for this patient${form.wardId.value ? ' in this ward' : ''}. Try another ward or room class.</p>`;
          return;
        }
        const byWard = new Map();
        for (const b of beds) {
          if (!byWard.has(b.ward._id)) byWard.set(b.ward._id, { ward: b.ward, beds: [] });
          byWard.get(b.ward._id).beds.push(b);
        }
        box.innerHTML = `
          <button type="button" class="bed-choice auto on" data-bed="">
            <b>Auto-pick</b><span>first suitable bed</span>
          </button>
          ${[...byWard.values()].map(({ ward, beds: list }) => `
            <div class="choice-ward">${esc(ward.name)} <span class="sub">${list.length} free</span></div>
            ${list.map((b) => `
              <button type="button" class="bed-choice ${b.status === 'reserved' ? 'reserved' : ''}" data-bed="${b._id}" title="${esc(b.bedNumber)}">
                <b>Room ${esc(b.roomNumber)} · ${esc(b.bedNumber.split('-').pop())}</b>
                <span>${money(b.dailyRate)}/day${b.status === 'reserved' ? ' · reserved for this patient' : ''}</span>
              </button>`).join('')}`).join('')}`;
      } catch (e) { box.innerHTML = `<p class="picker-empty text-danger">${esc(e.message)}</p>`; }
    }

    patientPicker($('#admit-patient', body), {
      initialId: rsv?.patientId,
      onSelect: (p) => {
        patient = p;
        submitBtn.disabled = !p;
        loadBedChoices();
      },
    });

    if (!bed) {
      $('#admit-class', body).addEventListener('click', (e) => {
        const b = e.target.closest('[data-cat]'); if (!b) return;
        category = b.dataset.cat;
        $$('#admit-class button', body).forEach((x) => x.classList.toggle('on', x === b));
        loadBedChoices();
      });
      form.wardId.addEventListener('change', loadBedChoices);
      $('#bed-choices', body).addEventListener('click', (e) => {
        const c = e.target.closest('[data-bed]'); if (!c) return;
        chosenBed = c.dataset.bed;
        $$('#bed-choices .bed-choice', body).forEach((x) => x.classList.toggle('on', x === c));
      });
    }

    $('[data-close]', body).addEventListener('click', closeModal);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!patient) return toast('Search and select a patient first', true);
      const f = formData(form);
      const payload = {
        patient: { patientId: patient.patientId }, // details are taken from the registry by the server
        admissionType: f.admissionType,
        admittingDoctor: f.doctorName ? { name: f.doctorName } : undefined,
        department: f.department || undefined,
        diagnosis: f.diagnosis || undefined,
        notes: f.notes || undefined,
      };
      if (chosenBed) payload.bedId = chosenBed;
      else { payload.category = category; if (f.wardId) payload.wardId = f.wardId; }
      run(e.submitter, async () => {
        const { data } = await api('/admissions', { method: 'POST', body: payload });
        toast(`${data.admissionNumber}: ${data.patient.name} admitted to ${data.currentBed?.bedNumber}`);
        closeModal();
        refreshAll(); loadAdmissions();
      });
    });
  }
  $('#btn-admit').addEventListener('click', () => openAdmit());
  $('#btn-admit-2').addEventListener('click', () => openAdmit());

  /* ---------------- reserve ---------------- */
  function openReserve(bed) {
    const until = new Date(Date.now() + 24 * 3600 * 1000);
    const local = new Date(until.getTime() - until.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    let patient = null;
    const body = openModal(`Reserve bed ${bed.bedNumber}`, `
      <form>
        <div class="step"><span class="step-no">1</span><b>Find the patient</b></div>
        <div id="reserve-patient"></div>
        <div class="step"><span class="step-no">2</span><b>Reservation</b></div>
        <div class="row">
          <label>Reserved until<input name="reservedUntil" type="datetime-local" value="${local}" required /></label>
          <label>Reason<input name="reason" placeholder="e.g. Elective surgery 8 AM" /></label>
        </div>
        <div class="btn-row"><button class="btn primary" type="submit" id="reserve-submit" disabled>Reserve bed</button></div>
      </form>`);
    patientPicker($('#reserve-patient', body), {
      onSelect: (p) => { patient = p; $('#reserve-submit', body).disabled = !p; },
    });
    $('form', body).addEventListener('submit', (e) => {
      e.preventDefault();
      if (!patient) return toast('Search and select a patient first', true);
      const f = formData(e.target);
      run(e.submitter, async () => {
        await api(`/beds/${bed._id}/reserve`, { method: 'POST', body: { patientId: patient.patientId, reason: f.reason, reservedUntil: new Date(f.reservedUntil).toISOString() } });
        toast(`Bed reserved for ${patient.name}`); closeModal(); refreshAll();
      });
    });
  }

  /* ---------------- transfer ---------------- */
  async function openTransfer(adm, currentWardId) {
    try {
      const { data: beds } = await api(`/beds/available?gender=${encodeURIComponent(adm.patient.gender)}`);
      const wardOpts = state.wards.map((w) => `<option value="${w._id}" ${w._id === currentWardId ? 'selected' : ''}>${esc(w.name)}${w._id === currentWardId ? ' (current)' : ''}</option>`).join('');

      const body = openModal(`Transfer ${adm.patient.name}`, `
        <form>
          <p class="muted">${esc(adm.admissionNumber)} · currently in ${esc(adm.currentBed?.bedNumber || 'bed')}</p>
          <div class="row">
            <label>To ward<select name="wardId">${wardOpts}</select></label>
            <label>Move to
              <select name="target" required></select>
            </label>
          </div>
          <div class="row one"><label>Reason<input name="reason" required placeholder="e.g. Requested upgrade / ICU step-down / infection control" /></label></div>
          <div class="btn-row"><button class="btn primary" type="submit">Transfer</button></div>
        </form>`);
      // Bed list follows the chosen ward
      const wardSel = body.querySelector('[name=wardId]');
      const targetSel = body.querySelector('[name=target]');
      const fillTargets = () => {
        const inWard = beds.filter((b) => b.ward?._id === wardSel.value);
        const groups = ['private', 'semi-private', 'ward'].map((cat) => {
          const list = inWard.filter((b) => b.category === cat);
          if (!list.length) return '';
          return `<optgroup label="${CATEGORY_LABEL[cat]} beds">${list.map((b) => `<option value="bed:${b._id}">${esc(b.bedNumber)} · room ${esc(b.roomNumber)} · ${money(b.dailyRate)}/day</option>`).join('')}</optgroup>`;
        }).join('');
        targetSel.innerHTML = `
          <optgroup label="Auto-assign first free bed">
            <option value="cat:private">Any Private bed</option>
            <option value="cat:semi-private">Any Semi-Private bed</option>
            <option value="cat:ward">Any Ward bed</option>
          </optgroup>${groups}`;
      };
      wardSel.addEventListener('change', fillTargets);
      fillTargets();

      body.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const f = formData(e.target);
        const [kind, val] = f.target.split(':');
        const payload = { reason: f.reason, ...(kind === 'bed' ? { bedId: val } : { category: val, wardId: f.wardId }) };
        run(e.submitter, async () => {
          const { data } = await api(`/admissions/${adm._id}/transfer`, { method: 'POST', body: payload });
          toast(`Transferred to ${data.currentBed?.bedNumber}`); closeModal(); refreshAll(); loadAdmissions();
        });
      });
    } catch (e) { toast(e.message, true); }
  }

  /* ---------------- discharge ---------------- */
  function openDischarge(adm) {
    const types = state.meta.dischargeTypes.map((t) => `<option value="${t}">${t}</option>`).join('');
    const body = openModal(`Discharge ${adm.patient.name}`, `
      <form>
        <p class="muted">${esc(adm.admissionNumber)} · admitted ${fmtDate(adm.admittedAt)}</p>
        <div class="row">
          <label>Discharge type<select name="dischargeType">${types}</select></label>
          <label>Discharged by<input name="dischargedBy" value="${esc(state.user?.name || '')}" /></label>
        </div>
        <div class="row one"><label>Summary / instructions<textarea name="summary"></textarea></label></div>
        <p class="muted">The bed will be sent to housekeeping (status: cleaning).</p>
        <div class="btn-row"><button class="btn danger" type="submit">Confirm discharge</button></div>
      </form>`);
    body.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const { data } = await api(`/admissions/${adm._id}/discharge`, { method: 'POST', body: formData(e.target) });
        refreshAll(); loadAdmissions();
        showCharges(data.charges, 'Discharged · final room charges');
      });
    });
  }

  /* ---------------- charges ---------------- */
  async function openCharges(admissionId) {
    try { showCharges((await api(`/admissions/${admissionId}/charges`)).data); } catch (e) { toast(e.message, true); }
  }
  function showCharges(c, title) {
    openModal(title || `Room charges · ${c.admissionNumber}`, `
      <p><b>${esc(c.patient.name)}</b> (${esc(c.patient.patientId)}) · ${esc(c.admissionNumber)} · ${c.isFinal ? 'FINAL' : 'running total'} · LOS ${c.lengthOfStayDays} days</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Bed</th><th>Category</th><th>From</th><th>To</th><th class="num">Days</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${c.lines.map((l) => `<tr><td>${esc(l.bedNumber)}<div class="muted">${esc(l.wardName)}</div></td><td>${catBadge(l.category)}</td><td>${fmtDate(l.from)}</td><td>${l.to ? fmtDate(l.to) : 'now'}</td><td class="num">${l.days}</td><td class="num">${money(l.dailyRate)}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}
          <tr class="total-row"><td colspan="4">Total</td><td class="num">${c.totalDays}</td><td></td><td class="num">${money(c.total)}</td></tr>
        </tbody>
      </table></div>
      <p class="muted">Room charges only. Final billing is handled by the HMS billing module.</p>`);
  }

  /* ---------------- admissions tab ---------------- */
  let searchTimer;
  async function loadAdmissions() {
    const status = $('#a-status').value;
    const q = new URLSearchParams({ page: state.admPage, limit: 15 });
    if (status) q.set('status', status);
    if ($('#a-search').value.trim()) q.set('search', $('#a-search').value.trim());
    try {
      const res = await api(`/admissions?${q}`);
      state.admissions = res.data;
      $('#adm-body').innerHTML = res.data.map((a) => {
        const lastStay = a.bedHistory[a.bedHistory.length - 1];
        const bedNo = a.currentBed?.bedNumber || lastStay?.bedNumber;
        const wardName = a.currentWard?.name || lastStay?.wardName;
        return `<tr>
          <td><div class="person"><span class="avatar">${esc(initials(a.patient.name))}</span><div><b>${esc(a.patient.name)}</b><div class="sub">${esc(a.patient.patientId)} · ${esc(a.patient.gender)}</div></div></div></td>
          <td class="nowrap"><b>${esc(a.admissionNumber)}</b><div class="sub">${esc(a.admissionType)} · <span class="badge ${a.status === 'admitted' ? 's-occupied' : 's-maintenance'}">${esc(a.status)}</span></div></td>
          <td class="nowrap"><b>${esc(bedNo || '—')}</b><div class="sub">${esc(wardName || '')}</div></td>
          <td>${lastStay ? catBadge(lastStay.category) : ''}</td>
          <td class="nowrap">${shortDate(a.admittedAt)}${a.dischargedAt ? `<div class="sub">out ${shortDate(a.dischargedAt)}</div>` : ''}</td>
          <td class="num nowrap">${days(a.admittedAt, a.dischargedAt).toFixed(1)} d</td>
          <td class="nowrap">${esc(a.admittingDoctor?.name || '—')}</td>
          <td><div class="actions nowrap">
            ${a.status === 'admitted' ? `<button class="btn sm" data-a="transfer" data-id="${a._id}">Transfer</button><button class="btn sm danger" data-a="discharge" data-id="${a._id}">Discharge</button>` : ''}
            <button class="btn sm" data-a="charges" data-id="${a._id}">Charges</button>
          </div></td>
        </tr>`;
      }).join('') || '<tr><td colspan="8" class="empty">No admissions found</td></tr>';
      $('#adm-pager').innerHTML = res.pages > 1 ? `
        <button class="btn sm" data-page="${res.page - 1}" ${res.page <= 1 ? 'disabled' : ''}>Prev</button>
        <span class="muted">Page ${res.page} of ${res.pages} · ${res.total} total</span>
        <button class="btn sm" data-page="${res.page + 1}" ${res.page >= res.pages ? 'disabled' : ''}>Next</button>` : `<span class="muted">${res.total} total</span>`;
    } catch (e) { toast(e.message, true); }
  }
  $('#adm-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-a]');
    if (!btn) return;
    const adm = state.admissions.find((a) => a._id === btn.dataset.id);
    if (btn.dataset.a === 'transfer') openTransfer(adm, adm.currentWard?._id);
    if (btn.dataset.a === 'discharge') openDischarge(adm);
    if (btn.dataset.a === 'charges') openCharges(adm._id);
  });
  $('#adm-pager').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (btn && !btn.disabled) { state.admPage = Number(btn.dataset.page); loadAdmissions(); }
  });
  $('#a-status-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    $$('#a-status-seg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#a-status').value = b.dataset.v;
    state.admPage = 1; loadAdmissions();
  });
  $('#a-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.admPage = 1; loadAdmissions(); }, 300); });

  /* ---------------- setup tab ---------------- */
  function renderWardTable() {
    $('#ward-body').innerHTML = state.wards.map((w) => `<tr>
      <td><div class="person"><span class="ward-code">${esc(w.code)}</span><b>${esc(w.name)}</b></div></td>
      <td>${esc(typeLabel(w.type))}</td><td>${esc(w.floor || '—')}</td>
      <td class="cap">${esc(w.genderPolicy)}</td><td class="num">${w.beds.total || 0}</td><td class="num">${w.beds.occupied || 0}</td>
      <td><div class="actions"><button class="btn sm ghost admin-only" data-del-ward="${w._id}">Deactivate</button></div></td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No wards yet</td></tr>';
  }
  $('#ward-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del-ward]');
    if (!btn || !confirm('Deactivate this ward and all its beds?')) return;
    run(btn, async () => { await api(`/wards/${btn.dataset.delWard}`, { method: 'DELETE' }); toast('Ward deactivated'); refreshAll(); });
  });

  $('#form-ward').addEventListener('submit', (e) => {
    e.preventDefault();
    run(e.submitter, async () => {
      await api('/wards', { method: 'POST', body: formData(e.target) });
      e.target.reset(); toast('Ward created'); await loadWards();
    });
  });

  /* ---------------- rooms tab ---------------- */
  const roomPath = (r) => `/rooms/${r.wardId}/${encodeURIComponent(r.roomNumber)}`;
  const priceText = (r) => (r.dailyRate !== null ? money(r.dailyRate) : `${money(r.minRate)} – ${money(r.maxRate)}`);

  async function loadRooms() {
    const q = new URLSearchParams();
    if ($('#r-ward').value) q.set('wardId', $('#r-ward').value);
    if ($('#r-category').value) q.set('category', $('#r-category').value);
    try {
      state.rooms = (await api(`/rooms?${q}`)).data;
      renderRooms();
    } catch (e) { toast(e.message, true); }
  }

  function renderRooms() {
    if (!state.rooms.length) {
      $('#rooms-list').innerHTML = '<div class="card empty">No rooms found. Click <b>+ Add room</b> to create one.</div>';
      return;
    }
    const byWard = new Map();
    for (const r of state.rooms) {
      if (!byWard.has(r.wardId)) byWard.set(r.wardId, []);
      byWard.get(r.wardId).push(r);
    }
    $('#rooms-list').innerHTML = [...byWard.values()].map((list) => {
      const w = list[0];
      return `<section class="card flush">
        <div class="ward-title">
          <h3>${esc(w.wardName)} <span class="muted">(${esc(w.wardCode)})</span></h3>
          <span class="muted">${list.length} room(s) · ${list.reduce((s, r) => s + r.bedCount, 0)} bed(s)</span>
          <button class="btn sm admin-only" data-room-act="add-in-ward" data-ward="${w.wardId}">+ Add room here</button>
        </div>
        <div class="table-wrap"><table class="table rooms-table">
          <thead><tr><th>Room</th><th>Class</th><th>Beds</th><th>Status</th><th class="num">Price / day</th><th>Equipment</th><th></th></tr></thead>
          <tbody>${list.map((r, i) => `<tr>
            <td><b>${esc(r.roomNumber)}</b></td>
            <td>${catBadge(r.category)}</td>
            <td>${r.bedCount} / ${r.capacity}<div class="muted">${r.beds.map((b) => esc(b.bedNumber.split('-').pop())).join(', ')}</div></td>
            <td>${r.occupied ? `<span class="tag occupied">${r.occupied} occupied</span>` : ''}${r.reserved ? `<span class="tag reserved">${r.reserved} reserved</span>` : ''}${r.available ? `<span class="tag available">${r.available} free</span>` : ''}</td>
            <td class="num"><b>${priceText(r)}</b>${r.customPrice ? `<div><span class="tag custom" title="Rate card price is ${money(r.cardRate)}">custom price</span></div>` : '<div class="muted">rate card</div>'}</td>
            <td>${r.features.length ? `<div class="chips">${r.features.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : '<span class="muted">—</span>'}</td>
            <td><div class="actions">
              <button class="btn sm admin-only" data-room-act="edit" data-i="${state.rooms.indexOf(r)}">Edit</button>
              ${r.bedCount < r.capacity ? `<button class="btn sm admin-only" data-room-act="add-bed" data-i="${state.rooms.indexOf(r)}">+ Bed</button>` : ''}
              <button class="btn sm ghost admin-only" data-room-act="remove" data-i="${state.rooms.indexOf(r)}" ${r.occupied || r.reserved ? 'disabled title="Room has patients or reservations"' : ''}>Remove</button>
            </div></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>`;
    }).join('');
  }

  $('#rooms-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-room-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.roomAct;
    if (act === 'add-in-ward') return openAddRoom(btn.dataset.ward);
    const room = state.rooms[Number(btn.dataset.i)];
    if (act === 'edit') return openEditRoom(room);
    if (act === 'add-bed') return openAddBed(room);
    if (act === 'remove') {
      if (!confirm(`Remove room ${room.roomNumber} (${room.bedCount} bed(s)) from ${room.wardName}? History is kept.`)) return;
      run(btn, async () => { await api(roomPath(room), { method: 'DELETE' }); toast(`Room ${room.roomNumber} removed`); afterRoomChange(); });
    }
  });
  ['#r-ward', '#r-category'].forEach((s) => $(s).addEventListener('change', loadRooms));
  $('#btn-add-room').addEventListener('click', () => openAddRoom($('#r-ward').value));

  function afterRoomChange() { loadRooms(); refreshAll(); if (state.rateCard) loadRates(); }

  // Effective rate-card price for a ward + class (ward rate -> hospital default)
  function cardRate(wardId, category) {
    const w = state.rateCard?.wards.find((x) => x.wardId === wardId);
    return w ? w.rates[category].dailyRate : state.rateCard?.defaults[category]?.dailyRate;
  }

  async function openAddRoom(wardId) {
    if (!state.rateCard) await loadRates();
    const wardOpts = state.wards.map((w) => `<option value="${w._id}" ${w._id === wardId ? 'selected' : ''}>${esc(w.name)} (${esc(w.code)})</option>`).join('');
    const body = openModal('Add room', `
      <form>
        <div class="row">
          <label>Ward<select name="wardId" required>${wardOpts}</select></label>
          <label>Room number<input name="roomNumber" required maxlength="10" placeholder="e.g. 207" /></label>
        </div>
        <div class="row">
          <label>Room class
            <select name="category">
              <option value="private">Private (1 bed)</option>
              <option value="semi-private">Semi-Private (2 beds)</option>
              <option value="ward">Ward / open bay (up to 12 beds)</option>
            </select>
          </label>
          <label>Number of beds<input name="beds" type="number" min="1" value="1" required /></label>
        </div>
        <div class="row">
          <label>Price per day
            <select name="priceMode">
              <option value="card">Use rate card</option>
              <option value="custom">Set a custom price</option>
            </select>
          </label>
          <label>Amount<input name="dailyRate" type="number" min="0" step="0.01" /></label>
        </div>
        <div class="row one"><label>Features / equipment (comma separated)<input name="features" placeholder="oxygen, aircon, tv, private-toilet" /></label></div>
        <p class="muted" id="room-hint"></p>
        <div class="btn-row"><button class="btn primary" type="submit">Create room</button></div>
      </form>`);

    const f = body.querySelector('form');
    const sync = () => {
      const max = state.meta.bedCategories[f.category.value].maxBedsPerRoom;
      f.beds.max = max;
      if (Number(f.beds.value) > max) f.beds.value = max;
      if (f.category.value === 'private') f.beds.value = 1;
      if (f.category.value === 'semi-private' && f.beds.value < 2) f.beds.value = 2;
      const rate = cardRate(f.wardId.value, f.category.value);
      const custom = f.priceMode.value === 'custom';
      f.dailyRate.disabled = !custom;
      if (!custom) f.dailyRate.value = rate ?? '';
      $('#room-hint').textContent = `Max ${max} bed(s) for this class. Rate card price here: ${money(rate)} / day.`;
    };
    ['wardId', 'category', 'priceMode'].forEach((n) => f[n].addEventListener('change', sync));
    sync();

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = formData(f);
      const payload = { wardId: d.wardId, roomNumber: d.roomNumber, category: d.category, beds: Number(d.beds), features: d.features };
      if (d.priceMode === 'custom') payload.dailyRate = d.dailyRate;
      run(e.submitter, async () => {
        const { data } = await api('/rooms', { method: 'POST', body: payload });
        toast(`Room ${data.roomNumber} created with ${data.bedCount} bed(s) at ${priceText(data)}/day`);
        closeModal(); afterRoomChange();
      });
    });
  }

  function openEditRoom(room) {
    const locked = room.occupied > 0 || room.reserved > 0;
    const classOpts = ['private', 'semi-private', 'ward'].map((c) => `<option value="${c}" ${c === room.category ? 'selected' : ''}>${CATEGORY_LABEL[c]}</option>`).join('');
    const body = openModal(`Edit room ${room.roomNumber} · ${room.wardName}`, `
      <form>
        <div class="row">
          <label>Room class<select name="category" ${locked ? 'disabled' : ''}>${classOpts}</select></label>
          <label>Price per day<input name="dailyRate" type="number" min="0" step="0.01" value="${room.dailyRate ?? room.minRate}" required /></label>
        </div>
        ${locked ? '<p class="muted">Class can\'t be changed while a bed in this room is occupied or reserved.</p>' : ''}
        <p class="muted">Rate card price for this ward and class: <b>${money(room.cardRate)}</b>.
          ${room.customPrice ? '<button type="button" class="btn sm" data-reset>Use rate card price</button>' : 'This room uses the rate card.'}</p>
        <div class="row one"><label>Features / equipment<input name="features" value="${esc(room.features.join(', '))}" /></label></div>
        <div class="row one"><label>Reason for change (saved in price history)<input name="note" placeholder="e.g. Renovated, new aircon" /></label></div>
        <p class="muted">Patients already in this room keep the price they were admitted at. The new price applies to new admissions and transfers.</p>
        <div class="btn-row"><button class="btn primary" type="submit">Save changes</button></div>
      </form>`);
    const f = body.querySelector('form');
    body.querySelector('[data-reset]')?.addEventListener('click', () => { f.dailyRate.value = room.cardRate; });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = formData(f);
      const payload = { dailyRate: d.dailyRate, features: d.features, note: d.note || undefined };
      if (!locked && d.category !== room.category) payload.category = d.category;
      run(e.submitter, async () => {
        await api(roomPath(room), { method: 'PATCH', body: payload });
        toast(`Room ${room.roomNumber} updated`); closeModal(); afterRoomChange();
      });
    });
  }

  function openAddBed(room) {
    const free = room.capacity - room.bedCount;
    const body = openModal(`Add bed to room ${room.roomNumber}`, `
      <form>
        <p class="muted">${esc(room.wardName)} · ${catBadge(room.category)} · ${room.bedCount} of ${room.capacity} beds used. New beds get the room's price (${priceText(room)}/day) and features.</p>
        <div class="row"><label>How many beds<input name="count" type="number" min="1" max="${free}" value="1" required /></label></div>
        <div class="btn-row"><button class="btn primary" type="submit">Add</button></div>
      </form>`);
    body.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const { data } = await api(`${roomPath(room)}/beds`, { method: 'POST', body: formData(e.target) });
        toast(`Room ${data.roomNumber} now has ${data.bedCount} bed(s)`); closeModal(); afterRoomChange();
      });
    });
  }

  /* ---------------- room rates tab ---------------- */
  async function loadRates() {
    try {
      const [card, history] = await Promise.all([api('/rates'), api('/rates/history?limit=30')]);
      state.rateCard = card.data;
      renderRates(history.data);
    } catch (e) { toast(e.message, true); }
  }

  function renderRates(history) {
    const cats = ['private', 'semi-private', 'ward'];
    const d = state.rateCard.defaults;
    const cell = (attrs, amount, sub, cls = '') => `<button type="button" class="rate-cell ${cls}" ${attrs}><span class="amt">${money(amount)}</span><span class="sub">${sub}</span></button>`;
    $('#rate-table').innerHTML = `
      <thead><tr><th>Ward</th>${cats.map((c) => `<th class="num">${CATEGORY_LABEL[c]}</th>`).join('')}</tr></thead>
      <tbody>
        <tr class="default-row"><td><b>Hospital default</b><div class="muted">applies to every ward without its own rate</div></td>
          ${cats.map((c) => `<td class="num">${cell(`data-rate-scope="default" data-cat="${c}"`, d[c].dailyRate, 'default', 'is-default')}</td>`).join('')}</tr>
        ${state.rateCard.wards.map((w) => `<tr><td><b>${esc(w.name)}</b> <span class="muted">${esc(w.code)}</span></td>
          ${cats.map((c) => {
            const r = w.rates[c];
            if (!r.beds && r.source === 'default') return `<td class="num">${cell(`data-rate-scope="ward" data-ward="${w.wardId}" data-cat="${c}"`, r.dailyRate, 'no rooms', 'is-empty')}</td>`;
            const sub = `${r.source === 'ward' ? '<b>ward rate</b>' : 'default'} · ${r.beds} bed(s)${r.customBeds ? ` · ${r.customBeds} custom` : ''}`;
            return `<td class="num">${cell(`data-rate-scope="ward" data-ward="${w.wardId}" data-cat="${c}"`, r.dailyRate, sub, r.source === 'ward' ? 'is-override' : '')}</td>`;
          }).join('')}</tr>`).join('')}
      </tbody>`;

    const scopeLabel = { 'default-rate': 'Hospital default', 'ward-rate': 'Ward rate', 'ward-rate-removed': 'Ward rate removed', room: 'Room' };
    $('#price-history').innerHTML = history.map((h) => `<tr>
      <td>${fmtDate(h.createdAt)}</td>
      <td>${esc(scopeLabel[h.scope])}<div class="muted">${esc(h.wardName || '')}${h.roomNumber ? ` · room ${esc(h.roomNumber)}` : ''}</div></td>
      <td>${h.category ? catBadge(h.category) : ''}</td>
      <td class="num">${money(h.oldRate)}</td><td class="num"><b>${money(h.newRate)}</b></td>
      <td class="num">${h.bedsUpdated}</td><td>${esc(h.actor?.name || '')}</td><td class="muted">${esc(h.note || '')}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No price changes yet</td></tr>';
  }

  $('#rate-table').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rate-scope]');
    if (!btn) return;
    if (!isAdmin()) return toast('Only an administrator can change room rates', true);
    const cat = btn.dataset.cat;
    if (btn.dataset.rateScope === 'default') {
      return openEditRate({ wardId: '', label: 'Hospital default', cat, current: state.rateCard.defaults[cat].dailyRate });
    }
    const w = state.rateCard.wards.find((x) => x.wardId === btn.dataset.ward);
    const r = w.rates[cat];
    openEditRate({ wardId: w.wardId, label: w.name, cat, current: r.dailyRate, source: r.source, overrideId: r.overrideId, beds: r.beds });
  });

  function openEditRate({ wardId, label, cat, current, source, overrideId, beds }) {
    const isDefault = !wardId;
    const scopeText = isDefault
      ? `all ${CATEGORY_LABEL[cat]} beds in wards that don't have their own rate`
      : `the ${beds} ${CATEGORY_LABEL[cat]} bed(s) in ${label}`;
    const body = openModal(`${CATEGORY_LABEL[cat]} rate · ${label}`, `
      <form>
        <p class="muted">${isDefault ? 'This is the hospital-wide price for this room class.' : source === 'ward'
          ? 'This ward has its own price for this room class.'
          : `This ward currently uses the hospital default (${money(current)}). Saving creates a ward-specific price.`}</p>
        <div class="row">
          <label>New price per day<input name="dailyRate" type="number" min="0" step="0.01" value="${current}" required /></label>
          <label>Reason (saved in history)<input name="note" placeholder="e.g. 2027 price adjustment" /></label>
        </div>
        <label class="check"><input type="checkbox" name="applyToExisting" checked /> Also update ${scopeText} (including rooms with a custom price)</label>
        <p class="muted">If unticked, only rooms created from now on get the new price. Patients already admitted keep their admission price either way.</p>
        <div class="btn-row">
          <button class="btn primary" type="submit">Save price</button>
          ${source === 'ward' ? '<button class="btn ghost" type="button" data-remove>Remove ward rate (use hospital default)</button>' : ''}
        </div>
      </form>`);
    const f = body.querySelector('form');
    const done = (res) => {
      toast(`Price saved${res.bedsUpdated ? ` · ${res.bedsUpdated} bed(s) updated` : ''}`);
      closeModal(); loadRates(); refreshAll(); if (state.rooms) loadRooms();
    };
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = formData(f);
      run(e.submitter, async () => done(await api('/rates', {
        method: 'PUT', body: { wardId, category: cat, dailyRate: d.dailyRate, note: d.note || undefined, applyToExisting: !!d.applyToExisting },
      })));
    });
    body.querySelector('[data-remove]')?.addEventListener('click', (e) => {
      const apply = f.applyToExisting.checked;
      run(e.target, async () => done(await api(`/rates/${overrideId}?applyToExisting=${apply}`, { method: 'DELETE' })));
    });
  }

  /* ---------------- tabs ---------------- */
  const TABS = ['board', 'admissions', 'rooms', 'rates', 'setup', 'users'];
  function showTab(tab) {
    if (!TABS.includes(tab) || (tab === 'users' && state.user && !isAdmin())) tab = 'board';
    $$('.nav-item').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    $$('main .panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
    if (tab === 'admissions') loadAdmissions();
    if (tab === 'rooms') { loadRooms(); if (!state.rateCard) loadRates(); }
    if (tab === 'rates') loadRates();
    if (tab === 'users' && isAdmin()) loadUsers();
    store.set('ipd_tab', tab);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  // "/" focuses the search box of the current page
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || modal.open || /input|textarea|select/i.test(document.activeElement?.tagName)) return;
    const panel = $('main .panel:not(.hidden)');
    const input = panel && $('input[type=search]', panel);
    if (input) { e.preventDefault(); input.focus(); }
  });

  /* ---------------- signed-in user ---------------- */
  function isAdmin() { return state.user?.role === 'admin'; }

  function setUser() {
    const u = state.user;
    $('#whoami').textContent = u.name;
    $('#user-avatar').textContent = initials(u.name);
    $('#user-role').textContent = u.role;
    $('#user-role').className = `role-badge ${u.role}`;
    document.body.classList.toggle('is-admin', isAdmin());
  }

  async function logout() {
    try { await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'same-origin' }); } catch { /* ignore */ }
    location.replace('login.html?reason=logout');
  }
  $('#btn-logout').addEventListener('click', logout);

  function openAccount(forced = false) {
    const u = state.user;
    const body = openModal(forced ? 'Set a new password' : 'My account', `
      ${forced ? '<div class="callout"><svg><use href="#i-alert"/></svg><div>You signed in with a <b>temporary password</b>. Please choose your own password to continue.</div></div>' : `
      <div class="patient-box"><span class="avatar">${esc(initials(u.name))}</span>
        <div><b>${esc(u.name)}</b><div class="sub">@${esc(u.username)} · <span class="badge role-${u.role}">${esc(u.role)}</span></div></div>
      </div>`}
      <form>
        <div class="section-title">Change password</div>
        <div class="row one"><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required /></label></div>
        <div class="row">
          <label>New password<input name="newPassword" type="password" autocomplete="new-password" minlength="8" required /></label>
          <label>Repeat new password<input name="repeat" type="password" autocomplete="new-password" minlength="8" required /></label>
        </div>
        <p class="form-note">At least 8 characters, with letters and numbers. Other devices will be signed out.</p>
        <div class="btn-row">
          <button class="btn primary" type="submit">Change password</button>
          ${forced ? '' : `<button class="btn ghost" type="button" data-logout>${icon('logout')}Sign out</button>`}
        </div>
      </form>`);
    body.querySelector('[data-logout]')?.addEventListener('click', logout);
    body.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (f.newPassword !== f.repeat) return toast('The new passwords do not match', true);
      run(e.submitter, async () => {
        const { data } = await api('/auth/change-password', { method: 'POST', body: { currentPassword: f.currentPassword, newPassword: f.newPassword } });
        state.user = data;
        toast('Password changed');
        closeModal();
      });
    });
    // A temporary password must be changed: don't allow closing the dialog
    modal.dataset.locked = forced ? '1' : '';
  }
  $('#btn-settings').addEventListener('click', () => openAccount());
  modal.addEventListener('cancel', (e) => { if (modal.dataset.locked && state.user?.mustChangePassword) e.preventDefault(); });

  /* ---------------- users (admin) ---------------- */
  async function loadUsers() {
    try {
      state.users = (await api('/users')).data;
      $('#user-body').innerHTML = state.users.map((u) => {
        const me = u._id === state.user._id;
        return `<tr>
          <td><div class="person"><span class="avatar">${esc(initials(u.name))}</span><div><b>${esc(u.name)}</b>${me ? ' <span class="sub">(you)</span>' : ''}${u.mustChangePassword ? '<div class="sub">must change password</div>' : ''}</div></div></td>
          <td>@${esc(u.username)}</td>
          <td><span class="badge role-${u.role}">${esc(u.role)}</span></td>
          <td>${u.isActive ? '<span class="tag available">Active</span>' : '<span class="tag occupied">Deactivated</span>'}</td>
          <td class="nowrap">${u.lastLoginAt ? shortDate(u.lastLoginAt) : '<span class="muted">never</span>'}</td>
          <td><div class="actions nowrap">
            <button class="btn sm" data-user-act="edit" data-id="${u._id}">Edit</button>
            <button class="btn sm" data-user-act="reset" data-id="${u._id}">Reset password</button>
            ${me ? '' : `<button class="btn sm ${u.isActive ? 'ghost' : ''}" data-user-act="toggle" data-id="${u._id}">${u.isActive ? 'Deactivate' : 'Activate'}</button>`}
          </div></td>
        </tr>`;
      }).join('') || '<tr><td colspan="6" class="empty">No users</td></tr>';
    } catch (e) { toast(e.message, true); }
  }

  function openUserForm(user) {
    const isNew = !user;
    const body = openModal(isNew ? 'Add user' : `Edit ${user.name}`, `
      <form>
        <div class="row">
          <label>Full name<input name="name" required maxlength="80" value="${esc(user?.name || '')}" placeholder="e.g. Maria Santos, RN" /></label>
          <label>Username<input name="username" ${isNew ? 'required' : 'disabled'} value="${esc(user?.username || '')}" placeholder="e.g. msantos" autocapitalize="none" spellcheck="false" /></label>
        </div>
        <div class="row">
          <label>Role
            <select name="role" ${user && user._id === state.user._id ? 'disabled' : ''}>
              <option value="staff" ${user?.role === 'staff' ? 'selected' : ''}>Staff (nurse / admitting)</option>
              <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>
          </label>
          ${isNew ? '<label>Temporary password<input name="password" type="text" required minlength="8" autocomplete="off" /></label>' : '<span></span>'}
        </div>
        ${isNew ? '<p class="form-note">Give this temporary password to the user. They will be asked to change it when they first sign in.</p>' : ''}
        <div class="btn-row"><button class="btn primary" type="submit">${isNew ? 'Create user' : 'Save'}</button></div>
      </form>`);
    if (isNew) body.querySelector('[name=password]').value = suggestPassword();
    body.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(e.target);
      run(e.submitter, async () => {
        if (isNew) await api('/users', { method: 'POST', body: f });
        else await api(`/users/${user._id}`, { method: 'PATCH', body: { name: f.name, ...(f.role ? { role: f.role } : {}) } });
        toast(isNew ? `User @${f.username} created` : 'User updated');
        closeModal(); loadUsers();
      });
    });
  }

  function suggestPassword() {
    const words = ['Ward', 'Bed', 'Care', 'Nurse', 'Room', 'Heal', 'Med'];
    const a = new Uint32Array(2); crypto.getRandomValues(a);
    return `${words[a[0] % words.length]}-${String(a[1] % 9000 + 1000)}-${words[(a[0] >> 8) % words.length].toLowerCase()}`;
  }

  function openResetPassword(user) {
    const body = openModal(`Reset password · ${user.name}`, `
      <form>
        <p class="muted">${esc(user.name)} will be signed out everywhere and must choose a new password at the next sign-in.</p>
        <div class="row one"><label>New temporary password<input name="password" type="text" required minlength="8" autocomplete="off" /></label></div>
        <div class="btn-row"><button class="btn primary" type="submit">Reset password</button></div>
      </form>`);
    body.querySelector('[name=password]').value = suggestPassword();
    body.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        await api(`/users/${user._id}`, { method: 'PATCH', body: formData(e.target) });
        toast(`Password reset for @${user.username}`); closeModal(); loadUsers();
      });
    });
  }

  $('#btn-add-user').addEventListener('click', () => openUserForm());
  $('#user-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-user-act]');
    if (!btn) return;
    const u = state.users.find((x) => x._id === btn.dataset.id);
    if (btn.dataset.userAct === 'edit') return openUserForm(u);
    if (btn.dataset.userAct === 'reset') return openResetPassword(u);
    if (btn.dataset.userAct === 'toggle') {
      if (u.isActive && !confirm(`Deactivate ${u.name}? They will be signed out and cannot sign in.`)) return;
      run(btn, async () => {
        await api(`/users/${u._id}`, { method: 'PATCH', body: { isActive: !u.isActive } });
        toast(u.isActive ? `${u.name} deactivated` : `${u.name} activated`); loadUsers();
      });
    }
  });

  /* ---------------- boot ---------------- */
  async function init() {
    try {
      state.user = (await api('/auth/me')).data; // redirects to login if not signed in
    } catch { return; }
    setUser();
    document.body.classList.remove('booting');
    showTab(location.hash.slice(1) || store.get('ipd_tab') || 'board');
    if (state.user.mustChangePassword) openAccount(true);
    try {
      await loadMeta();
      await refreshAll();
    } catch (e) { toast(e.message, true); }
  }

  init();
  // Live-ish board: refresh every 30s while no dialog is open
  setInterval(() => { if (!modal.open && document.visibilityState === 'visible') refreshAll(); }, 30000);
})();
