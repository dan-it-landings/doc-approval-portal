// ===== Портал погодження документів — основна логіка (n8n Code node, Run Once for All Items) =====
const crypto = require('crypto');
const req = $('Normalize Request').first().json;
const ranges = $('Read Sheets').first().json.valueRanges || [];
let upload = null;
try { upload = $('Convert To Google Doc').first().json; } catch (e) { upload = null; }

const COLS = {
  settings: ['key','value'],
  users: ['email','name','created_at','last_login'],
  codes: ['email','code','expires_at','attempts'],
  sessions: ['token','email','expires_at','created_at'],
  documents: ['doc_id','title','gdoc_id','gdoc_url','initiator','executor','status','round','lock_by','lock_since','lock_until','queue','pdf_id','pdf_url','created_at','updated_at','done_at'],
  roles: ['role_id','doc_id','email','role','decision','decision_at','comment','ack_token','ack_at'],
  log: ['ts','doc_id','email','action','details'],
  notifications: ['notif_id','ts','email','doc_id','text','read']
};
const STATUS = { review: 'На погодженні', secretary: 'У секретаря', acquaint: 'Ознайомлення', execution: 'На виконанні', done: 'Виконано' };

// ---------- table helpers ----------
const T = {}; const nextRow = {}; const dirty = new Set();
for (const tab of Object.keys(COLS)) {
  const vr = ranges.find(r => (r.range || '').replace(/'/g, '').startsWith(tab + '!'));
  const vals = (vr && vr.values) || [];
  T[tab] = [];
  for (let i = 1; i < vals.length; i++) {
    const row = vals[i] || [];
    if (!row.length || row.every(v => v === '' || v == null)) continue;
    const o = { _tab: tab, _row: i + 1 };
    COLS[tab].forEach((c, j) => { o[c] = row[j] != null ? String(row[j]) : ''; });
    T[tab].push(o);
  }
  nextRow[tab] = Math.max(vals.length + 1, 2);
}
function add(tab, obj) {
  const o = { _tab: tab, _row: nextRow[tab]++ };
  COLS[tab].forEach(c => { o[c] = obj[c] != null ? String(obj[c]) : ''; });
  T[tab].push(o); dirty.add(o); return o;
}
function upd(o, fields) { Object.entries(fields).forEach(([k, v]) => { o[k] = v == null ? '' : String(v); }); dirty.add(o); return o; }
function del(o) { COLS[o._tab].forEach(c => { o[c] = ''; }); o._deleted = true; dirty.add(o); T[o._tab] = T[o._tab].filter(x => x !== o); }

const now = new Date(); const NOW = now.toISOString();
const rnd = (n = 16) => crypto.randomBytes(n).toString('hex');
const norm = e => String(e || '').trim().toLowerCase();
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const setting = k => { const r = T.settings.find(s => s.key === k); return r ? r.value : ''; };
const SECRETARY = norm(setting('secretary_email'));
const PORTAL = setting('portal_url') || 'https://example.github.io/doc-approval-portal/';
const ACK_URL = setting('ack_url') || 'https://danit-n8n.duckdns.org/webhook/doc-portal-ack';
const WORK_FOLDER = setting('work_folder_id');
const LOCK_MIN = parseInt(setting('lock_minutes') || '60', 10) || 60;

const out = { resp: null, emails: [], drive: [], pdfJobs: [], summaryJobs: [], isHttp: req.source === 'api' || req.source === 'ack' };

// ---------- domain helpers ----------
const userBy = e => T.users.find(u => norm(u.email) === norm(e));
const nameOf = e => { const u = userBy(e); return (u && u.name) ? u.name : e; };
const docBy = id => T.documents.find(d => d.doc_id === id);
const rolesOf = (id, role) => T.roles.filter(r => r.doc_id === id && (!role || r.role === role));
const participantsOf = id => rolesOf(id, 'participant').map(r => norm(r.email));
const queueOf = d => (d.queue || '').split(',').map(norm).filter(Boolean);
const docLink = id => PORTAL + '#/doc/' + encodeURIComponent(id);
function ensureUser(email) {
  let u = userBy(email); let created = false;
  if (!u) { u = add('users', { email: norm(email), name: '', created_at: NOW, last_login: '' }); created = true; }
  return { u, created };
}
function log(docId, email, action, details) { add('log', { ts: NOW, doc_id: docId, email: email || 'system', action, details: details || '' }); }
function emailHtml(title, lines, btnText, btnUrl) {
  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">' +
    '<div style="font-size:13px;color:#6b7280;margin-bottom:12px">Портал погодження документів</div>' +
    '<h2 style="font-size:19px;margin:0 0 14px">' + esc(title) + '</h2>' +
    lines.map(l => '<p style="font-size:14px;line-height:1.55;margin:0 0 10px">' + l + '</p>').join('') +
    (btnUrl ? '<p style="margin:22px 0"><a href="' + btnUrl + '" style="background:#2563eb;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:14px;display:inline-block">' + esc(btnText) + '</a></p>' : '') +
    '<p style="font-size:12px;color:#9ca3af;margin-top:28px">Лист надіслано автоматично. Не відповідайте на нього.</p></div>';
}
function notify(emails, doc, text, opt = {}) {
  const list = [...new Set(emails.map(norm).filter(Boolean))].filter(e => !opt.except || e !== norm(opt.except));
  for (const e of list) {
    add('notifications', { notif_id: 'N' + rnd(6), ts: NOW, email: e, doc_id: doc ? doc.doc_id : '', text, read: '' });
    if (opt.email !== false) {
      out.emails.push({
        to: e,
        subject: opt.subject || ((doc ? '«' + doc.title + '»: ' : '') + text).slice(0, 150),
        html: emailHtml(opt.subject || text, [(doc ? '<b>Документ:</b> ' + esc(doc.title) : '')].concat(opt.lines || []).filter(Boolean), 'Відкрити в порталі', doc ? docLink(doc.doc_id) : PORTAL)
      });
    }
  }
}
function drive(fileId, email, role) { if (fileId && email) out.drive.push({ fileId, email: norm(email), role }); }
function resetRound(d) {
  upd(d, { round: (parseInt(d.round || '1', 10) || 1) + 1, status: 'review', updated_at: NOW });
  rolesOf(d.doc_id, 'participant').forEach(r => upd(r, { decision: '', decision_at: '', comment: '' }));
}
function releaseLock(d, actor, comment, auto) {
  const holder = norm(d.lock_by); if (!holder) return;
  out.summaryJobs.push({
    doc_id: d.doc_id, title: d.title, gdoc_id: d.gdoc_id, editor: holder, editor_name: nameOf(holder),
    comment: comment || '', lock_since: d.lock_since, auto: !!auto,
    recipients: participantsOf(d.doc_id).filter(e => e !== holder),
    link: docLink(d.doc_id)
  });
  drive(d.gdoc_id, holder, 'reader');
  upd(d, { lock_by: '', lock_since: '', lock_until: '' });
  log(d.doc_id, actor || holder, auto ? 'lock_expired' : 'edit_finished', comment || '');
  resetRound(d);
  const q = queueOf(d);
  if (q.length) {
    const nxt = q[0]; upd(d, { queue: q.slice(1).join(',') });
    notify([nxt], d, 'Документ звільнено — ваша черга редагувати', { subject: '«' + d.title + '»: ваша черга редагувати', lines: ['Попередній учасник завершив правки. Натисніть «Взяти на редагування» в порталі.'] });
  }
}
function allApproved(d) { const ps = rolesOf(d.doc_id, 'participant'); return ps.length > 0 && ps.every(r => r.decision === 'approved'); }
function canSee(d, e) {
  e = norm(e);
  return e === SECRETARY || norm(d.initiator) === e || norm(d.executor) === e || T.roles.some(r => r.doc_id === d.doc_id && norm(r.email) === e);
}
function lockExpired(d) { return d.lock_by && d.lock_until && new Date(d.lock_until) < now; }
function docSummary(d, e) {
  const my = T.roles.filter(r => r.doc_id === d.doc_id && norm(r.email) === norm(e));
  const ps = rolesOf(d.doc_id, 'participant');
  return {
    doc_id: d.doc_id, title: d.title, status: d.status, status_label: STATUS[d.status] || d.status,
    initiator: d.initiator, initiator_name: nameOf(d.initiator), round: d.round,
    lock_by: d.lock_by, lock_by_name: d.lock_by ? nameOf(d.lock_by) : '', updated_at: d.updated_at, created_at: d.created_at,
    approved: ps.filter(r => r.decision === 'approved').length, total: ps.length,
    my_decision: (my.find(r => r.role === 'participant') || {}).decision || '',
    my_ack: (my.find(r => r.role === 'acquaint') || {}).ack_at || ''
  };
}
function docDetail(d, e) {
  e = norm(e);
  const isPart = participantsOf(d.doc_id).includes(e);
  const isInit = norm(d.initiator) === e;
  const isSec = e === SECRETARY;
  const isExec = norm(d.executor) === e;
  const ackRole = rolesOf(d.doc_id, 'acquaint').find(r => norm(r.email) === e);
  const locked = !!d.lock_by && !lockExpired(d);
  const q = queueOf(d);
  return Object.assign(docSummary(d, e), {
    gdoc_url: d.gdoc_url, executor: d.executor, executor_name: nameOf(d.executor), secretary: SECRETARY, secretary_name: nameOf(SECRETARY),
    lock_since: d.lock_since, lock_until: d.lock_until, queue: q.map(x => ({ email: x, name: nameOf(x) })),
    done_at: d.done_at,
    participants: rolesOf(d.doc_id, 'participant').map(r => ({ email: r.email, name: nameOf(r.email), decision: r.decision, decision_at: r.decision_at, comment: r.comment })),
    acquaint: rolesOf(d.doc_id, 'acquaint').map(r => ({ email: r.email, name: nameOf(r.email), ack_at: r.ack_at })),
    log: T.log.filter(l => l.doc_id === d.doc_id).slice(-150).reverse().map(l => ({ ts: l.ts, email: l.email, name: nameOf(l.email), action: l.action, details: l.details })),
    me: {
      email: e, is_participant: isPart, is_initiator: isInit, is_secretary: isSec, is_executor: isExec, is_acquaint: !!ackRole,
      acked: ackRole ? !!ackRole.ack_at : false,
      lock_mine: locked && norm(d.lock_by) === e, in_queue: q.includes(e),
      can_lock: d.status === 'review' && isPart && !(locked && norm(d.lock_by) === e),
      can_decide: d.status === 'review' && isPart && !locked,
      can_secretary: d.status === 'secretary' && isSec,
      can_add_acquaint: isSec && (d.status === 'secretary' || d.status === 'acquaint'),
      can_edit_participants: isInit && d.status === 'review',
      can_ack: d.status === 'acquaint' && !!ackRole && !ackRole.ack_at,
      can_done: d.status === 'execution' && isExec
    }
  });
}
function parseEmails(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  return [...new Set(arr.map(norm).filter(Boolean))];
}
function startAcquaint(d, recipients, actor) {
  const list = [];
  for (const e of recipients) {
    let r = rolesOf(d.doc_id, 'acquaint').find(x => norm(x.email) === e);
    if (!r) r = add('roles', { role_id: 'R' + rnd(6), doc_id: d.doc_id, email: e, role: 'acquaint', decision: '', decision_at: '', comment: '', ack_token: rnd(20), ack_at: '' });
    if (!r.ack_token) upd(r, { ack_token: rnd(20) });
    if (!r.ack_at) {
      list.push({ to: e, ack_url: ACK_URL + '?t=' + r.ack_token });
      add('notifications', { notif_id: 'N' + rnd(6), ts: NOW, email: e, doc_id: d.doc_id, text: 'Документ надіслано вам для ознайомлення', read: '' });
    }
  }
  if (list.length) out.pdfJobs.push({ doc_id: d.doc_id, title: d.title, gdoc_id: d.gdoc_id, row: d._row, recipients: list, link: docLink(d.doc_id) });
}
function checkAcquaintDone(d) {
  const ac = rolesOf(d.doc_id, 'acquaint');
  if (d.status === 'acquaint' && ac.every(r => r.ack_at)) {
    upd(d, { status: 'execution', updated_at: NOW });
    log(d.doc_id, 'system', 'to_execution', 'Усі ознайомилися');
    notify([d.executor], d, 'Документ передано вам на виконання', { subject: '«' + d.title + '»: передано на виконання', lines: ['Документ затверджено секретарем, усі посадові особи ознайомилися. Після виконання позначте «Виконано» в порталі.'] });
    notify([d.initiator, SECRETARY], d, 'Усі ознайомилися — документ на виконанні', { email: false, except: d.executor });
  }
}
function fail(msg, code) { out.resp = { ok: false, error: msg, code: code || 'error' }; }
function ok(data) { out.resp = Object.assign({ ok: true }, data || {}); }

// ---------- request routing ----------
const p = req.payload || {};
const action = req.action;
let me = null;
function auth() {
  const s = T.sessions.find(x => x.token && x.token === String(req.token || ''));
  if (!s || new Date(s.expires_at) < now) { fail('Сесія завершилась. Увійдіть знову.', 'auth'); return null; }
  const u = userBy(s.email); if (!u) { fail('Користувача не знайдено.', 'auth'); return null; }
  return norm(u.email);
}
function getDoc() {
  const d = docBy(p.doc_id); if (!d) { fail('Документ не знайдено.'); return null; }
  if (!canSee(d, me)) { fail('Немає доступу до цього документа.', 'forbidden'); return null; }
  return d;
}

try {
  if (req.source === 'tick') {
    for (const d of T.documents.filter(lockExpired)) releaseLock(d, 'system', 'Блокування знято автоматично після ' + LOCK_MIN + ' хв', true);
    ok({ tick: true });
  } else if (req.source === 'daily') {
    const todo = {};
    const push = (e, line) => { e = norm(e); if (!e) return; (todo[e] = todo[e] || []).push(line); };
    for (const d of T.documents) {
      const a = '<a href="' + docLink(d.doc_id) + '">' + esc(d.title) + '</a>';
      if (d.status === 'review') rolesOf(d.doc_id, 'participant').filter(r => !r.decision).forEach(r => push(r.email, a + ' — очікує вашого погодження'));
      if (d.status === 'secretary') push(SECRETARY, a + ' — очікує затвердження секретарем');
      if (d.status === 'acquaint') rolesOf(d.doc_id, 'acquaint').filter(r => !r.ack_at).forEach(r => push(r.email, a + ' — підтвердіть ознайомлення (кнопка в листі з PDF або в порталі)'));
      if (d.status === 'execution') push(d.executor, a + ' — очікує виконання');
    }
    for (const [e, lines] of Object.entries(todo)) {
      out.emails.push({ to: e, subject: 'Нагадування: документи очікують вашої дії (' + lines.length + ')', html: emailHtml('Документи очікують вашої дії', lines.map(l => '• ' + l), 'Відкрити портал', PORTAL) });
    }
    ok({ reminders: Object.keys(todo).length });
  } else if (req.source === 'ack') {
    out.isHtml = true;
    const r = T.roles.find(x => x.role === 'acquaint' && x.ack_token && x.ack_token === String(req.ack_token || ''));
    const page = (t, m) => '<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(t) + '</title></head><body style="font-family:Arial,sans-serif;background:#f3f4f6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="background:#fff;padding:32px 36px;border-radius:12px;max-width:440px;box-shadow:0 1px 4px rgba(0,0,0,.08)"><h2 style="margin:0 0 12px;font-size:20px">' + esc(t) + '</h2><p style="color:#4b5563;line-height:1.5">' + m + '</p><p><a href="' + PORTAL + '" style="color:#2563eb">Перейти до порталу</a></p></div></body></html>';
    if (!r) { out.resp = page('Посилання недійсне', 'Посилання застаріло або вже не діє. Відкрийте документ у порталі.'); }
    else if (!r.ack_at && !req.confirm) {
      const d0 = docBy(r.doc_id);
      out.resp = page('Підтвердження ознайомлення', 'Документ: <b>«' + esc(d0 ? d0.title : '') + '»</b>.<br>Натисніть кнопку, щоб зафіксувати, що ви ознайомилися з документом.</p><p style="margin:22px 0"><a href="' + ACK_URL + '?t=' + encodeURIComponent(r.ack_token) + '&c=1" style="background:#16a34a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;display:inline-block">✓ Підтверджую ознайомлення</a>');
    } else {
      const d = docBy(r.doc_id);
      if (!r.ack_at) {
        upd(r, { ack_at: NOW });
        log(r.doc_id, r.email, 'acknowledged', 'через посилання в листі');
        if (d) checkAcquaintDone(d);
      }
      out.resp = page('Ознайомлення підтверджено', 'Дякуємо! Ваше ознайомлення з документом «' + esc(d ? d.title : '') + '» зафіксовано ' + new Date(r.ack_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) + '.');
    }
  } else {
    // ===== API =====
    if (action === 'request_code') {
      const e = norm(p.email);
      if (!isEmail(e)) fail('Вкажіть коректну пошту.');
      else if (!userBy(e)) fail('Цю пошту не зареєстровано в порталі. Доступ з’являється, коли ініціатор додає вас до документа.', 'unknown_user');
      else {
        const code = String(crypto.randomInt(100000, 1000000));
        const hash = crypto.createHash('sha256').update(e + ':' + code).digest('hex');
        let c = T.codes.find(x => norm(x.email) === e);
        const exp = new Date(now.getTime() + 10 * 60000).toISOString();
        if (c) upd(c, { code: hash, expires_at: exp, attempts: 0 }); else add('codes', { email: e, code: hash, expires_at: exp, attempts: 0 });
        out.emails.push({ to: e, subject: 'Код входу до порталу: ' + code, html: emailHtml('Ваш код входу', ['<span style="font-size:28px;letter-spacing:6px;font-weight:bold">' + code + '</span>', 'Код дійсний 10 хвилин. Якщо ви не запитували код, просто проігноруйте цей лист.'], null, null) });
        ok({ sent: true });
      }
    } else if (action === 'verify_code') {
      const e = norm(p.email); const c = T.codes.find(x => norm(x.email) === e);
      if (!c || !c.code) fail('Спочатку запросіть код.');
      else if (new Date(c.expires_at) < now) { del(c); fail('Код прострочено. Запросіть новий.'); }
      else if ((parseInt(c.attempts || '0', 10) || 0) >= 5) { del(c); fail('Забагато спроб. Запросіть новий код.'); }
      else if (crypto.createHash('sha256').update(e + ':' + String(p.code || '').trim()).digest('hex') !== c.code) { upd(c, { attempts: (parseInt(c.attempts || '0', 10) || 0) + 1 }); fail('Невірний код.'); }
      else {
        del(c);
        const token = rnd(32);
        add('sessions', { token, email: e, expires_at: new Date(now.getTime() + 7 * 86400000).toISOString(), created_at: NOW });
        T.sessions.filter(s => new Date(s.expires_at) < now).forEach(del);
        const u = userBy(e); upd(u, { last_login: NOW });
        ok({ token, user: { email: e, name: u.name, is_secretary: e === SECRETARY } });
      }
    } else if ((me = auth())) {
      const u = userBy(me);
      if (action === 'logout') {
        T.sessions.filter(s => s.token === String(req.token)).forEach(del); ok({});
      } else if (action === 'me') {
        ok({ user: { email: me, name: u.name, is_secretary: me === SECRETARY } });
      } else if (action === 'set_name') {
        const n = String(p.name || '').trim().slice(0, 80);
        if (!n) fail('Вкажіть ім’я.'); else { upd(u, { name: n }); ok({ user: { email: me, name: n, is_secretary: me === SECRETARY } }); }
      } else if (action === 'dashboard') {
        const mine = T.documents.filter(d => canSee(d, me));
        const S = d => docSummary(d, me);
        const notes = T.notifications.filter(n => norm(n.email) === me).slice(-40).reverse();
        ok({
          user: { email: me, name: u.name, is_secretary: me === SECRETARY },
          review: mine.filter(d => d.status === 'review' && participantsOf(d.doc_id).includes(me)).map(S),
          initiated: mine.filter(d => norm(d.initiator) === me).map(S),
          secretary: me === SECRETARY ? mine.filter(d => d.status === 'secretary').map(S) : [],
          all: me === SECRETARY ? mine.map(S) : [],
          acquaint: mine.filter(d => rolesOf(d.doc_id, 'acquaint').some(r => norm(r.email) === me)).map(S),
          execution: mine.filter(d => norm(d.executor) === me && (d.status === 'execution' || d.status === 'done')).map(S),
          notifications: notes.map(n => ({ id: n.notif_id, ts: n.ts, doc_id: n.doc_id, text: n.text, read: n.read === '1', title: (docBy(n.doc_id) || {}).title || '' })),
          unread: notes.filter(n => n.read !== '1').length
        });
      } else if (action === 'mark_read') {
        const ids = Array.isArray(p.ids) ? p.ids : null;
        T.notifications.filter(n => norm(n.email) === me && n.read !== '1' && (!ids || ids.includes(n.notif_id))).forEach(n => upd(n, { read: '1' }));
        ok({});
      } else if (action === 'create_document') {
        const title = String(p.title || '').trim().slice(0, 200);
        const parts = parseEmails(p.participants).filter(e => e !== me);
        const acq = parseEmails(p.acquaint);
        const ex = norm(p.executor);
        const bad = [...parts, ...acq, ex].filter(e => !isEmail(e));
        if (!title) fail('Вкажіть назву документа.');
        else if (bad.length) fail('Некоректні пошти: ' + bad.join(', '));
        else if (!upload || !upload.id) fail('Не вдалося завантажити Word-файл. Перевірте формат (.docx) і спробуйте ще раз.');
        else {
          const id = 'D' + NOW.slice(2, 10).replace(/-/g, '') + '-' + rnd(3).toUpperCase();
          const d = add('documents', { doc_id: id, title, gdoc_id: upload.id, gdoc_url: 'https://docs.google.com/document/d/' + upload.id + '/edit', initiator: me, executor: ex, status: 'review', round: 1, lock_by: '', lock_since: '', lock_until: '', queue: '', pdf_id: '', pdf_url: '', created_at: NOW, updated_at: NOW, done_at: '' });
          const everyone = [me, ...parts];
          for (const e of everyone) add('roles', { role_id: 'R' + rnd(6), doc_id: id, email: e, role: 'participant', decision: '', decision_at: '', comment: '', ack_token: '', ack_at: '' });
          for (const e of acq) add('roles', { role_id: 'R' + rnd(6), doc_id: id, email: e, role: 'acquaint', decision: '', decision_at: '', comment: '', ack_token: rnd(20), ack_at: '' });
          const allPeople = [...new Set([...everyone, ...acq, ex, SECRETARY].filter(Boolean))];
          const newUsers = allPeople.filter(e => ensureUser(e).created);
          for (const e of [...new Set([...everyone, ex, SECRETARY])]) drive(upload.id, e, 'reader');
          log(id, me, 'created', 'Учасники: ' + everyone.join(', ') + '; виконавець: ' + ex + (acq.length ? '; ознайомлення: ' + acq.join(', ') : ''));
          const invite = e => newUsers.includes(e) ? ['Вас додано до Порталу погодження документів. Для входу відкрийте портал і вкажіть цю пошту — код входу прийде листом.'] : [];
          for (const e of parts) notify([e], d, 'Новий документ на погодження', { subject: '«' + title + '»: запрошення до спільного редагування', lines: ['<b>Ініціатор:</b> ' + esc(nameOf(me)), 'Перегляньте документ, за потреби внесіть правки (кнопка «Взяти на редагування») і погодьте редакцію.'].concat(invite(e), ['Для редагування в Google Docs потрібен вхід у Google-акаунт з цією поштою.']) });
          const informOnly = [...new Set([ex, ...acq])].filter(e => e && !everyone.includes(e) && newUsers.includes(e));
          for (const e of informOnly) out.emails.push({ to: e, subject: 'Запрошення до Порталу погодження документів', html: emailHtml('Вас додано до порталу', ['Документ «' + esc(title) + '» надійде вам після погодження і затвердження.', 'Для входу відкрийте портал і вкажіть цю пошту — код входу прийде листом.'], 'Відкрити портал', PORTAL) });
          ok({ doc_id: id });
        }
      } else if (action === 'doc_get') {
        const d = getDoc(); if (d) ok({ doc: docDetail(d, me) });
      } else if (action === 'lock') {
        const d = getDoc();
        if (d) {
          if (d.status !== 'review') fail('Документ уже не на етапі редагування.');
          else if (!participantsOf(d.doc_id).includes(me)) fail('Редагувати можуть лише учасники погодження.');
          else if (lockExpired(d)) { releaseLock(d, 'system', 'Блокування знято автоматично', true); }
          if (!out.resp) {
            if (!d.lock_by) {
              const until = new Date(now.getTime() + LOCK_MIN * 60000).toISOString();
              upd(d, { lock_by: me, lock_since: NOW, lock_until: until, queue: queueOf(d).filter(x => x !== me).join(','), updated_at: NOW });
              drive(d.gdoc_id, me, 'writer');
              log(d.doc_id, me, 'lock', 'до ' + until);
              notify(participantsOf(d.doc_id), d, nameOf(me) + ' почав(ла) редагування', { email: false, except: me });
              ok({ locked: true, doc: docDetail(d, me) });
            } else if (norm(d.lock_by) === me) {
              upd(d, { lock_until: new Date(now.getTime() + LOCK_MIN * 60000).toISOString() });
              ok({ locked: true, extended: true, doc: docDetail(d, me) });
            } else {
              const q = queueOf(d); if (!q.includes(me)) q.push(me);
              upd(d, { queue: q.join(',') }); log(d.doc_id, me, 'queue', 'Став(ла) у чергу');
              ok({ queued: true, position: q.indexOf(me) + 1, doc: docDetail(d, me) });
            }
          }
        }
      } else if (action === 'unlock') {
        const d = getDoc();
        if (d) {
          if (norm(d.lock_by) !== me) fail('Документ не заблоковано вами.');
          else { releaseLock(d, me, String(p.comment || '').slice(0, 1000), false); ok({ doc: docDetail(d, me) }); }
        }
      } else if (action === 'leave_queue') {
        const d = getDoc(); if (d) { upd(d, { queue: queueOf(d).filter(x => x !== me).join(',') }); ok({ doc: docDetail(d, me) }); }
      } else if (action === 'decide') {
        const d = getDoc();
        if (d) {
          const r = rolesOf(d.doc_id, 'participant').find(x => norm(x.email) === me);
          const comment = String(p.comment || '').trim().slice(0, 1000);
          if (d.status !== 'review' || !r) fail('Ви не можете погоджувати цей документ зараз.');
          else if (d.lock_by && !lockExpired(d)) fail('Документ зараз редагується. Погодження можливе після завершення правок.');
          else if (p.decision === 'approved') {
            upd(r, { decision: 'approved', decision_at: NOW, comment }); upd(d, { updated_at: NOW });
            log(d.doc_id, me, 'approved', comment);
            if (allApproved(d)) {
              upd(d, { status: 'secretary' });
              log(d.doc_id, 'system', 'to_secretary', 'Редакцію погодили всі учасники (раунд ' + d.round + ')');
              notify([SECRETARY], d, 'Документ погоджено всіма учасниками — потрібне ваше затвердження', { subject: '«' + d.title + '»: на затвердження секретарю', lines: ['Усі учасники погодили редакцію. Затвердіть документ або поверніть на доопрацювання.'] });
              notify(participantsOf(d.doc_id), d, 'Редакцію погоджено всіма — документ передано секретарю', { except: SECRETARY });
            } else {
              notify(participantsOf(d.doc_id), d, nameOf(me) + ' погодив(ла) редакцію', { email: false, except: me });
            }
            ok({ doc: docDetail(d, me) });
          } else if (p.decision === 'rejected') {
            if (!comment) fail('Вкажіть причину відхилення.');
            else {
              log(d.doc_id, me, 'rejected', comment);
              resetRound(d);
              notify(participantsOf(d.doc_id), d, nameOf(me) + ' відхилив(ла) редакцію — погодження обнулено', { except: me, lines: ['<b>Коментар:</b> ' + esc(comment), 'Розпочато новий раунд. Внесіть правки та погодьте нову редакцію.'] });
              ok({ doc: docDetail(d, me) });
            }
          } else fail('Невідоме рішення.');
        }
      } else if (action === 'secretary_approve') {
        const d = getDoc();
        if (d) {
          if (me !== SECRETARY || d.status !== 'secretary') fail('Дія недоступна.');
          else {
            const ac = parseEmails(p.acquaint).filter(isEmail);
            ac.forEach(e => { if (!rolesOf(d.doc_id, 'acquaint').some(r => norm(r.email) === e)) { ensureUser(e); add('roles', { role_id: 'R' + rnd(6), doc_id: d.doc_id, email: e, role: 'acquaint', decision: '', decision_at: '', comment: '', ack_token: rnd(20), ack_at: '' }); } });
            log(d.doc_id, me, 'secretary_approved', String(p.comment || ''));
            const acq = rolesOf(d.doc_id, 'acquaint').map(r => norm(r.email));
            notify([...participantsOf(d.doc_id)], d, 'Документ затверджено секретарем і запущено в роботу', { except: me });
            if (acq.length) {
              upd(d, { status: 'acquaint', updated_at: NOW });
              startAcquaint(d, acq, me);
            } else {
              upd(d, { status: 'acquaint', updated_at: NOW });
              checkAcquaintDone(d);
              out.pdfJobs.push({ doc_id: d.doc_id, title: d.title, gdoc_id: d.gdoc_id, row: d._row, recipients: [], link: docLink(d.doc_id) });
            }
            ok({ doc: docDetail(d, me) });
          }
        }
      } else if (action === 'secretary_return') {
        const d = getDoc();
        if (d) {
          const comment = String(p.comment || '').trim();
          if (me !== SECRETARY || d.status !== 'secretary') fail('Дія недоступна.');
          else if (!comment) fail('Вкажіть, що потрібно доопрацювати.');
          else {
            log(d.doc_id, me, 'secretary_returned', comment);
            resetRound(d);
            notify(participantsOf(d.doc_id), d, 'Секретар повернув документ на доопрацювання', { except: me, lines: ['<b>Коментар секретаря:</b> ' + esc(comment), 'Погодження обнулено, розпочато новий раунд.'] });
            ok({ doc: docDetail(d, me) });
          }
        }
      } else if (action === 'add_acquaint') {
        const d = getDoc();
        if (d) {
          const list = parseEmails(p.emails);
          const bad = list.filter(e => !isEmail(e));
          if (me !== SECRETARY || !['secretary', 'acquaint'].includes(d.status)) fail('Дія недоступна.');
          else if (!list.length || bad.length) fail('Перевірте пошти' + (bad.length ? ': ' + bad.join(', ') : '.'));
          else {
            const fresh = list.filter(e => !rolesOf(d.doc_id, 'acquaint').some(r => norm(r.email) === e));
            fresh.forEach(e => { ensureUser(e); add('roles', { role_id: 'R' + rnd(6), doc_id: d.doc_id, email: e, role: 'acquaint', decision: '', decision_at: '', comment: '', ack_token: rnd(20), ack_at: '' }); });
            log(d.doc_id, me, 'acquaint_added', fresh.join(', '));
            if (d.status === 'acquaint' && fresh.length) startAcquaint(d, fresh, me);
            ok({ doc: docDetail(d, me) });
          }
        }
      } else if (action === 'update_participants') {
        const d = getDoc();
        if (d) {
          if (norm(d.initiator) !== me || d.status !== 'review') fail('Змінювати склад може лише ініціатор на етапі погодження.');
          else {
            const addL = parseEmails(p.add).filter(e => !participantsOf(d.doc_id).includes(e));
            const remL = parseEmails(p.remove).filter(e => e !== me && participantsOf(d.doc_id).includes(e));
            const bad = addL.filter(e => !isEmail(e));
            if (bad.length) fail('Некоректні пошти: ' + bad.join(', '));
            else if (!addL.length && !remL.length) fail('Немає змін.');
            else {
              for (const e of remL) {
                if (norm(d.lock_by) === e) releaseLock(d, me, 'Учасника видалено', true);
                rolesOf(d.doc_id, 'participant').filter(r => norm(r.email) === e).forEach(del);
                upd(d, { queue: queueOf(d).filter(x => x !== e).join(',') });
                if (e !== SECRETARY && e !== norm(d.executor)) drive(d.gdoc_id, e, 'remove');
              }
              for (const e of addL) {
                const { created } = ensureUser(e);
                add('roles', { role_id: 'R' + rnd(6), doc_id: d.doc_id, email: e, role: 'participant', decision: '', decision_at: '', comment: '', ack_token: '', ack_at: '' });
                drive(d.gdoc_id, e, 'reader');
                notify([e], d, 'Вас додано до погодження документа', { subject: '«' + d.title + '»: запрошення до спільного редагування', lines: ['<b>Ініціатор:</b> ' + esc(nameOf(me))].concat(created ? ['Для входу відкрийте портал і вкажіть цю пошту — код входу прийде листом.'] : []) });
              }
              log(d.doc_id, me, 'participants_changed', (addL.length ? 'додано: ' + addL.join(', ') : '') + (remL.length ? ' видалено: ' + remL.join(', ') : ''));
              if (addL.length) { resetRound(d); notify(participantsOf(d.doc_id), d, 'Склад учасників змінено — погодження обнулено', { email: false, except: me }); }
              ok({ doc: docDetail(d, me) });
            }
          }
        }
      } else if (action === 'ack') {
        const d = getDoc();
        if (d) {
          const r = rolesOf(d.doc_id, 'acquaint').find(x => norm(x.email) === me);
          if (!r || d.status !== 'acquaint') fail('Дія недоступна.');
          else { if (!r.ack_at) { upd(r, { ack_at: NOW }); log(d.doc_id, me, 'acknowledged', 'у порталі'); checkAcquaintDone(d); } ok({ doc: docDetail(d, me) }); }
        }
      } else if (action === 'executor_done') {
        const d = getDoc();
        if (d) {
          if (norm(d.executor) !== me || d.status !== 'execution') fail('Дія недоступна.');
          else {
            const comment = String(p.comment || '').trim().slice(0, 1000);
            upd(d, { status: 'done', done_at: NOW, updated_at: NOW });
            log(d.doc_id, me, 'done', comment);
            notify([d.initiator, SECRETARY], d, 'Документ виконано', { except: me, lines: comment ? ['<b>Коментар виконавця:</b> ' + esc(comment)] : [] });
            ok({ doc: docDetail(d, me) });
          }
        }
      } else {
        fail('Невідома дія: ' + action);
      }
    }
  }
} catch (err) {
  out.resp = { ok: false, error: 'Внутрішня помилка: ' + err.message, code: 'internal' };
}

// ---------- writes ----------
const writes = [];
for (const o of dirty) {
  writes.push({ range: o._tab + '!A' + o._row, values: [COLS[o._tab].map(c => o._deleted ? '' : (o[c] == null ? '' : String(o[c])))] });
}
out.writes = writes;
if (!out.resp) out.resp = { ok: true };
out.respBody = out.isHtml ? out.resp : JSON.stringify(out.resp);
out.contentType = out.isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
out.hasWrites = writes.length > 0;
return [{ json: out }];
