// Local simulation of the Logic node against an in-memory sheet
const fs = require('fs');
const code = fs.readFileSync(__dirname + '/logic.js', 'utf8');
const H = {
  settings: ['key','value'], users: ['email','name','created_at','last_login'], codes: ['email','code','expires_at','attempts'],
  sessions: ['token','email','expires_at','created_at'],
  documents: ['doc_id','title','gdoc_id','gdoc_url','initiator','executor','status','round','lock_by','lock_since','lock_until','queue','pdf_id','pdf_url','created_at','updated_at','done_at'],
  roles: ['role_id','doc_id','email','role','decision','decision_at','comment','ack_token','ack_at'],
  log: ['ts','doc_id','email','action','details'], notifications: ['notif_id','ts','email','doc_id','text','read']
};
const sheet = {};
for (const t in H) sheet[t] = [H[t]];
sheet.settings.push(['secretary_email','sec@x.com'],['portal_url','https://p/'],['lock_minutes','60']);
sheet.users.push(['init@x.com','Ініціатор','','']);
sheet.users.push(['sec@x.com','Секретар','','']);
function run(req, uploadId) {
  const valueRanges = Object.keys(sheet).map(t => ({ range: t + '!A1:Z1000', values: sheet[t].map(r => r.slice()) }));
  const $ = name => ({ first: () => {
    if (name === 'Normalize Request') return { json: req };
    if (name === 'Read Sheets') return { json: { valueRanges } };
    if (name === 'Convert To Google Doc') { if (!uploadId) throw new Error('not run'); return { json: { id: uploadId } }; }
  }});
  const fn = new Function('$', 'require', code);
  const out = fn($, require)[0].json;
  for (const w of out.writes) {
    const [tab, cell] = w.range.split('!'); const row = parseInt(cell.slice(1), 10);
    while (sheet[tab].length < row) sheet[tab].push([]);
    sheet[tab][row - 1] = w.values[0];
  }
  // trim trailing empty rows like Sheets API does
  for (const t in sheet) while (sheet[t].length > 1 && sheet[t][sheet[t].length - 1].every(v => v === '')) sheet[t].pop();
  return out;
}
const api = (action, payload, token, up) => run({ source: 'api', action, payload, token }, up);
let lastCode = {};
function login(email) {
  const o = api('request_code', { email });
  if (!o.resp.ok) throw new Error(o.resp.error);
  const code = o.emails[0].subject.match(/(\d{6})/)[1];
  const v = api('verify_code', { email, code });
  if (!v.resp.ok) throw new Error(v.resp.error);
  return v.resp.token;
}
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } else console.log('ok -', m); };

const ti = login('init@x.com');
assert(api('verify_code', { email: 'init@x.com', code: '000000' }).resp.ok === false, 'bad code rejected');
assert(api('request_code', { email: 'nobody@x.com' }).resp.code === 'unknown_user', 'unknown user');
let o = api('create_document', { title: 'Протокол №1', participants: 'a@x.com, b@x.com', acquaint: 'c@x.com;d@x.com', executor: 'e@x.com' }, ti, 'GDOC1');
assert(o.resp.ok, 'created ' + JSON.stringify(o.resp));
const id = o.resp.doc_id;
assert(o.drive.length === 5, 'drive shares ' + o.drive.length);
assert(o.emails.length >= 2, 'invite emails ' + o.emails.length);
const ta = login('a@x.com'), tb = login('b@x.com'), ts = login('sec@x.com'), tc = login('c@x.com'), te = login('e@x.com');
o = api('lock', { doc_id: id }, ta); assert(o.resp.locked && o.drive[0].role === 'writer', 'a locks');
o = api('lock', { doc_id: id }, tb); assert(o.resp.queued, 'b queued');
o = api('decide', { doc_id: id, decision: 'approved' }, ti); assert(!o.resp.ok, 'cannot decide while locked');
o = api('unlock', { doc_id: id, comment: 'виправила п.2' }, ta); assert(o.resp.ok && o.summaryJobs.length === 1 && o.emails.some(e => e.to === 'b@x.com'), 'a unlocks, b notified, summary job');
assert(o.resp.doc.round === '2', 'round 2');
for (const t of [ti, ta]) assert(api('decide', { doc_id: id, decision: 'approved' }, t).resp.ok, 'approve');
o = api('decide', { doc_id: id, decision: 'rejected', comment: 'не згоден' }, tb); assert(o.resp.doc.round === '3' && o.resp.doc.approved === 0, 'reject resets');
for (const t of [ti, ta, tb]) o = api('decide', { doc_id: id, decision: 'approved' }, t);
assert(o.resp.doc.status === 'secretary', 'to secretary');
o = api('secretary_return', { doc_id: id, comment: 'додати дату' }, ts); assert(o.resp.doc.status === 'review', 'returned');
for (const t of [ti, ta, tb]) o = api('decide', { doc_id: id, decision: 'approved' }, t);
o = api('secretary_approve', { doc_id: id }, ts); assert(o.resp.doc.status === 'acquaint' && o.pdfJobs[0].recipients.length === 2, 'secretary approved, pdf job');
const ackUrl = o.pdfJobs[0].recipients.find(r => r.to === 'd@x.com').ack_url;
o = api('ack', { doc_id: id }, tc); assert(o.resp.doc.status === 'acquaint', 'c acked via portal');
o = run({ source: 'ack', ack_token: ackUrl.split('t=')[1] }); assert(/Підтверджую/.test(o.resp) && o.writes.length===0, 'confirm page'); o = run({ source: 'ack', ack_token: ackUrl.split('t=')[1], confirm: true }); assert(o.isHtml && /підтверджено/.test(o.resp), 'd acked via link');
o = api('dashboard', {}, te); assert(o.resp.execution.length === 1 && o.resp.execution[0].status === 'execution', 'executor sees doc');
o = run({ source: 'daily' }); console.log('daily emails', o.emails.map(e => e.to));
o = api('executor_done', { doc_id: id, comment: 'зроблено' }, te); assert(o.resp.doc.status === 'done', 'done');
// lock expiry via tick
o = api('create_document', { title: 'Док 2', participants: 'a@x.com', acquaint: '', executor: 'e@x.com' }, ti, 'GDOC2');
const id2 = o.resp.doc_id;
api('lock', { doc_id: id2 }, ta);
const drow = sheet.documents.find(r => r[0] === id2); drow[10] = new Date(Date.now() - 1000).toISOString();
o = run({ source: 'tick' }); assert(o.summaryJobs.length === 1 && o.drive[0].role === 'reader', 'tick releases');
o = api('update_participants', { doc_id: id2, add: 'z@x.com', remove: 'a@x.com' }, ti); assert(o.resp.ok && o.drive.length === 2, 'participants changed');
o = api('dashboard', {}, ti); console.log('notifications for init:', o.resp.unread);
console.log('ALL OK; rows:', Object.fromEntries(Object.entries(sheet).map(([k, v]) => [k, v.length - 1])));
