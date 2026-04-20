const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { MongoClient } = require('mongodb');
 
const app = express();
app.use(express.json());
app.use(cors());
 
// ── CONFIG ────────────────────────────────────────────────
const TG_TOKEN  = process.env.TG_TOKEN  || '8736490478:AAHHTrcGh7rNduXgEo3Z6vhUWf4YZsEx3dM';
const TG_CHAT   = process.env.TG_CHAT   || '8226543606';
const PORT      = process.env.PORT      || 3000;
const WEBHOOK   = process.env.WEBHOOK_URL;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://volodymyrpitykh_db_user:MvhcX7uLKXAf4hHl@cluster0.hfz0uta.mongodb.net/?appName=Cluster0';
 
// ── MONGODB ───────────────────────────────────────────────
let db;
const client = new MongoClient(MONGO_URI);
 
async function connectDB() {
  await client.connect();
  db = client.db('dzendzо');
  console.log('MongoDB connected');
}
 
function col() {
  return db.collection('bookings');
}
 
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
 
// ── REGISTER WEBHOOK ──────────────────────────────────────
if (WEBHOOK) {
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${WEBHOOK}/tg-webhook` })
  }).then(r => r.json()).then(d => console.log('Webhook set:', d.description));
}
 
// ── ROUTES ────────────────────────────────────────────────
 
app.post('/booking', async (req, res) => {
  const { checkin, checkout, guests, jacuzzi, name, phone, notes, total } = req.body;
 
  if (!checkin || !checkout || !name || !phone)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
 
  const phoneClean = phone.replace(/[\s\-\(\)]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(phoneClean))
    return res.status(400).json({ ok: false, error: 'Invalid phone number' });
 
  const d1 = new Date(checkin), d2 = new Date(checkout);
  const nights = Math.round((d2 - d1) / 86400000);
  if (nights < 2)
    return res.status(400).json({ ok: false, error: 'Minimum 2 nights' });
 
  const conflict = await col().findOne({
    status: 'confirmed',
    checkin:  { $lt: checkout },
    checkout: { $gt: checkin }
  });
  if (conflict)
    return res.status(409).json({ ok: false, error: 'Dates already booked' });
 
  const id = uid();
  await col().insertOne({ id, checkin, checkout, guests, jacuzzi, name, phone, notes, total, status: 'pending', createdAt: new Date().toISOString() });
 
  const jacLabel = jacuzzi == 0 ? 'Без чану' : jacuzzi == 2500 ? 'Так — 2 500 грн' : 'Так + наст. день — 3 500 грн';
 
  await tgSend({
    chat_id: TG_CHAT,
    text: `*Нова заявка — Dzendz'o*\n\nІмʼя: ${name}\nТелефон: ${phone}\nЗаїзд: ${fmt(checkin)}\nВиїзд: ${fmt(checkout)}\nНочей: ${nights}\nГостей: ${guests}\nЧан: ${jacLabel}\nПримітки: ${notes || '—'}\nСума: ₴ ${Number(total).toLocaleString('uk-UA')}`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Підтвердити', callback_data: `confirm:${id}` },
        { text: '❌ Відхилити',  callback_data: `reject:${id}`  }
      ]]
    }
  });
 
  res.json({ ok: true });
});
 
app.get('/bookings', async (req, res) => {
  const confirmed = await col()
    .find({ status: 'confirmed' }, { projection: { checkin: 1, checkout: 1, _id: 0 } })
    .toArray();
  res.json(confirmed);
});
 
app.post('/tg-webhook', async (req, res) => {
  res.sendStatus(200);
  const cb = req.body.callback_query;
  if (!cb) return;
 
  const [action, id] = cb.data.split(':');
  const booking = await col().findOne({ id });
  if (!booking) return;
 
  if (action === 'confirm') {
    await col().updateOne({ id }, { $set: { status: 'confirmed' } });
    await tgEdit(cb.message.chat.id, cb.message.message_id,
      `*Заявку ПІДТВЕРДЖЕНО*\n\nІмʼя: ${booking.name}\nТелефон: ${booking.phone}\nЗаїзд: ${fmt(booking.checkin)} → Виїзд: ${fmt(booking.checkout)}\nСума: ₴ ${Number(booking.total).toLocaleString('uk-UA')}`
    );
    await tgSend({
      chat_id: TG_CHAT,
      text: `*Бронювання активне*\n\n${booking.name} · ${fmt(booking.checkin)} — ${fmt(booking.checkout)}\n\nЯкщо потрібно скасувати — натисни кнопку нижче.`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🚫 Скасувати бронювання', callback_data: `cancel:${id}` }]] }
    });
  } else if (action === 'reject') {
    await col().updateOne({ id }, { $set: { status: 'rejected' } });
    await tgEdit(cb.message.chat.id, cb.message.message_id,
      `*Заявку ВІДХИЛЕНО*\n\nІмʼя: ${booking.name} · ${fmt(booking.checkin)} — ${fmt(booking.checkout)}`
    );
  } else if (action === 'cancel') {
    if (booking.status !== 'confirmed') return;
    await col().updateOne({ id }, { $set: { status: 'cancelled' } });
    await tgEdit(cb.message.chat.id, cb.message.message_id,
      `*Бронювання СКАСОВАНО*\n\nІмʼя: ${booking.name}\nЗаїзд: ${fmt(booking.checkin)} → Виїзд: ${fmt(booking.checkout)}\nДати звільнено на календарі.`
    );
  }
 
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cb.id })
  });
});
 
app.get('/', (req, res) => res.send("Dzendz'o server is running"));
 
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('MongoDB connection failed:', err);
  process.exit(1);
});
