// API L2C : comptes, équipes (rôles), projets cloud. Stockage : Vercel Blob (privé) ou dossier local (tests, L2C_LOCAL=1).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROLES = ['viewer', 'editor', 'admin', 'owner'];
const ROLE_LABEL = { viewer: 'lecteur', editor: 'éditeur', admin: 'administrateur', owner: 'propriétaire' };
const rk = r => ROLES.indexOf(r);
const SECRET = () => process.env.AUTH_SECRET || (process.env.L2C_LOCAL ? 'dev-secret' : '');
const COOKIE = 'l2c_session';
const DAYS = 30;

/* ---------- stockage ---------- */
const LOCAL = process.env.L2C_LOCAL ? (process.env.L2C_DIR || path.join(os.tmpdir(), 'l2c-dev')) : null;
let blob = null;
async function B() { return blob || (blob = await import('@vercel/blob')); }
const configured = () => !!LOCAL || !!process.env.BLOB_READ_WRITE_TOKEN || !!process.env.BLOB_STORE_ID;
async function getBuf(p) {
  if (LOCAL) { try { return await fs.readFile(path.join(LOCAL, p)); } catch { return null; } }
  const { get } = await B(); const r = await get(p, { access: 'private', useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200) return null; return Buffer.from(await new Response(r.stream).arrayBuffer());
}
async function putBuf(p, buf, type = 'application/octet-stream') {
  if (LOCAL) { const f = path.join(LOCAL, p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, buf); return; }
  const { put } = await B(); await put(p, buf, { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: type, cacheControlMaxAge: 60 });
}
async function delBuf(p) {
  if (LOCAL) { await fs.rm(path.join(LOCAL, p), { force: true }); return; }
  const { del } = await B(); try { await del(p); } catch {}
}
const getJ = async p => { const b = await getBuf(p); if (!b) return null; try { return JSON.parse(b.toString('utf8')); } catch { return null; } };
const putJ = (p, o) => putBuf(p, Buffer.from(JSON.stringify(o)), 'application/json');

/* ---------- outils ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomBytes(9).toString('hex');
const normEmail = e => String(e || '').trim().toLowerCase();
const okEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length < 200;
function hashPwd(pw) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function checkPwd(pw, h) { const [s, x] = String(h).split(':'); if (!s || !x) return false; const y = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); const xb = Buffer.from(x, 'hex'); return xb.length === y.length && crypto.timingSafeEqual(xb, y); }
const b64 = b => Buffer.from(b).toString('base64url');
function sign(uid) { const pl = b64(JSON.stringify({ u: uid, e: Date.now() + DAYS * 864e5 })); return pl + '.' + crypto.createHmac('sha256', SECRET()).update(pl).digest('base64url'); }
function verify(tok) { if (!tok || !SECRET()) return null; const [pl, sg] = tok.split('.'); if (!pl || !sg) return null; const ex = crypto.createHmac('sha256', SECRET()).update(pl).digest('base64url'); if (sg.length !== ex.length || !crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(ex))) return null; try { const o = JSON.parse(Buffer.from(pl, 'base64url').toString()); return o.e > Date.now() ? o.u : null; } catch { return null; } }
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, v.join('=')]));
function setSession(req, res, uid) { const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : ''; res.setHeader('Set-Cookie', `${COOKIE}=${uid ? sign(uid) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${uid ? DAYS * 86400 : 0}${secure}`); }
async function readBody(req, max = 4.4e6) { const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error('Corps trop volumineux'), { code: 413 }); ch.push(c); } return Buffer.concat(ch); }
const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); };
const fail = (code, msg) => Object.assign(new Error(msg), { code });

/* ---------- modèle ---------- */
const uPath = id => `u/${id}.json`, ePath = e => `e/${sha(e)}.json`, tPath = id => `t/${id}.json`, pMeta = id => `p/${id}/meta.json`, pPart = (id, k) => `p/${id}/${k}.gz`;
const getUser = id => getJ(uPath(id));
const pubUser = u => ({ id: u.id, email: u.email, name: u.name, prefs: u.prefs || {}, sa: !!u.sa, mustChange: !!u.mustChange });
async function idxAdd(p, id) { const m = (await getJ(p)) || { list: [] }; if (!m.list.includes(id)) m.list.push(id); await putJ(p, m); }
async function idxDel(p, id) { const m = (await getJ(p)) || { list: [] }; m.list = m.list.filter(x => x !== id); await putJ(p, m); }
const tempPwd = () => { const A = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(12), b => A[b % A.length]).join('').replace(/(.{4})(?=.)/g, '$1-'); };
async function userTeams(u) { const out = []; for (const tid of u.teams || []) { const t = await getJ(tPath(tid)); if (t && t.members[u.id]) out.push({ id: t.id, name: t.name, role: t.members[u.id] }); } return out; }
async function projectsOf(u) {
  const ids = new Map(); for (const id of u.projects || []) ids.set(id, null);
  for (const tid of u.teams || []) { const t = await getJ(tPath(tid)); if (t && t.members[u.id]) (t.projects || []).forEach(id => ids.set(id, tid)); }
  const out = []; for (const id of ids.keys()) { const m = await getJ(pMeta(id)); if (m) out.push(await withRole(u, m)); } return out.sort((a, b) => b.updated - a.updated);
}
async function roleIn(u, m) { if (m.owner === u.id) return 'owner'; if (m.team) { const t = await getJ(tPath(m.team)); if (t && t.members[u.id]) { const r = t.members[u.id]; return r === 'owner' ? 'admin' : r; } } return null; }
async function withRole(u, m) { return { id: m.id, name: m.name, team: m.team || null, owner: m.owner, rev: m.rev, updated: m.updated, hv: m.hv || 0, role: await roleIn(u, m), by: m.by || '' }; }
async function applyInvites(u) {
  const inv = await getJ(`inv/${sha(u.email)}.json`); if (!inv || !inv.list.length) return false;
  for (const { team, role } of inv.list) { const t = await getJ(tPath(team)); if (!t) continue; if (!t.members[u.id]) { t.members[u.id] = role; delete (t.invites || {})[u.email]; await putJ(tPath(t.id), t); if (!(u.teams || []).includes(t.id)) (u.teams = u.teams || []).push(t.id); } }
  await putJ(`inv/${sha(u.email)}.json`, { list: [] }); await putJ(uPath(u.id), u); return true;
}
async function addInvite(email, team, role) { const p = `inv/${sha(email)}.json`, inv = (await getJ(p)) || { list: [] }; inv.list = inv.list.filter(x => x.team !== team); inv.list.push({ team, role }); await putJ(p, inv); }

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x'), r = url.searchParams.get('r') || '';
  if (!configured()) return send(res, 503, { error: 'storage_not_configured', message: 'Stockage Vercel Blob non configuré pour ce déploiement.' });
  if (!SECRET()) return send(res, 503, { error: 'auth_not_configured', message: 'Variable AUTH_SECRET manquante.' });
  const raw = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : Buffer.alloc(0);
  const ctype = String(req.headers['content-type'] || '');
  const J = ctype.includes('json') && raw.length ? JSON.parse(raw.toString('utf8')) : {};
  const uid = verify(cookies(req)[COOKIE]); let me = uid ? await getUser(uid) : null; if (me && me.disabled) me = null;

  if (r === 'register') {
    const email = normEmail(J.email), name = String(J.name || '').trim().slice(0, 80), pw = String(J.password || '');
    if (!okEmail(email)) throw fail(400, 'Courriel invalide.'); if (!name) throw fail(400, 'Nom requis.'); if (pw.length < 8) throw fail(400, 'Mot de passe : 8 caractères minimum.');
    if (await getJ(ePath(email))) throw fail(409, 'Un compte existe déjà avec ce courriel.');
    const first = !(await getJ('meta/org.json'));
    const u = { id: rid(), email, name, pwd: hashPwd(pw), prefs: {}, teams: [], projects: [], created: Date.now(), sa: first };
    await putJ(uPath(u.id), u); await putJ(ePath(email), { id: u.id }); await idxAdd('meta/users.json', u.id);
    if (first) { // premier compte : crée l'équipe de l'entreprise, dont il est propriétaire
      const t = { id: rid(), name: 'L2C Experts conseils', members: { [u.id]: 'owner' }, invites: {}, projects: [], created: Date.now() };
      await putJ(tPath(t.id), t); await idxAdd('meta/teams.json', t.id); u.teams.push(t.id); await putJ(uPath(u.id), u); await putJ('meta/org.json', { team: t.id });
    }
    await applyInvites(u); setSession(req, res, u.id);
    return send(res, 200, { user: pubUser(u), teams: await userTeams(u), projects: await projectsOf(u) });
  }
  if (r === 'forgot') { const e = normEmail(J.email); if (okEmail(e) && (await getJ(ePath(e)))) { const m = (await getJ('meta/resets.json')) || { list: [] }; if (!m.list.find(x => x.email === e)) { m.list.push({ email: e, at: Date.now() }); await putJ('meta/resets.json', m); } } return send(res, 200, { ok: true }); }
  if (r === 'login') {
    const e = await getJ(ePath(normEmail(J.email))), u = e && await getUser(e.id);
    if (!u || !checkPwd(String(J.password || ''), u.pwd)) throw fail(401, 'Courriel ou mot de passe incorrect.');
    if (u.disabled) throw fail(403, 'Compte désactivé : contactez un administrateur.');
    await applyInvites(u); setSession(req, res, u.id);
    return send(res, 200, { user: pubUser(u), teams: await userTeams(u), projects: await projectsOf(u) });
  }
  if (r === 'logout') { setSession(req, res, null); return send(res, 200, { ok: true }); }
  if (!me) { if (r === 'me') return send(res, 200, { user: null }); throw fail(401, 'Connexion requise.'); }

  if (r === 'me') { if (await applyInvites(me)) { /* nouvelles équipes */ } return send(res, 200, { user: pubUser(me), teams: await userTeams(me), projects: await projectsOf(me) }); }
  if (r === 'prefs') { me.prefs = Object.assign(me.prefs || {}, J.prefs || {}); if (JSON.stringify(me.prefs).length > 20000) throw fail(413, 'Préférences trop volumineuses.'); if (typeof J.name === 'string' && J.name.trim()) me.name = J.name.trim().slice(0, 80); await putJ(uPath(me.id), me); return send(res, 200, { user: pubUser(me) }); }
  if (r === 'password') { if (!checkPwd(String(J.old || ''), me.pwd)) throw fail(401, 'Mot de passe actuel incorrect.'); if (String(J.password || '').length < 8) throw fail(400, 'Mot de passe : 8 caractères minimum.'); me.pwd = hashPwd(J.password); me.mustChange = false; await putJ(uPath(me.id), me); return send(res, 200, { user: pubUser(me) }); }

  /* administration (premier compte = administrateur de la plateforme) */
  if (r.startsWith('admin_')) {
    if (!me.sa) throw fail(403, 'Réservé aux administrateurs.');
    if (r === 'admin_list') {
      const ids = ((await getJ('meta/users.json')) || { list: [] }).list, users = [];
      for (const id of ids) { const u = await getUser(id); if (!u) continue; const tn = []; for (const t of u.teams || []) { const x = await getJ(tPath(t)); if (x && x.members[u.id]) tn.push(x.name + ' (' + (ROLE_LABEL[x.members[u.id]] || '') + ')'); } users.push({ id: u.id, email: u.email, name: u.name, created: u.created, disabled: !!u.disabled, sa: !!u.sa, mustChange: !!u.mustChange, teams: tn }); }
      const tids = ((await getJ('meta/teams.json')) || { list: [] }).list, teams = []; for (const id of tids) { const t = await getJ(tPath(id)); if (t) teams.push({ id: t.id, name: t.name, members: Object.keys(t.members).length, projects: (t.projects || []).length }); }
      return send(res, 200, { users, teams, resets: ((await getJ('meta/resets.json')) || { list: [] }).list });
    }
    const tu = J.uid ? await getUser(J.uid) : null; if (!tu) throw fail(404, 'Utilisateur introuvable.');
    if (r === 'admin_reset') { const temp = tempPwd(); tu.pwd = hashPwd(temp); tu.mustChange = true; await putJ(uPath(tu.id), tu); const m = (await getJ('meta/resets.json')) || { list: [] }; m.list = m.list.filter(x => x.email !== tu.email); await putJ('meta/resets.json', m); return send(res, 200, { temp }); }
    if (r === 'admin_toggle') { if (tu.id === me.id) throw fail(400, 'Vous ne pouvez pas désactiver votre propre compte.'); tu.disabled = !!J.disabled; await putJ(uPath(tu.id), tu); return send(res, 200, { ok: true }); }
    if (r === 'admin_grant') { const ids = ((await getJ('meta/users.json')) || { list: [] }).list; let n = 0; for (const id of ids) { const u = await getUser(id); if (u && u.sa) n++; } if (!J.sa && tu.sa && n < 2) throw fail(409, 'Il doit rester au moins un administrateur.'); tu.sa = !!J.sa; await putJ(uPath(tu.id), tu); return send(res, 200, { ok: true }); }
    if (r === 'admin_delete') {
      if (tu.id === me.id) throw fail(400, 'Vous ne pouvez pas supprimer votre propre compte.'); if (tu.sa) throw fail(409, 'Retirez d’abord le rôle d’administrateur à ce compte.');
      for (const tid of tu.teams || []) { const t = await getJ(tPath(tid)); if (t) { if (t.members[tu.id] === 'owner' && Object.values(t.members).filter(x => x === 'owner').length < 2) throw fail(409, 'Cet utilisateur est le seul propriétaire de l’équipe « ' + t.name + ' » : nommez un autre propriétaire d’abord.'); delete t.members[tu.id]; await putJ(tPath(t.id), t); } }
      for (const pid of tu.projects || []) { for (const k of ['state', 'ds', 'px']) await delBuf(pPart(pid, k)); await delBuf(pMeta(pid)); }
      await delBuf(ePath(tu.email)); await delBuf(uPath(tu.id)); await idxDel('meta/users.json', tu.id); return send(res, 200, { ok: true });
    }
    throw fail(404, 'Route inconnue.');
  }

  /* équipes */
  if (r === 'team_new') { const name = String(J.name || '').trim().slice(0, 80); if (!name) throw fail(400, 'Nom requis.'); const t = { id: rid(), name, members: { [me.id]: 'owner' }, invites: {}, projects: [], created: Date.now() }; await putJ(tPath(t.id), t); await idxAdd('meta/teams.json', t.id); me.teams.push(t.id); await putJ(uPath(me.id), me); return send(res, 200, { team: { id: t.id, name, role: 'owner' } }); }
  const tid = url.searchParams.get('t') || J.team || '';
  if (r.startsWith('team_')) {
    const t = await getJ(tPath(tid)); if (!t || (!t.members[me.id] && !me.sa)) throw fail(404, 'Équipe introuvable.'); const my = me.sa ? 'owner' : t.members[me.id];
    if (r === 'team_get') { const ms = []; for (const [id, role] of Object.entries(t.members)) { const u = await getUser(id); if (u) ms.push({ id, role, name: u.name, email: u.email }); } return send(res, 200, { team: { id: t.id, name: t.name, role: my, members: ms, invites: Object.entries(t.invites || {}).map(([email, role]) => ({ email, role })) } }); }
    if (rk(my) < rk('admin')) throw fail(403, 'Droits insuffisants (administrateur requis).');
    if (r === 'team_delete') { if (my !== 'owner') throw fail(403, 'Réservé au propriétaire.'); if ((t.projects || []).length) throw fail(409, 'L’équipe contient des projets : supprimez-les ou déplacez-les d’abord.'); for (const id of Object.keys(t.members)) { const u = await getUser(id); if (u) { u.teams = (u.teams || []).filter(x => x !== t.id); await putJ(uPath(u.id), u); } } await delBuf(tPath(t.id)); await idxDel('meta/teams.json', t.id); return send(res, 200, { ok: true }); }
    if (r === 'team_rename') { t.name = String(J.name || '').trim().slice(0, 80) || t.name; await putJ(tPath(t.id), t); return send(res, 200, { ok: true }); }
    if (r === 'team_invite') {
      const email = normEmail(J.email), role = ROLES.includes(J.role) ? J.role : 'editor'; if (!okEmail(email)) throw fail(400, 'Courriel invalide.'); if (rk(role) >= rk(my) && my !== 'owner') throw fail(403, 'Vous ne pouvez pas attribuer un rôle égal ou supérieur au vôtre.');
      const e = await getJ(ePath(email));
      if (e) { const u = await getUser(e.id); if (t.members[u.id]) throw fail(409, 'Déjà membre.'); t.members[u.id] = role; if (!u.teams.includes(t.id)) u.teams.push(t.id); await putJ(uPath(u.id), u); await putJ(tPath(t.id), t); return send(res, 200, { added: true }); }
      t.invites = t.invites || {}; t.invites[email] = role; await putJ(tPath(t.id), t); await addInvite(email, t.id, role); return send(res, 200, { invited: true });
    }
    if (r === 'team_uninvite') { const email = normEmail(J.email); delete (t.invites || {})[email]; await putJ(tPath(t.id), t); const p = `inv/${sha(email)}.json`, inv = await getJ(p); if (inv) { inv.list = inv.list.filter(x => x.team !== t.id); await putJ(p, inv); } return send(res, 200, { ok: true }); }
    if (r === 'team_role' || r === 'team_remove') {
      const target = J.uid; if (!t.members[target]) throw fail(404, 'Membre introuvable.'); const tr = t.members[target];
      if (my !== 'owner' && rk(tr) >= rk(my)) throw fail(403, 'Vous ne pouvez pas modifier un membre de rang égal ou supérieur.');
      if (r === 'team_role') { const role = J.role; if (!ROLES.includes(role)) throw fail(400, 'Rôle invalide.'); if (my !== 'owner' && rk(role) >= rk(my)) throw fail(403, 'Rôle trop élevé.'); if (tr === 'owner' && Object.values(t.members).filter(x => x === 'owner').length < 2) throw fail(409, 'Il doit rester au moins un propriétaire.'); t.members[target] = role; }
      else { if (tr === 'owner' && Object.values(t.members).filter(x => x === 'owner').length < 2) throw fail(409, 'Il doit rester au moins un propriétaire.'); delete t.members[target]; const u = await getUser(target); if (u) { u.teams = (u.teams || []).filter(x => x !== t.id); await putJ(uPath(u.id), u); } }
      await putJ(tPath(t.id), t); return send(res, 200, { ok: true });
    }
    throw fail(404, 'Route inconnue.');
  }

  /* projets */
  if (r === 'proj_new') {
    const name = String(J.name || 'Projet').trim().slice(0, 120) || 'Projet'; let team = J.team || null;
    if (team) { const t = await getJ(tPath(team)); if (!t || !t.members[me.id] || rk(t.members[me.id]) < rk('editor')) throw fail(403, 'Droits insuffisants dans cette équipe.'); }
    const m = { id: rid(), name, owner: me.id, team, rev: 0, updated: Date.now(), hv: 0, by: me.name }; await putJ(pMeta(m.id), m);
    if (team) { const t = await getJ(tPath(team)); t.projects = [...(t.projects || []), m.id]; await putJ(tPath(team), t); } else { me.projects = [...(me.projects || []), m.id]; await putJ(uPath(me.id), me); }
    return send(res, 200, { project: await withRole(me, m) });
  }
  const pid = url.searchParams.get('p') || '';
  if (r.startsWith('proj_')) {
    const m = await getJ(pMeta(pid)); if (!m) throw fail(404, 'Projet introuvable.'); const role = await roleIn(me, m); if (!role) throw fail(403, 'Accès refusé.');
    const canW = rk(role) >= rk('editor');
    if (r === 'proj_meta') return send(res, 200, { project: await withRole(me, m) });
    if (r === 'proj_get') { const part = url.searchParams.get('part'); if (!['state', 'ds', 'px'].includes(part)) throw fail(400, 'Partie invalide.'); const b = await getBuf(pPart(pid, part)); if (!b) { res.statusCode = 204; res.end(); return; } res.statusCode = 200; res.setHeader('content-type', 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-rev', String(m.rev)); res.end(b); return; }
    if (!canW) throw fail(403, 'Lecture seule : droits d’édition requis.');
    if (r === 'proj_put') {
      const part = url.searchParams.get('part'); if (!['state', 'ds', 'px'].includes(part)) throw fail(400, 'Partie invalide.');
      const base = url.searchParams.get('base'); if (part === 'state' && base != null && String(m.rev) !== base) { return send(res, 409, { error: 'conflict', message: 'Le projet a été modifié par quelqu’un d’autre.', project: await withRole(me, m) }); }
      await putBuf(pPart(pid, part), raw); const nm = url.searchParams.get('name'); if (part === 'state') { m.rev++; m.updated = Date.now(); m.by = me.name; if (nm) m.name = nm.slice(0, 120); } else m.hv = Date.now();
      await putJ(pMeta(pid), m); return send(res, 200, { project: await withRole(me, m) });
    }
    if (r === 'proj_rename') { m.name = String(J.name || '').trim().slice(0, 120) || m.name; await putJ(pMeta(pid), m); return send(res, 200, { ok: true }); }
    if (r === 'proj_move') { // déplacer vers une équipe (ou null = personnel), propriétaire du projet seulement
      if (m.owner !== me.id && !(role === 'admin')) throw fail(403, 'Seul le propriétaire du projet (ou un administrateur) peut le déplacer.');
      const to = J.team || null; if (to) { const t = await getJ(tPath(to)); if (!t || !t.members[me.id] || rk(t.members[me.id]) < rk('editor')) throw fail(403, 'Droits insuffisants dans l’équipe cible.'); }
      if (m.team) { const t = await getJ(tPath(m.team)); if (t) { t.projects = (t.projects || []).filter(x => x !== pid); await putJ(tPath(t.id), t); } } else { const ow = await getUser(m.owner); if (ow) { ow.projects = (ow.projects || []).filter(x => x !== pid); await putJ(uPath(ow.id), ow); } }
      if (to) { const t = await getJ(tPath(to)); t.projects = [...(t.projects || []), pid]; await putJ(tPath(to), t); } else { const ow = await getUser(m.owner); ow.projects = [...(ow.projects || []), pid]; await putJ(uPath(ow.id), ow); }
      m.team = to; await putJ(pMeta(pid), m); return send(res, 200, { project: await withRole(me, m) });
    }
    if (r === 'proj_del') {
      if (m.owner !== me.id && rk(role) < rk('admin')) throw fail(403, 'Suppression réservée au propriétaire du projet ou à un administrateur.');
      if (m.team) { const t = await getJ(tPath(m.team)); if (t) { t.projects = (t.projects || []).filter(x => x !== pid); await putJ(tPath(t.id), t); } } else { const ow = await getUser(m.owner); if (ow) { ow.projects = (ow.projects || []).filter(x => x !== pid); await putJ(uPath(ow.id), ow); } }
      for (const k of ['state', 'ds', 'px']) await delBuf(pPart(pid, k)); await delBuf(pMeta(pid)); return send(res, 200, { ok: true });
    }
  }
  throw fail(404, 'Route inconnue.');
}

export default async function handler(req, res) {
  try { await handle(req, res); }
  catch (e) { if (res.headersSent) return; const code = Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500; send(res, code, { error: 'error', message: code === 500 ? 'Erreur du serveur.' : e.message }); if (code === 500) console.error(e); }
}
export const config = { api: { bodyParser: false } };
