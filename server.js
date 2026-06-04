require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

const TIMEZONE = 'Europe/Madrid';
const DIAS_SEMANA = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const DIAS_SEMANA_NORMALIZADOS = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
const DIAS_HORARIOS = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'Silbis chatbot activo 🍔', time: new Date().toISOString() }));

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

// ── CONFIRMACIÓN DE RESERVA ──
app.get('/confirmar/:reservaId', async (req, res) => {
  const { reservaId } = req.params;

  try {
    const { data: reserva } = await sb
      .from('reservas')
      .select('*')
      .eq('id', reservaId)
      .single();

    if (!reserva) return res.status(404).send('Reserva no encontrada');

    await sb
      .from('reservas')
      .update({ estado: 'confirmada' })
      .eq('id', reservaId);

    const msg = `✅ ¡Reserva confirmada! Te esperamos en Silbis el ${formatFechaLegible(reserva.fecha)} a las ${reserva.hora.slice(0,5)}h. ¡Hasta pronto! 🍔`;
    await enviarWhatsApp(reserva.cliente_telefono, msg);

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0c0b0a;color:#f0ebe0">
          <h1 style="color:#bf3228">🍔 Silbis</h1>
          <h2>¡Reserva confirmada!</h2>
          <p>Tu mesa está reservada para el <strong>${formatFechaLegible(reserva.fecha)}</strong> a las <strong>${reserva.hora.slice(0,5)}h</strong></p>
          <p style="color:#888">C/ Carnicerías, 2 — Tudela · 661 656 648</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Error confirmando:', err.message);
    res.status(500).send('Error al confirmar la reserva');
  }
});

// ── CANCELAR RESERVA ──
app.get('/cancelar/:reservaId', async (req, res) => {
  const { reservaId } = req.params;

  try {
    const { data: reserva } = await sb
      .from('reservas')
      .select('*')
      .eq('id', reservaId)
      .single();

    if (!reserva) return res.status(404).send('Reserva no encontrada');

    if (reserva.estado === 'cancelada') {
      return res.send(`
        <html>
          <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0c0b0a;color:#f0ebe0">
            <h1 style="color:#bf3228">🍔 Silbis</h1>
            <h2>Esta reserva ya estaba cancelada</h2>
            <p style="color:#888">Si necesitas ayuda llámanos al 661 656 648</p>
          </body>
        </html>
      `);
    }

    await sb
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('id', reservaId);

    const msg = `❌ Tu reserva en Silbis del ${formatFechaLegible(reserva.fecha)} a las ${reserva.hora.slice(0,5)}h ha sido cancelada. Si fue un error escríbenos o llámanos al 661 656 648. ¡Hasta pronto!`;
    await enviarWhatsApp(reserva.cliente_telefono, msg);

    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0c0b0a;color:#f0ebe0">
          <h1 style="color:#bf3228">🍔 Silbis</h1>
          <h2>Reserva cancelada</h2>
          <p>Tu reserva del <strong>${formatFechaLegible(reserva.fecha)}</strong> a las <strong>${reserva.hora.slice(0,5)}h</strong> ha sido cancelada.</p>
          <p style="color:#888;margin-top:16px">Si fue un error llámanos al 661 656 648</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Error cancelando:', err.message);
    res.status(500).send('Error al cancelar');
  }
});

// ── REENVIAR CONFIRMACIÓN DESDE PANEL ──
app.get('/reenviar-confirmacion/:reservaId', async (req, res) => {
  const { reservaId } = req.params;

  try {
    const { data: reserva } = await sb
      .from('reservas')
      .select('*')
      .eq('id', reservaId)
      .single();

    if (!reserva) return res.status(404).json({ error: 'No encontrada' });

    const baseUrl = getPublicBaseUrl();
    const link = `${baseUrl}/confirmar/${reservaId}`;
    const fechaLegible = formatFechaLegible(reserva.fecha);

    await enviarMensajeConfirmacion(reserva.cliente_telefono, reserva, link, fechaLegible);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error reenviando confirmación:', err.message);
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
  let { data: conv } = await sb
    .from('conversaciones')
    .select('*')
    .eq('cliente_telefono', telefono)
    .single();

  if (!conv) {
    const { data: nueva } = await sb
      .from('conversaciones')
      .insert({
        cliente_nombre: nombre,
        cliente_telefono: telefono,
        ultimo_mensaje: texto,
        sin_leer: true,
        estado: 'abierta'
      })
      .select()
      .single();

    conv = nueva;
  } else {
    await sb
      .from('conversaciones')
      .update({
        ultimo_mensaje: texto,
        sin_leer: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', conv.id);
  }

  await sb
    .from('mensajes')
    .insert({
      conversacion_id: conv.id,
      origen: 'user',
      texto
    });

  const { data: historial } = await sb
    .from('mensajes')
    .select('*')
    .eq('conversacion_id', conv.id)
    .order('created_at', { ascending: true })
    .limit(30);

  const { data: config } = await sb
    .from('config')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000001')
    .single();

  const { data: horarios } = await sb
    .from('horarios')
    .select('*')
    .eq('activo', true)
    .order('dia');

  const horariosTexto = horarios?.map(h =>
    `${DIAS_HORARIOS[h.dia]} (${h.turno}): ${h.hora_inicio?.slice(0,5)} - ${h.hora_fin?.slice(0,5)}`
  ).join(', ') || 'jueves a domingo en cena, sábados también en comida';

  const fechaHoy = getMadridTodayISO();
  const diaActual = weekdayNameFromISO(fechaHoy);
  const manana = addDaysISO(fechaHoy, 1);
  const calendarioProximosDias = buildCalendarContext(fechaHoy, 28);

  const systemPrompt = `Eres ${config?.bot_nombre || 'Silbi'}, el asistente de reservas de ${config?.nombre || 'Silbis'}, una hamburguesería artesana en Tudela (Navarra).

FECHA Y DÍA ACTUAL EN ESPAÑA: ${fechaHoy} (${diaActual})
MAÑANA: ${manana} (${weekdayNameFromISO(manana)})
HORARIOS DE APERTURA: ${horariosTexto}
DIRECCIÓN: ${config?.direccion || 'C/ Carnicerías, 2 — Tudela'}
TELÉFONO: ${config?.telefono || '661 656 648'}
MÁXIMO PERSONAS POR RESERVA: ${config?.max_personas || 8}

CALENDARIO REAL DE PRÓXIMOS DÍAS. Usa esta tabla y NO calcules los días de memoria:
${calendarioProximosDias}

INSTRUCCIONES IMPORTANTES:

1. FECHAS:
Los clientes hablan de forma coloquial. Interpreta expresiones como "hoy", "mañana", "este sábado", "el sábado", "el sábado que viene", "este finde", "el viernes" usando SOLO el calendario anterior.
Siempre convierte internamente a formato YYYY-MM-DD.
Antes de responder, comprueba que el día de la semana coincide con la fecha. Ejemplo: si dices "sábado", la fecha debe ser sábado.

2. PETICIONES ESPECIALES:
Si el cliente menciona tronas, bebés, silla de ruedas, movilidad reducida, alergias, intolerancias, mesa especial, celebración o cumpleaños, anótalo en notas.

3. FLUJO DE RESERVA:
- Recoge número de personas, día, hora y nombre.
- Verifica que el día y hora estén dentro del horario de apertura.
- Si hay peticiones especiales, recógelas.
- Cuando tengas todo, muestra un resumen y pide confirmación al cliente.
- Solo cuando el cliente confirme explícitamente con OK/sí/confirmo, emite la reserva.

4. FORMATO TÉCNICO DE RESERVA:
Solo cuando el cliente haya confirmado, añade al final una línea así:
RESERVA_LISTA|nombre|YYYY-MM-DD|HH:MM|numPersonas|notas_especiales

Este marcador técnico no es para el cliente. Ponlo al final de tu respuesta, en una línea separada.

5. Al confirmar, no digas que la reserva está "confirmada" definitivamente. Di que queda registrada y pendiente de confirmación final si procede.
6. Sé breve, amable y responde siempre en español.
7. Si preguntan por el menú, explica que son hamburguesas artesanas y que pueden ver la carta en silbis.es`;

  const messages = (historial || []).map(m => ({
    role: m.origen === 'bot' ? 'assistant' : 'user',
    content: cleanTechnicalMarkers(m.texto) || String(m.texto || '')
  }));

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 700,
    system: systemPrompt,
    messages
  });

  const respuesta = response.content[0].text;
  const respuestaLimpia = cleanTechnicalMarkers(respuesta);

  let reservaProcesada = null;

  if (respuesta.includes('RESERVA_LISTA|')) {
    reservaProcesada = await crearReservaPendiente(respuesta, nombre, telefono);
  }

  // Guardamos en el panel solo la respuesta visible, nunca el marcador RESERVA_LISTA.
  if (respuestaLimpia) {
    await sb
      .from('mensajes')
      .insert({
        conversacion_id: conv.id,
        origen: 'bot',
        texto: respuestaLimpia
      });
  }

  // Si no había mesa, crearReservaPendiente ya envió un mensaje operativo al cliente.
  if (reservaProcesada?.handledWithoutSendingCleanMessage) return;

  await enviarWhatsApp(telefono, respuestaLimpia || 'Perfecto, he tomado nota.');
}

// ── CREAR RESERVA PENDIENTE ──
async function crearReservaPendiente(texto, nombre, telefono) {
  try {
    const match = texto.match(/RESERVA_LISTA\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|?(.*)?/);
    if (!match) return { ok: false };

    const [, clienteNombre, fechaRaw, horaRaw, personasRaw, notas] = match;
    const numPersonas = parseInt(personasRaw, 10);
    const fecha = normalizarFechaReserva(fechaRaw, texto);
    const hora = normalizarHoraReserva(horaRaw);

    if (!fecha || !hora || !Number.isFinite(numPersonas) || numPersonas <= 0) {
      console.error('Reserva técnica inválida:', { clienteNombre, fechaRaw, horaRaw, personasRaw });

      await enviarWhatsApp(
        telefono,
        'Perdona, he tenido un problema interpretando la fecha u hora. ¿Me confirmas de nuevo día y hora de la reserva?'
      );

      return { ok: false, handledWithoutSendingCleanMessage: true };
    }

    const { data: mesas } = await sb
      .from('mesas')
      .select('*')
      .order('capacidad');

    const { data: reservasActivas } = await sb
      .from('reservas')
      .select('*')
      .eq('fecha', fecha)
      .in('estado', ['pendiente', 'confirmada']);

    const mesasOcupadas = new Set();

    (reservasActivas || []).forEach(r => {
      getMesaNumbersFromReserva(r).forEach(num => mesasOcupadas.add(String(num)));
    });

    const mesasLibres = (mesas || [])
      .filter(m => m.estado !== 'bloqueada')
      .filter(m => !mesasOcupadas.has(String(m.numero)));

    const mesaExacta = mesasLibres.find(m => m.capacidad >= numPersonas);

    let mesaAsignada = null;
    let mesasAgrupadas = [];
    let notaFinal = notas?.trim() || '';

    if (mesaExacta) {
      mesaAsignada = mesaExacta;
    } else if (mesasLibres.length >= 2) {
      let capacidadAcumulada = 0;
      const candidatas = [];

      for (const m of mesasLibres) {
        candidatas.push(m);
        capacidadAcumulada += m.capacidad;

        if (capacidadAcumulada >= numPersonas) break;
      }

      if (capacidadAcumulada >= numPersonas) {
        mesasAgrupadas = candidatas;
        mesaAsignada = candidatas[0];

        const nums = candidatas.map(m => m.numero).join(' + ');
        notaFinal = (notaFinal ? notaFinal + ' | ' : '') + `Mesas agrupadas: ${nums}`;

        console.log(`🔗 Mesas agrupadas: ${nums} para ${numPersonas} personas`);
      }
    }

    if (!mesaAsignada) {
      const msgSinMesa = mesasLibres.length === 0
        ? `Lo siento 😔, no tenemos mesas disponibles para ese día. Llámanos al *661 656 648* y te buscamos la mejor opción. ¡Disculpa las molestias!`
        : `Para una reserva de *${numPersonas} personas* necesitamos confirmarte disponibilidad manualmente. Por favor llámanos al *661 656 648* o escríbenos y te atendemos enseguida 🙏`;

      await enviarWhatsApp(telefono, msgSinMesa);

      return { ok: false, handledWithoutSendingCleanMessage: true };
    }

    const { data: reserva, error } = await sb
      .from('reservas')
      .insert({
        cliente_nombre: clienteNombre.trim(),
        cliente_telefono: telefono,
        fecha,
        hora,
        num_personas: numPersonas,
        mesa_numero: mesaAsignada.numero,
        estado: 'pendiente',
        canal: 'whatsapp',
        notas: notaFinal || null
      })
      .select()
      .single();

    if (error) {
      console.error('Error reserva:', error.message);

      await enviarWhatsApp(
        telefono,
        'Perdona, no he podido guardar la reserva. Llámanos al 661 656 648 y te ayudamos enseguida.'
      );

      return { ok: false, handledWithoutSendingCleanMessage: true };
    }

    // Importante: no marcamos la mesa como reservada globalmente.
    // La disponibilidad se calcula por fecha y reservas activas.
    console.log(
      `📋 Reserva pendiente: ${clienteNombre} — ${fecha} ${hora} — mesa(s): ${[mesaAsignada, ...mesasAgrupadas.filter(m => m.id !== mesaAsignada.id)].map(m => m.numero).join('+')}`
    );

    await programarConfirmacion(reserva, telefono);

    return { ok: true, reserva };
  } catch (err) {
    console.error('Error crearReserva:', err.message);
    return { ok: false };
  }
}

async function programarConfirmacion(reserva, telefono) {
  const baseUrl = getPublicBaseUrl();
  const linkConfirmar = `${baseUrl}/confirmar/${reserva.id}`;
  const fechaLegible = formatFechaLegible(reserva.fecha);

  await sb
    .from('reservas')
    .update({
      notas: (reserva.notas ? reserva.notas + ' | ' : '') + `link_confirm:${linkConfirmar}`
    })
    .eq('id', reserva.id);

  const hoy = getMadridTodayISO();

  if (reserva.fecha === hoy) {
    await enviarMensajeConfirmacion(telefono, reserva, linkConfirmar, fechaLegible);
  } else {
    await sb
      .from('confirmaciones_pendientes')
      .upsert({
        reserva_id: reserva.id,
        telefono,
        fecha_envio: reserva.fecha,
        link: linkConfirmar,
        enviado: false
      })
      .select();

    console.log(`📅 Confirmación programada para el ${reserva.fecha}`);
  }
}

async function enviarMensajeConfirmacion(telefono, reserva, link, fechaLegible) {
  const baseUrl = getPublicBaseUrl();
  const linkCancelar = `${baseUrl}/cancelar/${reserva.id}`;

  const msg = `¡Hola ${reserva.cliente_nombre}! 👋

Te recordamos tu reserva en *Silbis* para *${fechaLegible}* a las *${reserva.hora.slice(0,5)}h* (${reserva.num_personas} personas).

✅ Confirmar asistencia:
${link}

❌ Cancelar reserva:
${linkCancelar}

_Cualquier duda llámanos al 661 656 648_ 🍔`;

  await enviarWhatsApp(telefono, msg);
  console.log(`📤 Confirmación enviada a ${telefono}`);
}

// ── CRON: ENVIAR CONFIRMACIONES DEL DÍA ──
async function procesarConfirmacionesDia() {
  const hoy = getMadridTodayISO();

  const { data: pendientes } = await sb
    .from('confirmaciones_pendientes')
    .select('*, reservas(*)')
    .eq('fecha_envio', hoy)
    .eq('enviado', false);

  if (!pendientes?.length) return;

  for (const p of pendientes) {
    const reserva = p.reservas;
    if (!reserva) continue;

    const fechaLegible = formatFechaLegible(reserva.fecha);

    await enviarMensajeConfirmacion(p.telefono, reserva, p.link, fechaLegible);

    await sb
      .from('confirmaciones_pendientes')
      .update({ enviado: true })
      .eq('id', p.id);
  }
}

setInterval(procesarConfirmacionesDia, 60 * 60 * 1000);

// ── ENVIAR WHATSAPP ──
async function enviarWhatsApp(telefono, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'text',
        text: { body: mensaje }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`📤 Enviado a ${telefono}`);
  } catch (err) {
    console.error('Error WhatsApp:', err.response?.data || err.message);
  }
}

// ── HELPERS ──
function getPublicBaseUrl() {
  return process.env.BASE_URL || 'https://earnest-illumination-production-dd04.up.railway.app';
}

function getMadridTodayISO() {
  return formatMadridISO(new Date());
}

function formatMadridISO(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));

  return `${map.year}-${map.month}-${map.day}`;
}

function isoToUTCDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);

  if (!y || !m || !d) return null;

  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function addDaysISO(iso, days) {
  const d = isoToUTCDate(iso);

  if (!d) return null;

  d.setUTCDate(d.getUTCDate() + days);

  return d.toISOString().slice(0,10);
}

function weekdayNameFromISO(iso) {
  const d = isoToUTCDate(iso);

  if (!d) return '';

  return DIAS_SEMANA[d.getUTCDay()];
}

function buildCalendarContext(startISO, days) {
  const lines = [];

  for (let i = 0; i < days; i++) {
    const iso = addDaysISO(startISO, i);
    const d = isoToUTCDate(iso);
    const dia = weekdayNameFromISO(iso);
    const label = i === 0 ? ' (hoy)' : i === 1 ? ' (mañana)' : '';

    lines.push(`- ${dia} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()} = ${iso}${label}`);
  }

  return lines.join('\n');
}

function cleanTechnicalMarkers(text) {
  return String(text || '')
    .replace(/RESERVA_LISTA\|[^\n\r]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizarTexto(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extractWeekdayHint(text) {
  const normalized = normalizarTexto(cleanTechnicalMarkers(text));
  let best = null;

  DIAS_SEMANA_NORMALIZADOS.forEach((d, idx) => {
    const re = new RegExp(`\\b${d}\\b`, 'g');
    let m;

    while ((m = re.exec(normalized)) !== null) {
      if (!best || m.index > best.index) {
        best = {
          index: m.index,
          dayIndex: idx,
          dayName: DIAS_SEMANA[idx]
        };
      }
    }
  });

  return best;
}

function isValidISODate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;

  const d = isoToUTCDate(iso);

  return !!d && d.toISOString().slice(0,10) === iso;
}

function normalizarFechaReserva(fechaRaw, textoCompleto) {
  let fecha = String(fechaRaw || '').trim();

  if (!isValidISODate(fecha)) return null;

  const hint = extractWeekdayHint(textoCompleto);
  const actualDay = weekdayNameFromISO(fecha);

  if (!hint || actualDay === hint.dayName) return fecha;

  const today = getMadridTodayISO();
  const candidates = [];

  for (let offset = -3; offset <= 10; offset++) {
    const candidate = addDaysISO(fecha, offset);

    if (weekdayNameFromISO(candidate) === hint.dayName) {
      const pastPenalty = candidate < today ? 100 : 0;

      candidates.push({
        candidate,
        score: Math.abs(offset) + pastPenalty
      });
    }
  }

  if (candidates.length) {
    candidates.sort((a,b) => a.score - b.score);

    console.log(
      `🗓️ Fecha corregida por coherencia: ${fecha} (${actualDay}) → ${candidates[0].candidate} (${hint.dayName})`
    );

    return candidates[0].candidate;
  }

  return fecha;
}

function normalizarHoraReserva(horaRaw) {
  const raw = String(horaRaw || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})/);

  if (!match) return null;

  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);

  if (h < 0 || h > 23 || m < 0 || m > 59) return null;

  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function getMesaNumbersFromReserva(r) {
  const nums = [];

  if (r?.mesa_numero !== undefined && r?.mesa_numero !== null && String(r.mesa_numero).trim() !== '') {
    nums.push(String(r.mesa_numero).trim());
  }

  const notas = String(r?.notas || '');
  const match = notas.match(/mesas?\s+agrupadas?\s*:\s*([0-9+,\s]+)/i);

  if (match) {
    const extracted = match[1].match(/\d+/g) || [];

    extracted.forEach(n => nums.push(String(parseInt(n, 10))));
  }

  return [...new Set(nums.filter(Boolean))];
}

function formatFechaLegible(fecha) {
  if (!fecha) return '';

  const d = isoToUTCDate(fecha);

  if (!d) return fecha;

  return d.toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Silbis chatbot en puerto ${PORT}`));
