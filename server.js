require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

app.get('/', (req, res) => res.json({ status: 'Silbis chatbot activo 🍔' }));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else { res.sendStatus(403); }
});

app.get('/confirmar/:reservaId', async (req, res) => {
  const { reservaId } = req.params;
  try {
    const { data: reserva } = await sb.from('reservas').select('*').eq('id', reservaId).single();
    if (!reserva) return res.status(404).send('Reserva no encontrada');
    await sb.from('reservas').update({ estado: 'confirmada' }).eq('id', reservaId);
    const msg = `✅ ¡Reserva confirmada! Te esperamos en Silbis el ${formatFechaLegible(reserva.fecha)} a las ${reserva.hora.slice(0,5)}h. ¡Hasta pronto! 🍔`;
    await enviarWhatsApp(reserva.cliente_telefono, msg);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0c0b0a;color:#f0ebe0"><h1 style="color:#bf3228">🍔 Silbis</h1><h2>¡Reserva confirmada!</h2><p>Tu mesa está reservada para el <strong>${formatFechaLegible(reserva.fecha)}</strong> a las <strong>${reserva.hora.slice(0,5)}h</strong></p><p style="color:#888">C/ Carnicerías, 2 — Tudela · 661 656 648</p></body></html>`);
  } catch (err) { res.status(500).send('Error al confirmar'); }
});
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== 'text') return;
    const telefono = message.from;
    const texto = message.text.body;
    const nombre = value?.contacts?.[0]?.profile?.name || 'Cliente';
    await procesarMensaje(telefono, nombre, texto);
  } catch (err) { console.error('Error webhook:', err.message); }
});

async function procesarMensaje(telefono, nombre, texto) {
  let { data: conv } = await sb.from('conversaciones').select('*').eq('cliente_telefono', telefono).single();
  if (!conv) {
    const { data: nueva } = await sb.from('conversaciones').insert({
      cliente_nombre: nombre, cliente_telefono: telefono,
      ultimo_mensaje: texto, sin_leer: true, estado: 'abierta'
    }).select().single();
    conv = nueva;
  } else {
    await sb.from('conversaciones').update({
      ultimo_mensaje: texto, sin_leer: true, updated_at: new Date().toISOString()
    }).eq('id', conv.id);
  }
  await sb.from('mensajes').insert({ conversacion_id: conv.id, origen: 'user', texto });
  const { data: historial } = await sb.from('mensajes').select('*').eq('conversacion_id', conv.id).order('created_at', { ascending: true }).limit(30);
  const { data: config } = await sb.from('config').select('*').eq('id', '00000000-0000-0000-0000-000000000001').single();
  const { data: horarios } = await sb.from('horarios').select('*').eq('activo', true).order('dia');
  const diasNombre = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
  const horariosTexto = horarios?.map(h => `${diasNombre[h.dia]} (${h.turno}): ${h.hora_inicio?.slice(0,5)} - ${h.hora_fin?.slice(0,5)}`).join(', ') || 'jueves a domingo en cena';
  const ahora = new Date();
  const fechaHoy = ahora.toISOString().slice(0, 10);
  const diaActual = diasNombre[ahora.getDay() === 0 ? 6 : ahora.getDay() - 1];
  const manana = new Date(ahora.getTime() + 86400000).toISOString().slice(0,10);

  const systemPrompt = `Eres ${config?.bot_nombre || 'Silbi'}, el asistente de reservas de ${config?.nombre || 'Silbis'}, hamburguesería artesana en Tudela.
FECHA HOY: ${fechaHoy} (${diaActual})
MAÑANA: ${manana}
HORARIOS: ${horariosTexto}
DIRECCIÓN: ${config?.direccion} | TEL: ${config?.telefono} | MÁX PERSONAS: ${config?.max_personas || 8}

INSTRUCCIONES:
1. FECHAS COLOQUIALES: interpreta "mañana", "el viernes", "este finde", "la semana que viene"... y conviértelas a YYYY-MM-DD.
2. PETICIONES ESPECIALES: si mencionan tronas, silla de ruedas, alergias, celebración — anótalo.
3. FLUJO: recoge personas, día, hora y nombre. Muestra resumen y pide confirmación explícita del cliente.
4. Solo cuando el cliente diga sí/confirmo/ok emite: RESERVA_LISTA|nombre|YYYY-MM-DD|HH:MM|numPersonas|notas
5. Sé breve y amable 😊. Responde siempre en español.`;

  const messages = (historial || []).map(m => ({ role: m.origen === 'bot' ? 'assistant' : 'user', content: m.texto }));
  const response = await claude.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 600, system: systemPrompt, messages });
  const respuesta = response.content[0].text;
  await sb.from('mensajes').insert({ conversacion_id: conv.id, origen: 'bot', texto: respuesta });
  if (respuesta.includes('RESERVA_LISTA|')) await crearReservaPend
  async function crearReservaPendiente(texto, nombre, telefono) {
  try {
    const match = texto.match(/RESERVA_LISTA\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|?(.*)?/);
    if (!match) return;
    const [, clienteNombre, fecha, hora, personas, notas] = match;
    const numPersonas = parseInt(personas);
    const { data: mesas } = await sb.from('mesas').select('*').eq('estado', 'libre').gte('capacidad', numPersonas).order('capacidad').limit(1);
    const { data: reserva, error } = await sb.from('reservas').insert({
      cliente_nombre: clienteNombre.trim(),
      cliente_telefono: telefono,
      fecha: fecha.trim(),
      hora: hora.trim(),
      num_personas: numPersonas,
      mesa_numero: mesas?.[0]?.numero || null,
      estado: 'pendiente',
      canal: 'whatsapp',
      notas: notas?.trim() || null
    }).select().single();
    if (error) { console.error('Error reserva:', error.message); return; }
    if (mesas?.[0]) await sb.from('mesas').update({ estado: 'reservada' }).eq('id', mesas[0].id);
    console.log(`📋 Reserva pendiente: ${clienteNombre} — ${fecha} ${hora}`);
    await programarConfirmacion(reserva, telefono);
  } catch (err) { console.error('Error crearReserva:', err.message); }
}

async function programarConfirmacion(reserva, telefono) {
  const baseUrl = process.env.BASE_URL || 'https://earnest-illumination-production-dd04.up.railway.app';
  const link = `${baseUrl}/confirmar/${reserva.id}`;
  const fechaLegible = formatFechaLegible(reserva.fecha);
  const hoy = new Date().toISOString().slice(0, 10);
  if (reserva.fecha === hoy) {
    await enviarMensajeConfirmacion(telefono, reserva, link, fechaLegible);
  } else {
    await sb.from('confirmaciones_pendientes').insert({
      reserva_id: reserva.id, telefono,
      fecha_envio: reserva.fecha, link, enviado: false
    });
    console.log(`📅 Confirmación programada para ${reserva.fecha}`);
  }
}

async function enviarMensajeConfirmacion(telefono, reserva, link, fechaLegible) {
  const msg = `¡Hola ${reserva.cliente_nombre}! 👋\n\nTe recordamos tu reserva en *Silbis* para *hoy ${fechaLegible}* a las *${reserva.hora.slice(0,5)}h* (${reserva.num_personas} personas).\n\n👇 Confirma tu asistencia:\n${link}\n\n_Si no puedes venir escríbenos o llámanos al 661 656 648._`;
  await enviarWhatsApp(telefono, msg);
}

async function procesarConfirmacionesDia() {
  const hoy = new Date().toISOString().slice(0, 10);
  const { data: pendientes } = await sb.from('confirmaciones_pendientes').select('*, reservas(*)').eq('fecha_envio', hoy).eq('enviado', false);
  if (!pendientes?.length) return;
  for (const p of pendientes) {
    if (!p.reservas) continue;
    await enviarMensajeConfirmacion(p.telefono, p.reservas, p.link, formatFechaLegible(p.reservas.fecha));
    await sb.from('confirmaciones_pendientes').update({ enviado: true }).eq('id', p.id);
  }
}

setInterval(procesarConfirmacionesDia, 60 * 60 * 1000);
async function enviarWhatsApp(telefono, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: mensaje } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`📤 Enviado a ${telefono}`);
  } catch (err) {
    console.error('Error WhatsApp:', err.response?.data || err.message);
  }
}

function formatFechaLegible(fecha) {
  if (!fecha) return '';
  const d = new Date(fecha + 'T12:00:00');
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Silbis chatbot en puerto ${PORT}`));
