const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app = express();
app.use(express.json());
app.use(cors());

// ── CONFIG ────────────────────────────────────────────────
const TG_TOKEN  = process.env.TG_TOKEN  || '8736490478:AAHHTrcGh7rNduXgEo3Z6vhUWf4YZsEx3dM';
const TG_CHAT   = process.env.TG_CHAT   || '8226543606';
const PORT      = process.env.PORT      || 3000;
const WEBHOOK   = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com

// ── IN-MEMORY STORAGE ─────────────────────────────────────
// bookings: [{ id, checkin, checkout, name, phone, guests, jacuzzi, notes, total, status, createdAt }]
const bookings = [];
let pendingMap = {}; // tg_message_id -> booking id

// ── HELPERS ───────────────────────────────────────────────
function tgSend(payload) {
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json());
}

function tgEdit(chat_id, message_id, text) {
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, message_id, text, parse_mode: 'Markdown' })
  });
}

function fmt(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── REGISTER WEBHOOK ON START ─────────────────────────────
if (WEBHOOK) {
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${WEBHOOK}/tg-webhook` })
  }).then(r => r.json()).then(d => console.log('Webhook set:', d.description));
}

// ── ROUTES ────────────────────────────────────────────────

// POST /booking — called from the website form
app.post('/booking', async (req, res) => {
  const { checkin, checkout, guests, jacuzzi, name, phone, notes, total } = req.body;

  // Basic server-side validation
  if (!checkin || !checkout || !name || !phone) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }
  const phoneClean = phone.replace(/[\s\-\(\)]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(phoneClean)) {
    return res.status(400).json({ ok: false, error: 'Invalid phone number' });
  }
  const d1 = new Date(checkin), d2 = new Date(checkout);
  const nights = Math.round((d2 - d1) / 86400000);
  if (nights < 2) {
    return res.status(400).json({ ok: false, error: 'Minimum 2 nights' });
  }

  // Check for conflicts with confirmed bookings
  const conflict = bookings.find(b =>
    b.status === 'confirmed' &&
    new Date(b.checkin) < d2 &&
    new Date(b.checkout) > d1
  );
  if (conflict) {
    return res.status(409).json({ ok: false, error: 'Dates already booked' });
  }

  const id = uid();
  const booking = { id, checkin, checkout, guests, jacuzzi, name, phone, notes, total, status: 'pending', createdAt: new Date().toISOString() };
  bookings.push(booking);

  // Jacuzzi label
  const jacLabel = jacuzzi == 0 ? 'Без чану' : jacuzzi == 2500 ? 'Так — 2 500 грн' : 'Так + наст. день — 3 500 грн';

  const text =
`*Нова заявка — Dzendz'o*

Імʼя: ${name}
Телефон: ${phone}
Заїзд: ${fmt(checkin)}
Виїзд: ${fmt(checkout)}
Ночей: ${nights}
Гостей: ${guests}
Чан: ${jacLabel}
Примітки: ${notes || '—'}
Сума: ₴ ${Number(total).toLocaleString('uk-UA')}`;

  const tgRes = await tgSend({
    chat_id: TG_CHAT,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Підтвердити', callback_data: `confirm:${id}` },
        { text: '❌ Відхилити',  callback_data: `reject:${id}`  }
      ]]
    }
  });

  if (tgRes.ok) {
    pendingMap[tgRes.result.message_id] = id;
  }

  res.json({ ok: true });
});

// GET /bookings — called by the website calendar
app.get('/bookings', (req, res) => {
  const confirmed = bookings
    .filter(b => b.status === 'confirmed')
    .map(b => ({ checkin: b.checkin, checkout: b.checkout }));
  res.json(confirmed);
});

// POST /tg-webhook — Telegram callback buttons
app.post('/tg-webhook', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const cb = req.body.callback_query;
  if (!cb) return;

  const [action, id] = cb.data.split(':');
  const booking = bookings.find(b => b.id === id);
  if (!booking) return;

  if (action === 'confirm') {
    booking.status = 'confirmed';
    await tgEdit(cb.message.chat.id, cb.message.message_id,
      `*Заявку ПІДТВЕРДЖЕНО*\n\nІмʼя: ${booking.name}\nТелефон: ${booking.phone}\nЗаїзд: ${fmt(booking.checkin)} → Виїзд: ${fmt(booking.checkout)}\nСума: ₴ ${Number(booking.total).toLocaleString('uk-UA')}`
    );
  } else if (action === 'reject') {
    booking.status = 'rejected';
    await tgEdit(cb.message.chat.id, cb.message.message_id,
      `*Заявку ВІДХИЛЕНО*\n\nІмʼя: ${booking.name} · ${fmt(booking.checkin)} — ${fmt(booking.checkout)}`
    );
  }

  // Answer callback to remove loading spinner in Telegram
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cb.id })
  });
});

// Health check
app.get('/', (req, res) => res.send('Dzendz\'o server is running'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
