require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'Silbis chatbot activo 🍔', time: new Date().toISOString() }));

// ── ACORTAR URL ──
async function acortarUrl(url) {
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    return res.data || url;
  } catch(e) {
    return url;
  }
}

// ── WEBHOOK VERIFICACIÓN ──
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── CONFIRMACIÓN DE RESERVA (link) ──
app.get('/confirmar/:reservaId', async (req, res) => {
  const { reservaId } = req.params;
  try {
    const { data: reserva } = await sb.from('reservas').select('*').eq('id', reservaId).single();
    if (!reserva) return res.status(404).send('Reserva no encontrada');

    await sb.from('reservas').update({ estado: 'confirmada' }).eq('id', reservaId);

    // Notificar al cliente por WhatsApp
    const msg = `✅ ¡Reserva confirmada! Te esperamos en Silbis el ${formatFechaLegible(reserva.fecha)} a las ${reserva.hora.slice(0,5)}h. ¡Hasta pronto! 🍔`;
    await enviarWhatsApp(reserva.cliente_telefono, msg);

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0c0b0a;color:#f0ebe0">
        <h1 style="color:#bf3228">🍔 Silbis</h1>
        <h2>¡Reserva confirmada!</h2>
        <p>Tu mesa está reservada para el <strong>${formatFechaLegible(reserva.fecha)}</strong> a las <strong>${reserva.hora.slice(0,5)}h</strong></p>
        <p style="color:#888">C/ Carnicerías, 2 — Tudela · 661 656 648</p>
      </body></html>`);
  } catch (err) {
    console.error('Error confirmando:', err.message);
    res.status(500).send('Error al confirmar la reserva');
  }
});


// ── CANCELAR RESERVA (link) ──
app.get('/cancelar/:reservaId', async (req, res) => {
  const { reservaId } = req.params;
  try {
    const { data: reserva } = await sb.from('reservas').select('*').eq('id', reservaId).single();
    if (!reserva) return res.status(404).send('Reserva no encontrada');
    if (reserva.estado === 'cancelada') {
      return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0c0b0a;color:#f0ebe0"><h1 style="color:#bf3228">🍔 Silbis</h1><h2>Esta reserva ya estaba cancelada</h2><p style="color:#888">Si necesitas ayuda llámanos al 661 656 648</p></body></html>`);
    }
    await sb.from('reservas').update({ estado: 'cancelada' }).eq('id', reservaId);
    // Liberar mesa si tenía asignada
    if (reserva.mesa_numero) {
      await sb.from('mesas').update({ estado: 'libre' }).eq('numero', reserva.mesa_numero);
    }
    const msg = `❌ Tu reserva en Silbis del ${formatFechaLegible(reserva.fecha)} a las ${reserva.hora.slice(0,5)}h ha sido cancelada. Si fue un error escríbenos o llámanos al 661 656 648. ¡Hasta pronto!`;
    await enviarWhatsApp(reserva.cliente_telefono, msg);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0c0b0a;color:#f0ebe0"><h1 style="color:#bf3228">🍔 Silbis</h1><h2>Reserva cancelada</h2><p>Tu reserva del <strong>${formatFechaLegible(reserva.fecha)}</strong> a las <strong>${reserva.hora.slice(0,5)}h</strong> ha sido cancelada.</p><p style="color:#888;margin-top:16px">Si fue un error llámanos al 661 656 648</p></body></html>`);
  } catch (err) {
    res.status(500).send('Error al cancelar');
  }
});

// ── REENVIAR CONFIRMACIÓN DESDE PANEL ──
app.get('/reenviar-confirmacion/:reservaId', async (req, res) => {
  const { reservaId } = req.params;
  try {
    const { data: reserva } = await sb.from('reservas').select('*').eq('id', reservaId).single();
    if (!reserva) return res.status(404).json({ error: 'No encontrada' });
    const baseUrl = process.env.BASE_URL || 'https://earnest-illumination-production-dd04.up.railway.app';
    const link = `${baseUrl}/confirmar/${reservaId}`;
    const fechaLegible = formatFechaLegible(reserva.fecha);
    await enviarMensajeConfirmacion(reserva.cliente_telefono, reserva, link, fechaLegible);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WEBHOOK MENSAJES ──
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
    console.log(`📩 ${nombre} (${telefono}): ${texto}`);
    await procesarMensaje(telefono, nombre, texto);
  } catch (err) {
    console.error('Error webhook:', err.message);
  }
});

// ── PROCESAR MENSAJE ──
async function procesarMensaje(telefono, nombre, texto) {
  // Buscar o crear conversación
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

  // Guardar mensaje usuario
  await sb.from('mensajes').insert({ conversacion_id: conv.id, origen: 'user', texto });

  // Historial conversación
  const { data: historial } = await sb.from('mensajes').select('*')
    .eq('conversacion_id', conv.id).order('created_at', { ascending: true }).limit(30);

  // Config restaurante
  const { data: config } = await sb.from('config').select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001').single();

  // Horarios
  const { data: horarios } = await sb.from('horarios').select('*').eq('activo', true).order('dia');
  const diasNombre = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
  const horariosTexto = horarios?.map(h =>
    `${diasNombre[h.dia]} (${h.turno}): ${h.hora_inicio?.slice(0,5)} - ${h.hora_fin?.slice(0,5)}`
  ).join(', ') || 'jueves a domingo en cena, sábados también en comida';

  // Fecha actual para referencia
  const ahora = new Date();
  const fechaHoy = ahora.toISOString().slice(0, 10);
  const diaActual = diasNombre[ahora.getDay() === 0 ? 6 : ahora.getDay() - 1];

  const systemPrompt = `Eres ${config?.bot_nombre || 'Silbi'}, el asistente de reservas de ${config?.nombre || 'Silbis'}, una hamburguesería artesana en Tudela (Navarra).

FECHA Y DÍA ACTUAL: ${fechaHoy} (${diaActual})
HORARIOS DE APERTURA: ${horariosTexto}
DIRECCIÓN: ${config?.direccion || 'C/ Carnicerías, 2 — Tudela'}
TELÉFONO: ${config?.telefono || '661 656 648'}
MÁXIMO PERSONAS POR RESERVA: ${config?.max_personas || 8}

INSTRUCCIONES IMPORTANTES:

1. FECHAS: Los clientes hablan de forma coloquial. Interpreta correctamente:
   - "mañana" = ${new Date(ahora.getTime() + 86400000).toISOString().slice(0,10)}
   - "este viernes", "el viernes" = calcula la fecha del próximo viernes desde hoy
   - "el sábado que viene" = calcula el sábado próximo
   - "hoy" = ${fechaHoy}
   Siempre convierte a formato YYYY-MM-DD internamente.

2. PETICIONES ESPECIALES: Si el cliente menciona:
   - Tronas para bebés → anótalo en notas
   - Silla de ruedas, movilidad reducida → anótalo, confirma que el local es accesible
   - Alergias o intolerancias → anótalo en notas
   - Mesa especial, celebración, cumpleaños → anótalo en notas

3. FLUJO DE RESERVA:
   - Recoge: número de personas, día, hora, nombre
   - Verifica que el día y hora estén dentro del horario de apertura
   - Si hay peticiones especiales, recógelas
   - Cuando tengas todo, muestra un resumen y pide confirmación al cliente
   - Solo cuando el cliente confirme explícitamente, emite la reserva

4. FORMATO DE RESERVA CONFIRMADA (solo cuando el cliente haya dicho OK/sí/confirmo):
   RESERVA_LISTA|nombre|YYYY-MM-DD|HH:MM|numPersonas|notas_especiales

5. Sé breve, amable y usa algún emoji. Responde siempre en español.
6. Si preguntan por el menú, explica que son hamburguesas artesanas y que pueden ver la carta en silbis.es`;

  const messages = (historial || []).map(m => ({
    role: m.origen === 'bot' ? 'assistant' : 'user',
    content: m.texto
  }));

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: systemPrompt,
    messages
  });

  const respuesta = response.content[0].text;

  // Guardar respuesta bot
  await sb.from('mensajes').insert({ conversacion_id: conv.id, origen: 'bot', texto: respuesta });

  // Detectar reserva lista
  if (respuesta.includes('RESERVA_LISTA|')) {
    await crearReservaPendiente(respuesta, nombre, telefono);
  }

  // Enviar respuesta limpia al cliente
  const mensajeCliente = respuesta.replace(/RESERVA_LISTA\|[^\n]*/g, '').trim();
  await enviarWhatsApp(telefono, mensajeCliente || respuesta);
}

// ── CREAR RESERVA PENDIENTE ──
async function crearReservaPendiente(texto, nombre, telefono) {
  try {
    const match = texto.match(/RESERVA_LISTA\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|?(.*)?/);
    if (!match) return;

    const [, clienteNombre, fecha, hora, personas, notas] = match;

    // Buscar mesa disponible
    const numPersonas = parseInt(personas);
    const { data: mesas } = await sb.from('mesas').select('*')
      .eq('estado', 'libre').gte('capacidad', numPersonas).order('capacidad').limit(1);

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

    if (error) { console.error('Error creando reserva:', error.message); return; }

    // Marcar mesa como reservada
    if (mesas?.[0]) {
      await sb.from('mesas').update({ estado: 'reservada' }).eq('id', mesas[0].id);
    }

    console.log(`📋 Reserva pendiente: ${clienteNombre} — ${fecha} ${hora} — ${numPersonas} personas`);

    // Programar mensaje de confirmación para el día de la reserva
    await programarConfirmacion(reserva, telefono);

  } catch (err) {
    console.error('Error en crearReservaPendiente:', err.message);
  }
}

// ── PROGRAMAR CONFIRMACIÓN ──
async function programarConfirmacion(reserva, telefono) {
  const baseUrl = process.env.BASE_URL || `https://earnest-illumination-production-dd04.up.railway.app`;
  const linkConfirmar = `${baseUrl}/confirmar/${reserva.id}`;
  const fechaLegible = formatFechaLegible(reserva.fecha);

  // Guardar el link en la reserva para referencia
  await sb.from('reservas').update({ notas: (reserva.notas ? reserva.notas + ' | ' : '') + `link_confirm:${linkConfirmar}` }).eq('id', reserva.id);

  // Calcular si la reserva es hoy
  const hoy = new Date().toISOString().slice(0, 10);
  if (reserva.fecha === hoy) {
    // Es hoy — enviar confirmación ahora
    await enviarMensajeConfirmacion(telefono, reserva, linkConfirmar, fechaLegible);
  } else {
    // Guardar para envío programado (se procesará en el cron)
    await sb.from('confirmaciones_pendientes').upsert({
      reserva_id: reserva.id,
      telefono,
      fecha_envio: reserva.fecha,
      link: linkConfirmar,
      enviado: false
    }).select();
    console.log(`📅 Confirmación programada para el ${reserva.fecha}`);
  }
}

async function enviarMensajeConfirmacion(telefono, reserva, link, fechaLegible) {
  const baseUrl = process.env.BASE_URL || 'https://earnest-illumination-production-dd04.up.railway.app';
  const linkCancelar = `${baseUrl}/cancelar/${reserva.id}`;

  // Acortar ambos links
  const [linkCorto, linkCancelCorto] = await Promise.all([
    acortarUrl(link),
    acortarUrl(linkCancelar)
  ]);

  const msg = `¡Hola ${reserva.cliente_nombre}! 👋

Te recordamos tu reserva en *Silbis* para *${fechaLegible}* a las *${reserva.hora.slice(0,5)}h* (${reserva.num_personas} personas).

✅ Confirmar asistencia: ${linkCorto}

❌ Cancelar reserva: ${linkCancelCorto}

_Cualquier duda llámanos al 661 656 648_ 🍔`;
  await enviarWhatsApp(telefono, msg);
  console.log(`📤 Confirmación enviada a ${telefono}`);
}

// ── CRON: enviar confirmaciones del día ──
async function procesarConfirmacionesDia() {
  const hoy = new Date().toISOString().slice(0, 10);
  const { data: pendientes } = await sb.from('confirmaciones_pendientes')
    .select('*, reservas(*)').eq('fecha_envio', hoy).eq('enviado', false);

  if (!pendientes?.length) return;

  for (const p of pendientes) {
    const reserva = p.reservas;
    if (!reserva) continue;
    const fechaLegible = formatFechaLegible(reserva.fecha);
    await enviarMensajeConfirmacion(p.telefono, reserva, p.link, fechaLegible);
    await sb.from('confirmaciones_pendientes').update({ enviado: true }).eq('id', p.id);
  }
}

// Ejecutar cron cada hora
setInterval(procesarConfirmacionesDia, 60 * 60 * 1000);

// ── ENVIAR WHATSAPP ──
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

// ── HELPERS ──
function formatFechaLegible(fecha) {
  if (!fecha) return '';
  const d = new Date(fecha + 'T12:00:00');
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Silbis chatbot en puerto ${PORT}`));
