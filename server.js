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
  } else {
    res.sendStatus(403);
  }
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
  } catch (err) {
    console.error('Error webhook:', err.message);
  }
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
  const { data: historial } = await sb.from('mensajes').select('*').eq('conversacion_id', conv.id).order('created_at', { ascending: true }).limit(20);
  const { data: config } = await sb.from('config').select('*').eq('id', '00000000-0000-0000-0000-000000000001').single();
  const { data: horarios } = await sb.from('horarios').select('*').eq('activo', true).order('dia');
  const diasNombre = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
  const horariosTexto = horarios?.map(h => `${diasNombre[h.dia]} (${h.turno}): ${h.hora_inicio?.slice(0,5)} - ${h.hora_fin?.slice(0,5)}`).join(', ') || 'jueves a domingo en cena';
  const systemPrompt = `Eres ${config?.bot_nombre || 'Silbi'}, el asistente de ${config?.nombre || 'Silbis'} en Tudela. Ayuda a hacer reservas por WhatsApp.
HORARIOS: ${horariosTexto}
DATOS: ${config?.direccion} | Tel: ${config?.telefono} | Máx personas: ${config?.max_personas}
Cuando tengas nombre, fecha, hora y personas confirma con: RESERVA_CONFIRMADA|nombre|fecha|hora|personas
Sé breve y amable.`;

  const messages = (historial || []).map(m => ({ role: m.origen === 'bot' ? 'assistant' : 'user', content: m.texto }));
  const response = await claude.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 500, system: systemPrompt, messages });
  const respuesta = response.content[0].text;
  await sb.from('mensajes').insert({ conversacion_id: conv.id, origen: 'bot', texto: respuesta });
  if (respuesta.includes('RESERVA_CONFIRMADA|')) {
    const match = respuesta.match(/RESERVA_CONFIRMADA\|([^|]+)\|([^|]+)\|([^|]+)\|([^\n|]+)/);
    if (match) {
      const [, clienteNombre, fecha, hora, personas] = match;
      const { data: mesas } = await sb.from('mesas').select('*').eq('estado', 'libre').gte('capacidad', parseInt(personas)).limit(1);
      await sb.from('reservas').insert({ cliente_nombre: clienteNombre.trim(), cliente_telefono: telefono, fecha: fecha.trim(), hora: hora.trim(), num_personas: parseInt(personas), mesa_numero: mesas?.[0]?.numero || null, estado: 'confirmada', canal: 'whatsapp' });
      if (mesas?.[0]) await sb.from('mesas').update({ estado: 'reservada' }).eq('id', mesas[0].id);
    }
  }
  const mensajeCliente = respuesta.replace(/RESERVA_CONFIRMADA\|[^\n]*/g, '').trim();
  await enviarWhatsApp(telefono, mensajeCliente || respuesta);
}

async function enviarWhatsApp(telefono, mensaje) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: mensaje } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error WhatsApp:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Silbis chatbot en puerto ${PORT}`));
