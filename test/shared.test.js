'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared.js');
const S = globalThis.OctupusShared;

test('el namespace es inmutable', () => {
  assert.ok(Object.isFrozen(S));
  assert.ok(Object.isFrozen(S.DEFAULTS));
  assert.ok(Object.isFrozen(S.MSG));
});

test('errMsg acepta Error, string y cualquier cosa', () => {
  assert.equal(S.errMsg(new Error('boom')), 'boom');
  assert.equal(S.errMsg('texto'), 'texto');
  assert.equal(S.errMsg({ message: 'obj' }), 'obj');
  assert.equal(S.errMsg(42), '42');
});

test('stripTrailingSlash y portalOpportunityUrl', () => {
  assert.equal(S.stripTrailingSlash('https://www.odoo.com///'), 'https://www.odoo.com');
  assert.equal(S.stripTrailingSlash(null), '');
  assert.equal(
    S.portalOpportunityUrl('https://www.odoo.com/', 123),
    'https://www.odoo.com/my/opportunity/123'
  );
  assert.equal(S.portalOpportunityUrl(null, 7), 'https://www.odoo.com/my/opportunity/7');
});

test('leadKey separa por instancia de origen', () => {
  assert.equal(S.leadKey('https://octupus.odoo.com', 5), 'https://octupus.odoo.com#5');
});

test('escapeHtml y escapeIlike', () => {
  assert.equal(S.escapeHtml('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
  assert.equal(S.escapeIlike('100%_ok\\'), '100\\%\\_ok\\\\');
});

test('odooSlug imita el slugify de Odoo', () => {
  assert.equal(S.odooSlug('Óptica  Müller – Proyecto #3'), 'optica-muller-proyecto-3');
  assert.equal(S.odooSlug('  ---  '), '');
  assert.equal(S.odooSlug(null), '');
});

test('linkedPortalId lee el id de la nota de vinculación e ignora las notas traídas', () => {
  const linkNote =
    '🐙 <b>Octupus Lead Sync</b>: enviado. <a href="https://www.odoo.com/my/opportunity/4242">ver</a>';
  const pulledNote =
    '📥 Ana en odoo.com vía Octupus Lead Sync [odoo#99]: mira https://www.odoo.com/my/opportunity/4242';
  assert.equal(S.linkedPortalId(linkNote), 4242);
  assert.equal(S.linkedPortalId(pulledNote), null);
  assert.equal(S.linkedPortalId('sin enlace'), null);
  assert.equal(S.linkedPortalId(undefined), null);
  assert.equal(S.isPulledNote(pulledNote), true);
  assert.equal(S.isPulledNote(linkNote), false);
});

test('collectIds extrae todos los marcadores de un texto', () => {
  assert.deepEqual(S.collectIds('x [src#1] y [src#22] [odoo#3]', S.RE_SRC_MARKER), [1, 22]);
  assert.deepEqual(S.collectIds('[odoo#3] [odoo#4]', S.RE_PULLED_MARKER), [3, 4]);
  assert.deepEqual(S.collectIds('', S.RE_SRC_MARKER), []);
  // La regex global compartida no debe quedar "gastada" entre llamadas
  assert.deepEqual(S.collectIds('[src#5]', S.RE_SRC_MARKER), [5]);
});

test('extractOpportunities saca {slug, id} únicos y en orden del listado HTML', () => {
  const html = `
    <a href="/my/opportunity/acme-web-12?x=1">Acme</a>
    <a href="/my/opportunity/acme-web-12">Acme otra vez</a>
    <a href="/my/opportunity/beta%20corp-7#chat">Beta</a>
    <a href="/my/opportunity/99">sin slug</a>
  `;
  assert.deepEqual(S.extractOpportunities(html), [
    { slug: 'acme-web', id: 12 },
    { slug: 'beta corp', id: 7 },
  ]);
  assert.deepEqual(S.extractOpportunities(''), []);
});

test('parseRemoteMessages: formato mail.Store (Odoo 18/19)', () => {
  const payload = {
    'mail.message': [
      {
        id: 1,
        body: ['markup', '<p>Hola</p>'],
        message_type: 'comment',
        author: { id: 10 },
        date: '2026-01-01',
      },
      { id: 2, body: '<p>Correo</p>', message_type: 'email', author_id: 11, datetime: '2026-01-02' },
      { id: 3, body: '<p>Notificación</p>', message_type: 'notification' },
      { id: 4, body: '', message_type: 'comment' },
    ],
    'res.partner': [
      { id: 10, name: 'Ana' },
      { id: 11, display_name: 'Beto' },
    ],
  };
  assert.deepEqual(S.parseRemoteMessages(payload), [
    { id: 1, body: '<p>Hola</p>', author: 'Ana', date: '2026-01-01' },
    { id: 2, body: '<p>Correo</p>', author: 'Beto', date: '2026-01-02' },
  ]);
});

test('parseRemoteMessages: formato clásico {messages}', () => {
  const payload = {
    messages: [
      { id: 5, body: '<p>x</p>', author_id: [3, 'Carla'], date: 'd' },
      { id: 6, body: '<p>y</p>', author_id: { id: 4, name: 'Dani' } },
      { id: 7, body: '<p>z</p>' },
    ],
  };
  assert.deepEqual(S.parseRemoteMessages(payload), [
    { id: 5, body: '<p>x</p>', author: 'Carla', date: 'd' },
    { id: 6, body: '<p>y</p>', author: 'Dani', date: '' },
    { id: 7, body: '<p>z</p>', author: 'Odoo', date: '' },
  ]);
  assert.deepEqual(S.parseRemoteMessages(null), []);
  assert.deepEqual(S.parseRemoteMessages({}), []);
});
