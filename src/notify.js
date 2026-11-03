// Customer notifications. Each channel is optional and switched on by settings in the environment:
//   Email:   RESEND_API_KEY + EMAIL_FROM (works everywhere, incl. Cloudflare)
//            or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM (Node.js self-hosting only)
//   SMS:     TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
//   Webhook: NOTIFY_WEBHOOK_URL  (receives JSON; plug into Zapier/Make/n8n or any SMS provider)
let smtpSend = null; // set by server.js when SMTP is configured (Node only)
function setSmtp(fn) { smtpSend = fn; }

// Work that should finish after the response is sent. On Cloudflare this is ctx.waitUntil (set by worker.mjs).
let keepAlive = (p) => p;
function setBackground(fn) { keepAlive = fn; }
function background(promise) { keepAlive(Promise.resolve(promise).catch((e) => console.error('background task failed:', e.message))); }

// Outbound webhook (plugins/integrations). Signed with an HMAC header when WEBHOOK_SECRET is set.
async function postWebhook(url, payload) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'OpenRepairPOS-Webhook' };
  if (process.env.WEBHOOK_SECRET) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(process.env.WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    headers['X-OpenRepairPOS-Signature'] = 'sha256=' + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`webhook ${url} answered ${r.status}`);
}
function webhook(url, payload) {
  if (!/^https?:\/\//i.test(url)) return;
  background(postWebhook(url, payload));
}

async function sendEmail(to, subject, text) {
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, text }),
    });
    if (!r.ok) throw new Error(`Email failed (${r.status})`);
    return true;
  }
  if (smtpSend) { await smtpSend({ to, subject, text }); return true; }
  return false;
}

function message(ticket, s) {
  const device = [ticket.brand, ticket.model].filter(Boolean).join(' ') || 'device';
  const link = s.public_url ? `${s.public_url.replace(/\/$/, '')}/track/${ticket.tracking_code}` : '';
  const lines = {
    'Waiting for approval': `We've diagnosed your ${device} and need your approval to continue.`,
    'Waiting for parts': `We're waiting on parts for your ${device}. We'll update you as soon as they arrive.`,
    'Ready for pickup': `Good news — your ${device} is ready for pickup!`,
  };
  const body = `${s.store_name}: ${lines[ticket.status] || `Your ${device} repair status is now "${ticket.status}".`} Ticket ${ticket.number}.${link ? ` Track: ${link}` : ''}${s.store_phone ? ` Questions? ${s.store_phone}` : ''}`;
  return { subject: `${s.store_name} – ${ticket.number}: ${ticket.status}`, body };
}

async function ticketStatus(ticket, s) {
  const sent = [];
  const { subject, body } = message(ticket, s);
  if (ticket.customer_email && (await sendEmail(ticket.customer_email, subject, body))) sent.push('email');
  if (process.env.TWILIO_SID && ticket.customer_phone) {
    const auth = btoa(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: ticket.customer_phone, Body: body }),
    });
    if (!r.ok) throw new Error(`SMS failed (${r.status})`);
    sent.push('sms');
  }
  if (process.env.NOTIFY_WEBHOOK_URL) {
    await fetch(process.env.NOTIFY_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'ticket.status', ticket: { number: ticket.number, status: ticket.status, tracking_code: ticket.tracking_code }, customer: { name: ticket.customer_name, phone: ticket.customer_phone, email: ticket.customer_email }, subject, message: body }),
    });
    sent.push('webhook');
  }
  return sent;
}

module.exports = { ticketStatus, message, setSmtp, setBackground, background, webhook };
