'use strict';
/**
 * Email sending without dependencies: a MIME builder (HTML + text + file
 * attachments) and a small SMTP client (implicit TLS on 465, STARTTLS on 587,
 * AUTH PLAIN/LOGIN). Works with Gmail, Google Workspace, Zoho, Hostinger,
 * cPanel mailboxes, Brevo, SendGrid, Mailgun, Resend (SMTP), etc.
 *
 * If SMTP_HOST is not set, emails are written to data/outbox/ instead so you
 * can open them while testing.
 */
const net = require('net');
const tls = require('tls');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const CRLF = '\r\n';

// ---- MIME ----------------------------------------------------------------------
function isAscii(s) {
  return /^[\x20-\x7e]*$/.test(s);
}

function encodeWord(str) {
  str = String(str || '').replace(/[\r\n]+/g, ' ');
  if (isAscii(str)) return str;
  const words = [];
  let cur = '';
  for (const ch of str) {
    if (Buffer.byteLength(cur + ch) > 45) {
      words.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(CRLF + ' ');
}

function parseAddress(input) {
  const s = String(input || '').replace(/[\r\n]+/g, ' ').trim();
  const m = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (m) return { name: m[1].trim().replace(/^"(.*)"$/, '$1').trim(), address: m[2].trim() };
  return { name: '', address: s };
}

function formatAddress({ name, address }) {
  if (!name) return address;
  if (isAscii(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  return `${encodeWord(name)} <${address}>`;
}

function rfc2822Date(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes()
  )}:${p(d.getUTCSeconds())} +0000`;
}

function b64lines(buf) {
  const s = Buffer.from(buf).toString('base64');
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join(CRLF);
}

function boundary(tag) {
  return `----=_${tag}_${crypto.randomBytes(12).toString('hex')}`;
}

function attachmentName(name) {
  return String(name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
}

/**
 * Build a complete RFC 5322 message.
 * attachments: [{ filename, content: Buffer, contentType }]
 */
function buildMessage({ from, to, bcc = [], replyTo, subject, text, html, attachments = [], headers = {} }) {
  const fromA = parseAddress(from);
  const toList = [].concat(to || []).filter(Boolean).map(parseAddress);
  const bccList = [].concat(bcc || []).filter(Boolean).map(parseAddress);
  const domain = (fromA.address.split('@')[1] || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  const messageId = `<${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}@${domain}>`;

  const head = [
    `From: ${formatAddress(fromA)}`,
    `To: ${toList.map(formatAddress).join(', ')}`,
    ...(replyTo ? [`Reply-To: ${formatAddress(parseAddress(replyTo))}`] : []),
    `Subject: ${encodeWord(subject)}`,
    `Date: ${rfc2822Date()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`),
  ];

  const alt = boundary('alt');
  const altHeader = `Content-Type: multipart/alternative; boundary="${alt}"`;
  const altBody = [
    `--${alt}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(Buffer.from(text || '', 'utf8')),
    `--${alt}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(Buffer.from(html || '', 'utf8')),
    `--${alt}--`,
  ].join(CRLF);

  let message;
  if (!attachments.length) {
    message = [...head, altHeader, '', altBody, ''].join(CRLF);
  } else {
    const mix = boundary('mix');
    const parts = [`--${mix}`, altHeader, '', altBody];
    for (const a of attachments) {
      const fn = attachmentName(a.filename);
      parts.push(
        `--${mix}`,
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${fn}"`,
        `Content-Disposition: attachment; filename="${fn}"`,
        'Content-Transfer-Encoding: base64',
        '',
        b64lines(a.content)
      );
    }
    parts.push(`--${mix}--`);
    message = [...head, `Content-Type: multipart/mixed; boundary="${mix}"`, '', 'This is a multi-part message in MIME format.', ...parts, ''].join(
      CRLF
    );
  }

  return {
    messageId,
    message,
    envelope: { from: fromA.address, to: [...toList, ...bccList].map((a) => a.address) },
  };
}

// ---- SMTP client -------------------------------------------------------------------
class SmtpError extends Error {
  constructor(message, code, response) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.response = response;
  }
}

class SmtpConnection {
  constructor(opts) {
    this.opts = opts;
    this.socket = null;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.lines = [];
    this.pending = [];
    this.waiters = [];
    this.error = null;
    this.closed = false;
  }

  connect() {
    const { host, port, secure, rejectUnauthorized } = this.opts;
    return new Promise((resolve, reject) => {
      const servername = net.isIP(host) ? undefined : host;
      const sock = secure ? tls.connect({ host, port, servername, rejectUnauthorized }) : net.connect({ host, port });
      const evt = secure ? 'secureConnect' : 'connect';
      const onOk = () => {
        sock.removeListener('error', onErr);
        resolve();
      };
      const onErr = (e) => {
        sock.removeListener(evt, onOk);
        reject(new SmtpError(`Cannot connect to ${host}:${port} (${e.message})`, e.code));
      };
      sock.once(evt, onOk);
      sock.once('error', onErr);
      this._attach(sock);
    });
  }

  _attach(sock) {
    this.socket = sock;
    this._onData = (d) => this._data(d);
    this._onError = (e) => this._fail(e);
    this._onClose = () => {
      this.closed = true;
      this._fail(new SmtpError('SMTP server closed the connection', 'ECONNCLOSED'));
    };
    this._onTimeout = () => sock.destroy(new SmtpError('SMTP server did not respond in time', 'ETIMEDOUT'));
    sock.on('data', this._onData);
    sock.on('error', this._onError);
    sock.on('close', this._onClose);
    sock.setTimeout(this.opts.timeoutMs || 30000, this._onTimeout);
  }

  _detach() {
    const s = this.socket;
    s.removeListener('data', this._onData);
    s.removeListener('error', this._onError);
    s.removeListener('close', this._onClose);
    s.setTimeout(0);
    s.removeListener('timeout', this._onTimeout);
  }

  _data(chunk) {
    this.buffer += this.decoder.write(chunk);
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) continue;
      this.lines.push(m[3]);
      if (m[2] !== '-') {
        const resp = { code: Number(m[1]), lines: this.lines, text: `${m[1]} ${this.lines.join(' | ')}` };
        this.lines = [];
        const w = this.waiters.shift();
        if (w) w.resolve(resp);
        else this.pending.push(resp);
      }
    }
  }

  _fail(err) {
    if (!this.error) this.error = err;
    for (const w of this.waiters.splice(0)) w.reject(this.error);
  }

  read() {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async cmd(line, expect, label) {
    this.socket.write(line + CRLF);
    const resp = await this.read();
    if (expect && ![].concat(expect).includes(resp.code)) {
      throw new SmtpError(`SMTP ${label || line.split(' ')[0]} failed: ${resp.text}`, resp.code, resp);
    }
    return resp;
  }

  async upgradeTls() {
    const { host, rejectUnauthorized } = this.opts;
    this._detach();
    const plain = this.socket;
    plain.on('error', () => {}); // errors surface on the TLS socket from now on
    await new Promise((resolve, reject) => {
      const secure = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, rejectUnauthorized });
      secure.once('secureConnect', () => {
        secure.removeListener('error', onErr);
        resolve();
      });
      const onErr = (e) => reject(new SmtpError(`STARTTLS failed (${e.message})`, e.code));
      secure.once('error', onErr);
      this.decoder = new StringDecoder('utf8');
      this.buffer = '';
      this._attach(secure);
    });
  }

  async ehlo(name) {
    let r = await this.cmd(`EHLO ${name}`);
    if (r.code !== 250) {
      await this.cmd(`HELO ${name}`, 250);
      return new Map();
    }
    const caps = new Map();
    for (const l of r.lines.slice(1)) {
      const [k, ...rest] = l.trim().split(/[\s=]+/);
      if (k) caps.set(k.toUpperCase(), rest.join(' ').toUpperCase());
    }
    return caps;
  }

  async auth(caps, user, pass) {
    const mechs = (caps.get('AUTH') || '').split(/\s+/).filter(Boolean);
    const usePlain = mechs.includes('PLAIN') || !mechs.includes('LOGIN');
    if (usePlain) {
      const tokenStr = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
      const r = await this.cmd(`AUTH PLAIN ${tokenStr}`, null, 'AUTH');
      if (r.code !== 235) throw new SmtpError(`SMTP login failed: ${r.text}`, r.code, r);
      return;
    }
    let r = await this.cmd('AUTH LOGIN', 334, 'AUTH');
    r = await this.cmd(Buffer.from(user, 'utf8').toString('base64'), 334, 'AUTH');
    r = await this.cmd(Buffer.from(pass, 'utf8').toString('base64'), null, 'AUTH');
    if (r.code !== 235) throw new SmtpError(`SMTP login failed: ${r.text}`, r.code, r);
  }

  close() {
    try {
      this.socket && this.socket.end();
    } catch {}
    setTimeout(() => {
      try {
        this.socket && this.socket.destroy();
      } catch {}
    }, 1000).unref();
  }
}

function dotStuff(message) {
  return message
    .replace(/\r?\n/g, CRLF)
    .replace(/(\r\n)+$/, '')
    .replace(/^\./gm, '..');
}

async function smtpSend(opts, envelope, message) {
  const c = new SmtpConnection(opts);
  await c.connect();
  try {
    const greet = await c.read();
    if (greet.code !== 220) throw new SmtpError(`SMTP server refused the connection: ${greet.text}`, greet.code, greet);
    const name = opts.name || os.hostname() || 'localhost';
    let caps = await c.ehlo(name);
    if (!opts.secure) {
      if (caps.has('STARTTLS')) {
        await c.cmd('STARTTLS', 220);
        await c.upgradeTls();
        caps = await c.ehlo(name);
      } else if (opts.user && !opts.allowInsecureAuth) {
        throw new SmtpError('The SMTP server does not offer encryption (STARTTLS). Use port 465 with SMTP_SECURE=true.', 'ENOTLS');
      }
    }
    if (opts.user) await c.auth(caps, opts.user, opts.pass || '');
    await c.cmd(`MAIL FROM:<${envelope.from}>`, 250, 'MAIL FROM');
    for (const rcpt of envelope.to) await c.cmd(`RCPT TO:<${rcpt}>`, [250, 251], 'RCPT TO');
    await c.cmd('DATA', 354);
    c.socket.write(dotStuff(message) + CRLF + '.' + CRLF);
    const done = await c.read();
    if (done.code !== 250) throw new SmtpError(`SMTP server rejected the message: ${done.text}`, done.code, done);
    await c.cmd('QUIT').catch(() => {});
    return { response: done.text };
  } finally {
    c.close();
  }
}

/**
 * Open a connection, say hello (STARTTLS + login when configured) and hang up.
 * Used by the dashboard's "Test connection" button to check the settings
 * without sending a message. Returns a small report.
 */
async function smtpVerify(opts) {
  if (!opts || !opts.host) throw new SmtpError('No mail server address was given.', 'ENOHOST');
  const c = new SmtpConnection(opts);
  await c.connect();
  try {
    const greet = await c.read();
    if (greet.code !== 220) throw new SmtpError(`SMTP server refused the connection: ${greet.text}`, greet.code, greet);
    const name = opts.name || os.hostname() || 'localhost';
    let caps = await c.ehlo(name);
    if (!opts.secure) {
      if (caps.has('STARTTLS')) {
        await c.cmd('STARTTLS', 220);
        await c.upgradeTls();
        caps = await c.ehlo(name);
      } else if (opts.user && !opts.allowInsecureAuth) {
        throw new SmtpError('The SMTP server does not offer encryption (STARTTLS). Use port 465 with SSL instead.', 'ENOTLS');
      }
    }
    if (opts.user) await c.auth(caps, opts.user, opts.pass || '');
    await c.cmd('QUIT').catch(() => {});
    return {
      host: opts.host,
      port: opts.port,
      secure: !!opts.secure,
      auth: !!opts.user,
      capabilities: [...caps.keys()],
      response: greet.text,
    };
  } finally {
    c.close();
  }
}

// ---- Mailer ----------------------------------------------------------------------
class Mailer {
  constructor({ smtp, from, replyTo, outboxDir }) {
    this.smtp = smtp;
    this.from = from;
    this.replyTo = replyTo;
    this.outboxDir = outboxDir;
  }

  get configured() {
    return !!this.smtp.host;
  }

  /** Check the SMTP connection without sending a message. */
  verify() {
    return smtpVerify(this.smtp);
  }

  /**
   * attachments: [{ filename, path } | { filename, content }]
   * Returns { messageId, response } or { messageId, outbox: file }.
   */
  async send({ to, bcc, replyTo, subject, html, text, attachments = [] }) {
    const files = [];
    for (const a of attachments) {
      const content = a.content || (await fsp.readFile(a.path));
      files.push({ filename: a.filename, content, contentType: a.contentType });
    }
    const built = buildMessage({ from: this.from, to, bcc, replyTo: replyTo || this.replyTo, subject, html, text, attachments: files });
    if (!this.configured) {
      await fsp.mkdir(this.outboxDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const who = parseAddress([].concat(to)[0] || 'unknown').address.replace(/[^A-Za-z0-9@._-]/g, '_');
      const base = path.join(this.outboxDir, `${stamp}-${who}`);
      await fsp.writeFile(base + '.eml', built.message);
      await fsp.writeFile(base + '.html', html || '');
      return { messageId: built.messageId, outbox: base + '.eml' };
    }
    const info = await smtpSend(this.smtp, built.envelope, built.message);
    return { messageId: built.messageId, response: info.response };
  }
}

module.exports = { Mailer, SmtpError, buildMessage, smtpSend, smtpVerify, encodeWord, parseAddress, formatAddress };
