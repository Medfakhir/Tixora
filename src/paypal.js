'use strict';
/**
 * PayPal Checkout (Orders v2 REST API) — create, capture, get, verify webhook.
 * Docs: https://developer.paypal.com/docs/api/orders/v2/
 *
 * MockPayPal is a stand-in for trying the whole flow on your own computer
 * without any PayPal account (PAYPAL_MODE=mock). It is refused in production.
 */
const { fromCents, randomString } = require('./util');

class PayPalError extends Error {
  constructor(message, { status = 0, name = '', issue = '', debugId = '', details = null } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.ppName = name;
    this.issue = issue;
    this.debugId = debugId;
    this.details = details;
  }
}

/** The first capture inside an order response (or null if not captured). */
function extractCapture(order) {
  const pu = ((order && order.purchase_units) || [])[0] || {};
  const caps = (pu.payments && pu.payments.captures) || [];
  return caps[0] || null;
}

function buildOrderBody({ localId, currency, totalCents, items, description, brandName }) {
  const money = (c) => ({ currency_code: currency, value: fromCents(c) });
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: localId,
        custom_id: localId,
        invoice_id: localId,
        description: String(description).slice(0, 127),
        amount: { ...money(totalCents), breakdown: { item_total: money(totalCents) } },
        items: items.map((i) => ({
          name: String(i.name).slice(0, 127),
          sku: String(i.typeId).slice(0, 127),
          quantity: String(i.qty),
          unit_amount: money(i.unitCents),
          category: 'DIGITAL_GOODS',
        })),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: String(brandName).slice(0, 127),
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
        },
      },
    },
  };
}

class PayPalClient {
  constructor({ mode, clientId, clientSecret, apiBase, webhookId, disabledReason, timeoutMs = 25000 }) {
    this.mode = mode;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apiBase = apiBase;
    this.webhookId = webhookId;
    this.disabledReason = disabledReason || '';
    this.timeoutMs = timeoutMs;
    this._token = null;
    this._tokenExp = 0;
  }

  get enabled() {
    return !this.disabledReason;
  }

  async _fetch(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      throw new PayPalError('Could not reach PayPal (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ')', { status: 0 });
    } finally {
      clearTimeout(timer);
    }
  }

  async token(force = false) {
    if (!force && this._token && Date.now() < this._tokenExp) return this._token;
    const res = await this._fetch(this.apiBase + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new PayPalError(
        'PayPal rejected the API credentials' + (data.error_description ? `: ${data.error_description}` : ` (HTTP ${res.status})`),
        { status: res.status, name: data.error || 'AUTHENTICATION_FAILURE' }
      );
    }
    this._token = data.access_token;
    this._tokenExp = Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 300) * 1000;
    return this._token;
  }

  async api(method, apiPath, { body, rawBody, requestId, prefer } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = {
        Authorization: 'Bearer ' + (await this.token(attempt > 0)),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      if (prefer) headers.Prefer = prefer;
      const res = await this._fetch(this.apiBase + apiPath, {
        method,
        headers,
        body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) continue; // token expired early: refresh once
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text.slice(0, 500) };
      }
      if (!res.ok) {
        const issue = (data.details && data.details[0] && data.details[0].issue) || '';
        throw new PayPalError(`PayPal ${method} ${apiPath} failed: HTTP ${res.status} ${issue || data.name || ''}`.trim(), {
          status: res.status,
          name: data.name || '',
          issue,
          debugId: data.debug_id || res.headers.get('paypal-debug-id') || '',
          details: data.details || null,
        });
      }
      return data;
    }
    throw new PayPalError('PayPal authentication failed', { status: 401 });
  }

  createOrder(params) {
    return this.api('POST', '/v2/checkout/orders', {
      body: buildOrderBody(params),
      requestId: `create-${params.localId}-${params.attempt || 1}`,
      prefer: 'return=representation',
    });
  }

  captureOrder(paypalOrderId, requestId) {
    return this.api('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      requestId,
      prefer: 'return=representation',
    });
  }

  getOrder(paypalOrderId) {
    return this.api('GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
  }

  // ---- webhooks of this REST app (Notifications API v1) -------------------------------
  async listWebhooks() {
    const data = await this.api('GET', '/v1/notifications/webhooks');
    return Array.isArray(data.webhooks) ? data.webhooks : [];
  }

  createWebhook(url, eventNames) {
    return this.api('POST', '/v1/notifications/webhooks', { body: { url, event_types: eventNames.map((name) => ({ name })) } });
  }

  updateWebhook(id, { url, eventNames } = {}) {
    const ops = [];
    if (url) ops.push({ op: 'replace', path: '/url', value: url });
    if (eventNames) ops.push({ op: 'replace', path: '/event_types', value: eventNames.map((name) => ({ name })) });
    return this.api('PATCH', `/v1/notifications/webhooks/${encodeURIComponent(id)}`, { body: ops });
  }

  deleteWebhook(id) {
    return this.api('DELETE', `/v1/notifications/webhooks/${encodeURIComponent(id)}`);
  }

  /**
   * Ask PayPal to verify a webhook delivery. The original body is embedded
   * byte-for-byte (re-serialising it can break the signature check).
   */
  async verifyWebhook(headers, rawBody, webhookId = this.webhookId) {
    if (!webhookId) return false;
    const h = (k) => String(headers[k] || '');
    const head = JSON.stringify({
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: webhookId,
    });
    const body = head.slice(0, -1) + ',"webhook_event":' + rawBody + '}';
    const data = await this.api('POST', '/v1/notifications/verify-webhook-signature', { rawBody: body });
    return data.verification_status === 'SUCCESS';
  }
}

class MockPayPal {
  constructor() {
    this.mode = 'mock';
    this.clientId = '';
    this.disabledReason = '';
    this.webhookId = '';
    this.orders = new Map();
  }

  get enabled() {
    return true;
  }

  async createOrder({ localId, currency, totalCents }) {
    const id = 'MOCK' + randomString(13);
    this.orders.set(id, { id, status: 'CREATED', localId, currency, value: fromCents(totalCents), captureId: null });
    return { id, status: 'CREATED' };
  }

  _repr(o) {
    return {
      id: o.id,
      status: o.status,
      payer: { email_address: 'test-buyer@example.com', payer_id: 'MOCKPAYER', name: { given_name: 'Test', surname: 'Buyer' } },
      purchase_units: [
        {
          custom_id: o.localId,
          payments: o.captureId
            ? { captures: [{ id: o.captureId, status: 'COMPLETED', amount: { currency_code: o.currency, value: o.value }, custom_id: o.localId }] }
            : undefined,
        },
      ],
    };
  }

  async captureOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw new PayPalError('Order not found', { status: 404, name: 'RESOURCE_NOT_FOUND' });
    if (o.status === 'COMPLETED') throw new PayPalError('Order already captured', { status: 422, issue: 'ORDER_ALREADY_CAPTURED' });
    o.status = 'COMPLETED';
    o.captureId = 'MOCKCAP' + randomString(10);
    return this._repr(o);
  }

  async getOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw new PayPalError('Order not found', { status: 404, name: 'RESOURCE_NOT_FOUND' });
    return this._repr(o);
  }

  async verifyWebhook() {
    return false;
  }
}

function createPayPal(cfg) {
  if (cfg.mode === 'mock' && !cfg.disabledReason) return new MockPayPal();
  return new PayPalClient(cfg);
}

module.exports = { createPayPal, PayPalClient, MockPayPal, PayPalError, extractCapture, buildOrderBody };
