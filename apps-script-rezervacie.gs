/**
 * TESSHOW 2026 — spracovanie rezervácie ubytovania
 * Google Apps Script (backend za formulárom na webe)
 *
 * Čo robí:
 *  1) odfiltruje spam (honeypot, časová pečiatka, podpis, validácia hodnôt)
 *  2) zapíše rezerváciu do napojeného Google Sheetu
 *  3) pošle notifikačný e-mail Ivke Fabulovej
 *  4) pošle potvrdzovací e-mail hosťovi — LEN ak rezervácia prešla validáciou
 *
 * DÔLEŽITÉ: endpoint je verejný a jeho URL je v zdrojáku stránky —
 * boti si ju vyscrapovali a volali priamo. Preto sa každé odoslanie
 * musí preukázať čerstvým podpisom a prejsť validáciou (viď spamReason).
 */

// ─── NASTAVENIA ──────────────────────────────────────────────
var NOTIFY_EMAIL = 'fabulova@tes-slovakia.sk';   // komu chodia nové rezervácie
var FROM_NAME    = 'TESSHOW 2026';                // meno odosielateľa (zobrazí sa príjemcovi)
var FROM_EMAIL   = '';                            // adresa odosielateľa — MUSÍ byť overený alias
                                                  // ("Odosielať poštu ako") v odosielacom účte.
                                                  // Napr. 'fabulova@tes-slovakia.sk'.
                                                  // Prázdne = predvolená adresa účtu, pod ktorým skript beží.
var SITE_URL     = 'https://tesshow.sk/';         // pravá doména, nie vercel.app adresa
var PRIMARY      = '#f4625a';

// ─── ANTISPAM ────────────────────────────────────────────────
// FORM_SECRET musí byť ROVNAKÝ reťazec ako v index.html (premenná FORM_SECRET).
// Keď ho zmeníš, zmeň ho na oboch miestach naraz.
var FORM_SECRET    = 'tesshow26-a7f3c9';
var MIN_FILL_MS    = 3000;              // vyplnenie rýchlejšie ako 3 s = bot
var MAX_TOKEN_AGE  = 45 * 60 * 1000;    // podpis starší/novší ako 45 min = replay alebo rozhodené hodiny
var DATE_MIN       = '2026-09-10';      // dátumy mimo tohto okna sú nezmysel
var DATE_MAX       = '2026-09-25';
var MAIN_SHEET     = 'Rezervácie';
var SPAM_SHEET     = 'Spam';            // zachytený spam sa sem zapíše — nič sa nestratí
var DEDUPE_WINDOW  = 300;               // s — rovnaká rezervácia znova do 5 min = duplicita

// Preklad hodnôt zo <select> na čitateľné popisy.
// Zároveň slúži ako whitelist — čokoľvek iné sa zahodí.
var ROOM_LABELS = {
  'double-palace':    'Palace — Dvojlôžková izba (120 €/os/noc)',
  'single-palace':    'Palace — Jednolôžková izba (185 €/os/noc)',
  'single-aphrodite': 'Aphrodite — Jednolôžková izba (120 €/os/noc)'
};
var PREF_LABELS = {
  'separate': 'Samostatné izby',
  'shared':   'Spoločná izba'
};

// ─── VSTUPNÝ BOD ─────────────────────────────────────────────
//
// Formulár posiela parametre v tele POST-u AJ v query stringu. Dôvod:
// Apps Script na /exec odpovedá presmerovaním a pri ňom sa telo POST-u
// môže stratiť — vtedy dorazí požiadavka ako GET. Preto obe metódy
// idú cez tú istú validáciu, aby sa nestratila žiadna reálna rezervácia.
//
// Ochranu nezabezpečuje metóda, ale čerstvý podpis (sig + t), ktorý sa
// počíta až v momente odoslania. Bot replayujúci odchytenú URL ho nemá.

function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  try {
    var p = readParams(e);

    // 1) Antispam — vráti null (čisté) alebo dôvod zamietnutia
    var reason = spamReason(p);
    if (reason) {
      logSpam(p, reason);
      return json({ ok: true });   // botovi nikdy nepovieme, prečo sme ho odmietli
    }

    // 2) Duplicita (dvojklik na tlačidlo alebo opakovaný pokus)
    if (isDuplicate(p)) {
      return json({ ok: true });
    }

    var data = {
      name:     clean(p.name),
      email:    clean(p.email),
      phone:    clean(p.phone),
      room:     ROOM_LABELS[p.room] || '',
      persons:  clean(p.persons),
      pref:     PREF_LABELS[p.room_preference] || '',
      checkin:  clean(p.checkin),
      checkout: clean(p.checkout),
      note:     clean(p.note)
    };

    // 3) Zápis do Sheetu
    try {
      var sheet = getSheet(MAIN_SHEET);
      if (sheet) {
        // Poradie musí sedieť s hlavičkou tabuľky:
        // Meno | Email | Telefón | Typ izby | Počet osôb | Preferencia | Príchod | Odchod | Poznámka | Dátum odoslania
        sheet.appendRow([
          data.name, data.email, data.phone, p.room, data.persons,
          p.room_preference, data.checkin, data.checkout, data.note, new Date()
        ]);
      }
    } catch (sheetErr) {
      // zápis nie je kritický — pokračujeme aj bez tabuľky
    }

    // 4) Notifikácia Ivke
    sendNotification(data);

    // 5) Potvrdenie hosťovi — až tu, po prejdení validáciou
    sendConfirmation(data);

    return json({ ok: true });

  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// ─── ANTISPAM ────────────────────────────────────────────────

/**
 * Vráti dôvod, prečo je odoslanie spam, alebo null ak je čisté.
 * Kontroly sú zoradené od najlacnejšej po najdrahšiu.
 */
function spamReason(p) {

  // ── Honeypot ──────────────────────────────────────────────
  // Políčka, ktoré človek na stránke nevidí. Bot ich vyplní.
  if (clean(p.website) || clean(p.company)) return 'honeypot';

  // ── Podpis + časová pečiatka ──────────────────────────────
  // Bot, ktorý replayuje odchytenú URL, nemá čerstvý platný podpis.
  var t = parseInt(p.t, 10);
  if (!t || isNaN(t)) return 'chýba časová pečiatka';
  if (String(p.sig || '') !== sign(t)) return 'neplatný podpis';
  if (Math.abs(new Date().getTime() - t) > MAX_TOKEN_AGE) return 'starý podpis (replay)';

  // ── Rýchlosť vyplnenia ────────────────────────────────────
  var elapsed = parseInt(p.el, 10);
  if (isNaN(elapsed) || elapsed < MIN_FILL_MS) return 'vyplnené príliš rýchlo';

  // ── Whitelist hodnôt zo <select> ──────────────────────────
  if (!ROOM_LABELS[p.room]) return 'neplatný typ izby';
  if (p.room_preference && !PREF_LABELS[p.room_preference]) return 'neplatná preferencia';

  var persons = parseInt(p.persons, 10);
  if (isNaN(persons) || persons < 1 || persons > 8) return 'neplatný počet osôb';

  // ── Dátumy ────────────────────────────────────────────────
  // Presne toto zachytáva riadky s "1970-05-31" — bot posiela nezmysel.
  var ci = clean(p.checkin), co = clean(p.checkout);
  if (!isValidDate(ci) || !isValidDate(co)) return 'neplatný formát dátumu';
  if (ci < DATE_MIN || ci > DATE_MAX || co < DATE_MIN || co > DATE_MAX) return 'dátum mimo termínu konferencie';
  if (co <= ci) return 'odchod nie je po príchode';

  // ── E-mail ────────────────────────────────────────────────
  var email = clean(p.email).toLowerCase();
  if (email.length > 100) return 'príliš dlhý e-mail';
  if (!/^[^\s@,;<>()\[\]\\]+@[^\s@,;<>()\[\]\\]+\.[a-z]{2,}$/i.test(email)) return 'neplatný e-mail';

  // Gmail "dot-trick": ta.wu.r.oh.o.k.oyo2.7@gmail.com
  // Jedna schránka, nekonečne veľa zápisov. Reálne adresy majú 0–1 bodku.
  var local = email.split('@')[0];
  if ((local.match(/\./g) || []).length >= 3) return 'podozrivá adresa (dot-trick)';
  if (local.indexOf('+') !== -1) return 'podozrivá adresa (plus-alias)';

  // ── Meno ──────────────────────────────────────────────────
  var name = clean(p.name);
  if (name.length < 3 || name.length > 60) return 'neplatná dĺžka mena';
  if (/[0-9<>@\/\\|{}]/.test(name)) return 'meno obsahuje neplatné znaky';
  if (looksRandom(name)) return 'meno vyzerá ako náhodný reťazec';

  // ── Poznámka ──────────────────────────────────────────────
  var note = clean(p.note);
  if (note.length > 800) return 'príliš dlhá poznámka';
  if (/https?:\/\/|www\.|\[url|<a\s|\[\/url\]/i.test(note)) return 'odkaz v poznámke';

  // ── Telefón ───────────────────────────────────────────────
  var phone = clean(p.phone);
  if (phone && !/^[\d\s+()\/.-]{6,25}$/.test(phone)) return 'neplatný telefón';

  return null;
}

/**
 * Rozpozná náhodne generované mená typu "ZactguBOsxDTc", "USgBTOrkGBJx".
 * Znak: veľa prepnutí medzi veľkým a malým písmenom v jednom slove.
 * Reálne mená ("Vlastimil", "Macicakova", aj "McDonald") majú 0–2.
 */
function looksRandom(name) {
  var tokens = name.split(/\s+/);
  var hasSpace = tokens.length > 1;

  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    if (tok.length < 5) continue;

    var switches = 0;
    for (var j = 1; j < tok.length; j++) {
      var prev = tok.charAt(j - 1), cur = tok.charAt(j);
      if (isLetter(prev) && isLetter(cur) && isUpper(prev) !== isUpper(cur)) switches++;
    }
    // Jednoslovné meno je podozrivejšie — tam stačí menej prepnutí.
    if (switches >= (hasSpace ? 4 : 3)) return true;
  }
  return false;
}

function isLetter(c) { return c.toLowerCase() !== c.toUpperCase(); }
function isUpper(c)  { return isLetter(c) && c === c.toUpperCase(); }

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime());
}

/**
 * Jednoduchý podpis (djb2-xor). MUSÍ byť znak za znakom rovnaký
 * ako funkcia sign() v index.html.
 */
function sign(t) {
  var s = FORM_SECRET + '|' + t;
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Rovnaká rezervácia znova do 5 minút = dvojklik alebo opakovaný pokus. */
function isDuplicate(p) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'r_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(
        Utilities.DigestAlgorithm.MD5,
        [p.name, p.email, p.room, p.checkin, p.checkout, p.persons].join('|')
      )
    );
    if (cache.get(key)) return true;
    cache.put(key, '1', DEDUPE_WINDOW);
  } catch (err) {
    // cache nedostupná — radšej rezerváciu prepustíme
  }
  return false;
}

/** Zachytený spam ide do vlastného hárku — keby šlo o omyl, nič sa nestratí. */
function logSpam(p, reason) {
  try {
    var sheet = getSheet(SPAM_SHEET, true);
    if (!sheet) return;
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Dôvod', 'Meno', 'Email', 'Telefón', 'Typ izby', 'Počet osôb',
                       'Preferencia', 'Príchod', 'Odchod', 'Poznámka', 'Zachytené']);
    }
    sheet.appendRow([
      reason, cut(p.name), cut(p.email), cut(p.phone), cut(p.room), cut(p.persons),
      cut(p.room_preference), cut(p.checkin), cut(p.checkout), cut(p.note), new Date()
    ]);
  } catch (err) {
    // logovanie spamu nie je kritické
  }
}

// ─── NOTIFIKÁCIA PRE ORGANIZÁTORA ────────────────────────────
function sendNotification(d) {
  var subject = 'Nová rezervácia ubytovania — ' + (d.name || 'neznámy hosť');

  var rows = [
    ['Meno a priezvisko', d.name],
    ['E-mail',            d.email],
    ['Telefón',           d.phone],
    ['Typ izby',          d.room],
    ['Počet osôb',        d.persons],
    ['Preferencia izieb', d.pref],
    ['Dátum príchodu',    d.checkin],
    ['Dátum odchodu',     d.checkout],
    ['Poznámka',          d.note]
  ];

  var html =
    '<div style="font-family:Arial,sans-serif;max-width:560px">' +
      '<h2 style="color:' + PRIMARY + ';margin:0 0 12px">Nová rezervácia ubytovania</h2>' +
      '<p style="color:#555;margin:0 0 16px">TESSHOW 2026 — cez formulár na webe.</p>' +
      '<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">' +
        rows.map(function(r) {
          if (!r[1]) return '';
          return '<tr>' +
            '<td style="border:1px solid #eee;background:#fafafa;font-weight:bold;width:180px">' + r[0] + '</td>' +
            '<td style="border:1px solid #eee">' + escapeHtml(r[1]) + '</td></tr>';
        }).join('') +
      '</table>' +
    '</div>';

  sendMail({
    to: NOTIFY_EMAIL,
    subject: subject,
    htmlBody: html,
    replyTo: d.email || NOTIFY_EMAIL   // Reply pôjde priamo hosťovi
  });
}

// ─── POTVRDENIE PRE HOSŤA ────────────────────────────────────
function sendConfirmation(d) {
  var subject = 'Potvrdenie rezervácie — TESSHOW 2026';

  var rows = [
    ['Typ izby',       d.room],
    ['Počet osôb',     d.persons],
    ['Dátum príchodu', d.checkin],
    ['Dátum odchodu',  d.checkout]
  ];

  var html =
    '<div style="font-family:Arial,sans-serif;background:#0d0d0f;padding:32px;color:#fff;max-width:600px">' +
      '<h1 style="margin:0 0 8px;color:#fff">Ďakujeme, ' + escapeHtml(d.name.split(' ')[0] || '') + '!</h1>' +
      '<p style="color:#b4b4ba;margin:0 0 20px;line-height:1.6">' +
        'Prijali sme vašu žiadosť o rezerváciu ubytovania na konferenciu ' +
        '<strong style="color:#fff">TESSHOW 2026</strong>. ' +
        'Čoskoro sa vám ozveme s finálnym potvrdením.' +
      '</p>' +
      '<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 20px">' +
        rows.map(function(r) {
          if (!r[1]) return '';
          return '<tr>' +
            '<td style="border:1px solid #26262b;color:#8a8a90;width:160px">' + r[0] + '</td>' +
            '<td style="border:1px solid #26262b;color:#fff">' + escapeHtml(r[1]) + '</td></tr>';
        }).join('') +
      '</table>' +
      (d.note ? '<p style="color:#8a8a90;font-size:13px;margin:0 0 20px">Vaša poznámka: ' + escapeHtml(d.note) + '</p>' : '') +
      '<p style="margin:0 0 24px">' +
        '<a href="' + SITE_URL + '" style="display:inline-block;background:' + PRIMARY + ';color:#fff;' +
        'text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:bold">Otvoriť web TESSHOW</a>' +
      '</p>' +
      '<p style="color:#5a5a60;font-size:12px;margin:0;border-top:1px solid #1f1f23;padding-top:16px">' +
        'TESSHOW 2026 — 20. ročník · 17. september 2026, Hotel Aphrodite Palace, Rajecké Teplice<br>' +
        'V prípade otázok odpovedzte na tento e-mail alebo píšte na ' + NOTIFY_EMAIL + '.' +
      '</p>' +
    '</div>';

  sendMail({
    to: d.email,
    subject: subject,
    htmlBody: html,
    replyTo: NOTIFY_EMAIL   // Odpoveď hosťa pôjde Ivke
  });
}

// ─── TEST / SCHVÁLENIE POVOLENÍ ──────────────────────────────
// Spusti túto funkciu ručne v editore (Spustiť) — Google vypýta
// súhlas s posielaním e-mailov. Po schválení pošle testovací mail
// na účet, pod ktorým je skript, a maily začnú fungovať aj z formulára.
function testMail() {
  var me = Session.getEffectiveUser().getEmail();
  sendMail({
    to: me,
    subject: 'TESSHOW — test odosielania',
    htmlBody: 'Ak vidíš tento e-mail, posielanie mailov funguje. ✅'
  });
  Logger.log('Test odoslaný na: ' + me + (FROM_EMAIL ? ' (z adresy ' + FROM_EMAIL + ')' : ''));
}

// ─── TEST ANTISPAMU ──────────────────────────────────────────
// Spusti ručne v editore a pozri Logy (Ctrl+Enter). Overí, že reálne
// rezervácie z tabuľky prejdú a spamové riadky sa zachytia.
// Neposiela žiadne maily ani nič nezapisuje.
function testAntispam() {
  var now = new Date().getTime();
  var base = {
    t: String(now), sig: sign(now), el: '9000',
    room: 'double-palace', room_preference: 'shared', persons: '2',
    checkin: '2026-09-17', checkout: '2026-09-18',
    name: 'Vladimír Janečka', email: 'janecka@bdts.sk',
    phone: '421903207504', note: ''
  };

  var cases = [
    ['reálna — Vladimír Janečka', base, 'prejsť'],
    ['reálna — Nada Macicakova', merge(base, {
        name: 'Nada Macicakova', email: 'nada.macicakova@fibrenet.sk', persons: '4',
        room: 'single-palace', room_preference: 'separate',
        note: 'Dobry den, potrebovali by sme rezervovat 2x jednolozkova a 1x dvojlozkova' }), 'prejsť'],
    ['reálna — Peter Kotešovský', merge(base, {
        name: 'Peter Kotešovský', email: 'info@koto.help', persons: '3',
        note: 'budeme traja, tak prosim dve izby, dajte vediet ci je volne, dakujem' }), 'prejsť'],
    ['reálna — Michal Budínský',  merge(base, {
        name: 'Michal Budínský', email: 'ucetni@inkat.cz', checkin: '2026-09-16' }), 'prejsť'],

    ['SPAM — ZactguBOsxDTc', merge(base, {
        name: 'ZactguBOsxDTc', email: 'juxog.ol.a.xow.16@gmail.com', persons: '1',
        checkin: '1970-05-31', checkout: '1970-05-31', note: 'GJkNCGcRbgpqFDxz' }), 'zachytiť'],
    ['SPAM — USgBTOrkGBJx', merge(base, {
        name: 'USgBTOrkGBJx', email: 'tawu.r.oh.o.k.oyo2.7@gmail.com', persons: '1',
        checkin: '1970-05-31', checkout: '1970-05-31', note: 'WwTjFZHIfrXUHRMQyH' }), 'zachytiť'],
    ['SPAM — AYQmFALUOAx', merge(base, {
        name: 'AYQmFALUOAx', email: 'gori.cu.put.e5.5@gmail.com', persons: '1',
        checkin: '1970-05-31', checkout: '1970-05-31', note: 'rJDKXGxoyzwqXpfK' }), 'zachytiť'],

    ['bot — honeypot',           merge(base, { website: 'http://spam.example' }),        'zachytiť'],
    ['bot — replay bez podpisu', merge(base, { sig: '', t: '' }),                        'zachytiť'],
    ['bot — starý podpis',       merge(base, { t: String(now - 3600000), sig: sign(now - 3600000) }), 'zachytiť'],
    ['bot — okamžité odoslanie', merge(base, { el: '120' }),                             'zachytiť'],
    ['bot — odkaz v poznámke',   merge(base, { note: 'Kupte na https://spam.example' }), 'zachytiť'],
    ['bot — vymyslený typ izby', merge(base, { room: 'penthouse' }),                     'zachytiť']
  ];

  var failed = 0;
  for (var i = 0; i < cases.length; i++) {
    var label = cases[i][0];
    var reason = spamReason(cases[i][1]);
    var want = cases[i][2];
    var ok = (want === 'prejsť') ? (reason === null) : (reason !== null);
    if (!ok) failed++;
    Logger.log((ok ? 'OK   ' : 'CHYBA') + '  ' + label + '  ->  ' + (reason || 'prešlo'));
  }
  Logger.log(failed === 0
    ? 'Všetkých ' + cases.length + ' testov prešlo.'
    : failed + ' z ' + cases.length + ' testov ZLYHALO!');
}

function merge(a, b) {
  var out = {}, k;
  for (k in a) out[k] = a[k];
  for (k in b) out[k] = b[k];
  return out;
}

// ─── POMOCNÉ ─────────────────────────────────────────────────

function readParams(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  // Ak by prišlo JSON telo namiesto form-encoded, prečítame aj to.
  try {
    if (e && e.postData && e.postData.contents && e.postData.type === 'application/json') {
      var body = JSON.parse(e.postData.contents);
      for (var k in body) { if (!(k in p)) p[k] = body[k]; }
    }
  } catch (err) {}
  return p;
}

function getSheet(name, createIfMissing) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return null;
  var sheet = ss.getSheetByName(name);
  if (!sheet && createIfMissing) sheet = ss.insertSheet(name);
  if (!sheet && name === MAIN_SHEET) sheet = ss.getSheets()[0];
  return sheet || null;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function clean(s) { return String(s == null ? '' : s).trim(); }
function cut(s)   { return clean(s).substring(0, 300); }

// Jednotné odosielanie: doplní meno odosielateľa a (ak je nastavený)
// overený alias FROM_EMAIL ako adresu odosielateľa.
function sendMail(opts) {
  opts.name = FROM_NAME;
  if (FROM_EMAIL) opts.from = FROM_EMAIL;
  MailApp.sendEmail(opts);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
