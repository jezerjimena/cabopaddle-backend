require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_API = 'https://api-m.paypal.com';

// ── Correo (Gmail con contraseña de aplicación) ──────────────────
const EMAIL_USER = process.env.EMAIL_USER;
// Se eliminan espacios por si la contraseña de aplicación se pegó como "xxxx xxxx xxxx xxxx"
const EMAIL_APP_PASSWORD = (process.env.EMAIL_APP_PASSWORD || '').replace(/\s+/g, '') || undefined;
const EMAIL_DESTINO = process.env.EMAIL_DESTINO || EMAIL_USER || 'cabopaddle@gmail.com';

/* Render GRATIS bloquea las conexiones SMTP (puertos 25, 465 y 587), así que el
   correo por Gmail desde aquí nunca sale. Por eso el correo se manda con la API
   de Resend, que funciona por internet normal (HTTPS). Para activarlo basta la
   variable RESEND_API_KEY en Render. Si no existe, se intenta Gmail (SMTP), que
   solo funciona en un plan de pago de Render o en tu computadora. */
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim() || undefined;
const EMAIL_REMITENTE = process.env.EMAIL_REMITENTE || 'Cabo Paddle <reservas@cabopaddle.com.mx>';

const transporter = (EMAIL_USER && EMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
      // Si Gmail no contesta, se corta en segundos en vez de quedarse colgado.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    })
  : null;

// ── Ayudas para el correo ────────────────────────────────────────
/* TODO lo que escribe el cliente (nombre, correo, teléfono, etiquetas...) se
   "escapa" antes de meterlo al HTML del correo: así un nombre con símbolos
   raros se ve como texto y nunca como un enlace o un formato metido a la
   fuerza en tu bandeja. */
function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Para el asunto: una sola línea, sin caracteres de control y no demasiado larga.
function lineaSegura(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max || 80);
}

// Solo se usa como "responder a" si de verdad parece un correo.
function correoValido(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length <= 120 && /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(s) ? s : undefined;
}

// "2026-10-20" -> "martes, 20 de octubre de 2026". Si no es una fecha real, se deja tal cual.
function fechaLarga(iso, corta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return lineaSegura(iso, 40);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1) return lineaSegura(iso, 40);
  return d.toLocaleDateString('es-MX', corta
    ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }
    : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// "2026-10-20" -> "20 oct 2026" (compacta, para la descripción del pago).
function fechaCorta(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return lineaSegura(iso, 20);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1) return lineaSegura(iso, 20);
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/\./g, '');
}

/* Un solo lugar para mandar correos: por Resend si hay clave; si no, por Gmail.
   "clave" evita que un reintento mande el mismo correo dos veces (Resend la
   recuerda 24 horas). Si algo falla, lanza un error con el motivo. */
async function enviarMail({ to, subject, html, replyTo, clave }) {
  if (RESEND_API_KEY) {
    try {
      const r = await axios({
        url: 'https://api.resend.com/emails',
        method: 'post',
        timeout: 15000,
        headers: Object.assign({
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }, clave ? { 'Idempotency-Key': clave } : {}),
        data: Object.assign({ from: EMAIL_REMITENTE, to: [to], subject, html }, replyTo ? { reply_to: replyTo } : {})
      });
      return { via: 'resend', id: r.data && r.data.id };
    } catch (e) {
      const d = e.response && e.response.data;
      const motivo = d && d.message ? `${d.name ? d.name + ': ' : ''}${d.message}` : e.message;
      throw new Error(`Resend (${(e.response && e.response.status) || 'sin respuesta'}): ${motivo}`);
    }
  }
  if (transporter) {
    await transporter.sendMail({ from: `"Cabo Paddle Web" <${EMAIL_USER}>`, to, replyTo, subject, html });
    return { via: 'smtp' };
  }
  throw new Error('No hay ningún servicio de correo configurado (falta RESEND_API_KEY)');
}

function fila(etiqueta, valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  return `<tr>
    <td style="padding:9px 16px;border-bottom:1px solid #f0ece4;color:#4C6470;font-size:14px;">${esc(etiqueta)}</td>
    <td style="padding:9px 16px;border-bottom:1px solid #f0ece4;color:#16323D;font-weight:bold;font-size:14px;text-align:right;">${esc(valor)}</td>
  </tr>`;
}

async function enviarCorreoReserva(reserva, captureData) {
  const captura = (((captureData || {}).purchase_units || [])[0] || {});
  const pago = (((captura.payments || {}).captures || [])[0] || {});
  const monto = pago.amount ? `$${pago.amount.value} ${pago.amount.currency_code}` : 'N/D';
  const pagador = (captureData || {}).payer || {};
  const nombrePagador = [((pagador.name || {}).given_name), ((pagador.name || {}).surname)].filter(Boolean).join(' ');

  /* El correo muestra las cuentas que hace el SERVIDOR, no las que mando el
     navegador, y avisa si lo que se cobró no coincide con ellas. */
  const c = cotizar(reserva.paquete, reserva.adultos, reserva.ninos, reserva.conFotos === true);
  const cuenta = c.error ? null : c;
  const cobrado = pago.amount ? Math.round(Number(pago.amount.value)) : null;
  const esperado = cuenta ? cuenta.total : null;
  const avisoMonto = (cuenta && cobrado !== null && cobrado !== esperado)
    ? `<p style="margin:14px 26px 0;padding:10px 14px;background:#FBEDEC;color:#B4453C;border-radius:8px;font-size:13px;">⚠️ <strong>Revisa este cobro:</strong> se cobraron $${cobrado} y por las reglas de precio debían ser $${esperado}.</p>`
    : '';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#FBF7F0;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #eee;">
      <div style="background:#16323D;padding:22px 26px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;">🌊 Nueva reserva pagada</h1>
        <p style="margin:6px 0 0;color:#8FBAC9;font-size:13px;">Cabo Paddle — notificación automática</p>
      </div>

      <p style="margin:18px 26px 6px;color:#16323D;font-size:15px;font-weight:bold;">📋 Datos de la reserva</p>
      <table style="width:100%;border-collapse:collapse;">
        ${fila('Experiencia', reserva.tour)}
        ${fila('Fecha', fechaLarga(reserva.fecha))}
        ${fila('Hora', reserva.horaTexto || reserva.hora)}
        ${fila(reserva.etiquetaAdultos || 'Adultos', reserva.adultos)}
        ${fila(reserva.etiquetaNinos || 'Niños', reserva.ninos)}
        ${fila('Cliente', reserva.nombre)}
        ${fila('Correo del cliente', reserva.email)}
        ${fila('Teléfono / WhatsApp', reserva.telefono)}
        ${cuenta ? fila('Precio del tour (sin descuentos)', `$${cuenta.bruto} MXN`) : ''}
        ${cuenta && cuenta.descPaquete ? fila(`Descuento ${cuenta.tipoDesc}`, `-$${cuenta.descPaquete} MXN`) : ''}
        ${cuenta ? fila('Fotos del recorrido', cuenta.fotos ? `Sí · $${cuenta.fotos} MXN` : 'No las pidió') : fila('Fotos del recorrido', reserva.fotos || 'No las pidió')}
        ${fila('Total de la reserva', cuenta ? `$${cuenta.total} MXN` : reserva.total)}
      </table>

      <p style="margin:18px 26px 6px;color:#16323D;font-size:15px;font-weight:bold;">💳 Datos del pago</p>
      <table style="width:100%;border-collapse:collapse;">
        ${fila('Total pagado en línea', monto)}
        ${fila('Saldo por cobrar el día del tour', 'Nada — ya está pagado completo')}
        ${fila('Estado', pago.status || captureData.status)}
        ${fila('ID de transacción', pago.id)}
        ${fila('Pagador (PayPal)', nombrePagador)}
        ${fila('Correo PayPal', pagador.email_address)}
      </table>
      ${avisoMonto}

      <div style="margin:18px 26px;padding:14px 16px;background:#F4EBDC;border-radius:10px;">
        <p style="margin:0 0 8px;color:#16323D;font-size:13px;line-height:1.6;">
          📌 <strong>Política:</strong> si cancela con 48 horas o más de anticipación, devuélvele todo desde PayPal;
          con menos tiempo no hay reembolso, pero puedes reagendar su salida para otro día.
        </p>
        <p style="margin:0;color:#16323D;font-size:13px;line-height:1.6;">
          💡 <strong>Recuerda enviarle al cliente:</strong> ${reserva.conFotos === true
            ? 'las fotos del recorrido por WhatsApp (ya las pagó),'
            : 'ofrécele las fotos por $' + EXTRA_FOTOS + ' al terminar (no las pidió),'}
          el enlace para dejar reseña en Google,
          y este mensaje de recompra: <em>"¿Vuelves a Cabo? Tu próximo tour con 20% off — guarda este correo."</em>
        </p>
      </div>
      <p style="margin:18px 26px 24px;color:#8CA0A6;font-size:12px;line-height:1.6;">
        Este correo se generó automáticamente cuando el cliente completó su pago con PayPal.
        Puedes responder directamente a este correo para contactar al cliente.
      </p>
    </div>
  </div>`;

  return enviarMail({
    to: EMAIL_DESTINO,
    replyTo: correoValido(reserva.email),
    subject: `🌊 Nueva reserva pagada — ${lineaSegura(reserva.nombre || nombrePagador || 'Cliente', 60)}${reserva.fecha ? ' · ' + fechaLarga(reserva.fecha, true) : ''}`,
    html,
    clave: pago.id ? `reserva-${pago.id}` : undefined
  });
}

/* Manda el correo DESPUÉS de haberle contestado al cliente (así su pantalla de
   "pago recibido" no espera a Gmail) y lo reintenta si Gmail falla un momento.
   Si de plano no se logra, deja en los registros de Render una línea con los
   datos de la reserva para que no se pierda. */
async function notificarReserva(reserva, captureData) {
  if (!RESEND_API_KEY && !transporter) {
    console.error('RESERVA SIN CORREO — no hay servicio de correo configurado (falta RESEND_API_KEY) y el pago SÍ se cobró:', JSON.stringify({
      cliente: reserva.nombre, telefono: reserva.telefono, correo: reserva.email, fecha: reserva.fecha,
      hora: reserva.horaTexto || reserva.hora, experiencia: reserva.tour, total: reserva.total
    }));
    return;
  }
  const esperas = [0, 2000, 6000];
  for (let i = 0; i < esperas.length; i++) {
    if (esperas[i]) await new Promise(r => setTimeout(r, esperas[i]));
    try {
      const r = await enviarCorreoReserva(reserva, captureData);
      console.log('Correo de reserva enviado a', EMAIL_DESTINO, `(intento ${i + 1}, vía ${(r && r.via) || '?'})`);
      return;
    } catch (e) {
      console.error(`Falló el envío del correo (intento ${i + 1} de ${esperas.length}):`, e.message);
    }
  }
  const cap = ((((captureData || {}).purchase_units || [])[0] || {}).payments || {}).captures || [];
  console.error('RESERVA SIN CORREO — el pago SÍ se cobró; revisa PayPal y confirma por WhatsApp:', JSON.stringify({
    transaccion: (cap[0] || {}).id, cliente: reserva.nombre, telefono: reserva.telefono, correo: reserva.email,
    fecha: reserva.fecha, hora: reserva.horaTexto || reserva.hora, experiencia: reserva.tour,
    adultos: reserva.adultos, ninos: reserva.ninos, total: reserva.total
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   PRECIOS — esta tabla TIENE que decir lo mismo que booking.js del sitio
   ───────────────────────────────────────────────────────────────────────────
   Antes el navegador le decía al servidor cuánto cobrar y el servidor le
   creía. Eso significaba que cualquiera con un poco de conocimiento podía
   abrir las herramientas del navegador y apartar una salida de $11,000
   pagando $1 peso.

   Ahora el precio lo calcula el servidor. El navegador solo dice QUÉ se
   reserva y CUÁNTOS van; el monto lo pone esta tabla.

   SI CAMBIAS UN PRECIO: cámbialo aquí Y en booking.js del sitio. Son dos
   archivos en dos servidores distintos y tienen que coincidir. Si se
   desincronizan, el servidor lo avisa en los registros de Render.
   ═══════════════════════════════════════════════════════════════════════════ */
/* En la página el cliente paga SIEMPRE el total de la reserva. No hay
   anticipo ni descuento por pago completo (se quitaron el 10 de octubre de
   2026). Política: con 48 horas o más de anticipación se devuelve todo; con
   menos, se puede reagendar para otro día. */

/* Extra opcional: todas las fotos del recorrido. Se cobra POR SALIDA, una
   sola vez, lleven dos personas o lleven diez. Mismo número que
   EXTRAS.fotos.mxn en booking.js. No le aplican los descuentos de familia
   ni de grupo. */
const EXTRA_FOTOS = 200;

/* Tarifas del tour. Mismas que PRECIO_ADULTO, PRECIO_MENOR y DESCUENTOS en
   booking.js:
     · PRECIO_ADULTO lo paga cada adulto y cada niño de 7 años en adelante.
     · PRECIO_MENOR lo pagan los menores de 7 años: el 50%.
     · Familia: exactamente 2 adultos + 2 menores de 7 años, 15% menos.
     · Grupo: 6 personas o más, 20% menos sobre el total.
   Los descuentos no se suman: aplica uno solo. */
const PRECIO_ADULTO = 1100;
const PRECIO_MENOR = 550;
const DESCUENTOS = {
  familia: { pct: 0.15, adultos: 2, ninos: 2 },
  grupo:   { pct: 0.20, desde: 6 }
};

/* Las tres opciones de tour (tour, familia, grupo6) son la misma salida con
   la misma tarifa: cambia solo el descuento que les toca por tamaño. */
const TOUR = { adulto: PRECIO_ADULTO, nino: PRECIO_MENOR, min: 2, max: 10, descuentos: true, fotosExtra: true };
// Yoga, meditación y tarot ya incluyen las fotos del momento: no llevan el extra.
const BIENESTAR = { adulto: 990, nino: 500, min: 1, max: 8, descuentos: false, fotosExtra: false };

const PAQUETES = {
  tour:       { ...TOUR, nombre: 'Tour Privado al Arco' },
  familia:    { ...TOUR, nombre: 'Tour Privado al Arco (en familia)' },
  grupo6:     { ...TOUR, nombre: 'Tour Privado al Arco (entre amigos)' },
  yoga:       { ...BIENESTAR, nombre: 'Yoga en Paddle' },
  meditacion: { ...BIENESTAR, nombre: 'Meditación Guiada' },
  tarot:      { ...BIENESTAR, nombre: 'Tarot a la Orilla' }
};

// Nombres de planes que ya no existen, por si alguien reserva desde un
// enlace viejo que todavía ande circulando por WhatsApp.
const ALIAS = {
  esencial: 'tour', pareja: 'tour', amigos: 'tour',
  completa: 'tour', familiar: 'familia'
};

function cotizar(paqueteId, adultos, ninos, conFotos) {
  const p = PAQUETES[ALIAS[paqueteId] || paqueteId];
  if (!p) return { error: 'Ese paquete no existe' };

  adultos = parseInt(adultos, 10) || 0;
  ninos = parseInt(ninos, 10) || 0;
  const personas = adultos + ninos;

  // Los niños nunca van solos.
  if (adultos < 1) return { error: 'Cada salida necesita al menos 1 adulto' };
  if (personas < p.min) {
    return { error: `${p.nombre} sale desde ${p.min} ${p.min === 1 ? 'persona' : 'personas'}` };
  }
  if (personas > p.max) return { error: `${p.nombre} admite hasta ${p.max} personas` };

  const bruto = adultos * p.adulto + ninos * p.nino;

  // Un solo descuento a la vez; el de familia solo para la combinación exacta.
  let tipoDesc = '', pct = 0;
  if (p.descuentos) {
    if (adultos === DESCUENTOS.familia.adultos && ninos === DESCUENTOS.familia.ninos) {
      tipoDesc = 'familia'; pct = DESCUENTOS.familia.pct;
    } else if (personas >= DESCUENTOS.grupo.desde) {
      tipoDesc = 'grupo'; pct = DESCUENTOS.grupo.pct;
    }
  }
  const descPaquete = Math.round(bruto * pct);
  const tour = bruto - descPaquete;

  const fotos = (conFotos === true && p.fotosExtra) ? EXTRA_FOTOS : 0;
  const total = tour + fotos;

  return {
    nombre: p.nombre, esTour: p.fotosExtra === true,
    adultos, ninos, bruto, tipoDesc, descPaquete, tour, fotos, total
  };
}

/* Todos los totales que pueden salir legítimamente de las reglas de arriba,
   con y sin fotos, para cada combinación posible de personas. Se arma
   llamando a cotizar(), así que si cambias una regla se actualiza sola.
   Sirve para revisar, antes de capturar un pago, que la orden de PayPal vale
   algo que de verdad puede salir de las reglas. */
const MONTOS_VALIDOS = (() => {
  const set = new Set();
  for (const id of Object.keys(PAQUETES)) {
    const p = PAQUETES[id];
    for (let a = 1; a <= p.max; a++) {
      for (let n = 0; a + n <= p.max; n++) {
        if (a + n < p.min) continue;
        for (const conFotos of [false, true]) {
          const c = cotizar(id, a, n, conFotos);
          set.add(c.total);
        }
      }
    }
  }
  return set;
})();

// 1. Obtener token de acceso de PayPal
async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const response = await axios({
    url: `${PAYPAL_API}/v1/oauth2/token`,
    method: 'post',
    data: 'grant_type=client_credentials',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
  return response.data.access_token;
}

// 2. Ruta para crear una orden (cuando el cliente hace clic en "Pagar")
app.post('/api/crear-orden', async (req, res) => {
  const { paquete, adultos, ninos, conFotos, total, fecha, horaTexto, nombre, telefono, email } = req.body;

  if (!paquete) {
    console.warn('Intento de orden sin paquete:', req.body);
    return res.status(400).json({ error: 'Datos de la reserva no válidos' });
  }

  // El servidor calcula el precio. El navegador no decide.
  const c = cotizar(paquete, adultos, ninos, conFotos);
  if (c.error) {
    console.warn('Reserva rechazada:', c.error, req.body);
    return res.status(400).json({ error: c.error });
  }
  const monto = c.total;

  /* Si la página mandó el total que le mostró al cliente y NO coincide con el
     del servidor, NO SE COBRA. Puede pasar si el cliente tenía abierta una
     versión vieja de la página (por ejemplo una que todavía ofrecía el
     anticipo del 40%) o si booking.js y server.js quedaron con precios
     distintos. Cobrar un monto diferente al que el cliente vio sería cobrarle
     de más o de menos: mejor pedirle que recargue. */
  if (typeof total !== 'number' || Math.round(total) !== monto) {
    console.warn(`PRECIO DISTINTO AL MOSTRADO: la página dice ${total} y el servidor ${monto}. ` +
                 `Si pasa seguido, revisa que booking.js y server.js tengan los mismos precios.`);
    return res.status(409).json({
      error: 'El precio de tu reserva cambió. Recarga la página para ver el precio actual.',
      recargar: true
    });
  }

  const pl = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  const detalle = `${c.nombre} — ${pl(c.adultos, 'adulto', 'adultos')}` +
    (c.ninos ? ` + ${c.esTour ? pl(c.ninos, 'menor de 7 años', 'menores de 7 años') : pl(c.ninos, 'niño', 'niños')}` : '') +
    (c.descPaquete ? ` · descuento ${c.tipoDesc} -$${c.descPaquete}` : '') +
    (c.fotos ? ` + fotos ($${c.fotos})` : '');

  /* Los datos de la reserva viajan también DENTRO del pago de PayPal. El correo
     de "Ha recibido un pago" que te manda PayPal trae esta descripción, así que
     aunque el correo del servidor falle, ahí ves qué reservó, cuándo, quién y su
     teléfono. PayPal acepta máximo 127 caracteres en la descripción. */
  const quien = [
    lineaSegura(nombre, 22), lineaSegura(telefono, 18)
  ].filter(Boolean).join(' · ');
  const cuando = [fechaCorta(fecha), lineaSegura(horaTexto, 10)].filter(Boolean).join(' ');
  const descripcion = [
    `${c.nombre} ${pl(c.adultos, 'adulto', 'adultos')}` + (c.ninos ? ` + ${c.ninos} ${c.esTour ? 'menor(es)' : 'niño(s)'}` : ''),
    cuando, quien
  ].filter(Boolean).join(' · ').slice(0, 127);
  // El detalle completo (descuentos, fotos) y el correo del cliente van en "custom_id" (hasta 255).
  const idPersonalizado = [detalle, lineaSegura(email, 80)].filter(Boolean).join(' | ').slice(0, 255);

  try {
    const accessToken = await getAccessToken();
    const order = await axios({
      url: `${PAYPAL_API}/v2/checkout/orders`,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      data: {
        intent: 'CAPTURE',
        purchase_units: [{
          description: descripcion || detalle.slice(0, 127),
          custom_id: idPersonalizado,
          amount: {
            currency_code: 'MXN',
            value: monto.toFixed(2)
          }
        }]
      }
    });
    res.json({ id: order.data.id }); // devuelve el ID de la orden al frontend
  } catch (error) {
    console.error('Error creando orden:', error.response?.data || error);
    res.status(500).json({ error: 'No se pudo crear la orden' });
  }
});

// 3. Ruta para capturar (finalizar) el pago y notificar por correo
app.post('/api/capturar-orden', async (req, res) => {
  const { orderID, reserva } = req.body;
  try {
    const accessToken = await getAccessToken();

    /* Antes de cobrar, se revisa en PayPal cuánto dice esa orden. Si el monto
       no es uno de los que puede salir de la tabla de precios, no se cobra:
       significa que la orden se creó por fuera de la página. */
    const orden = await axios({
      url: `${PAYPAL_API}/v2/checkout/orders/${orderID}`,
      method: 'get',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const valorOrden = Math.round(Number(orden.data?.purchase_units?.[0]?.amount?.value));
    if (!MONTOS_VALIDOS.has(valorOrden)) {
      console.warn(`Captura rechazada: la orden ${orderID} vale ${valorOrden}, ` +
                   `que no corresponde a ninguna reserva posible.`);
      return res.status(400).json({ error: 'El monto de la orden no es válido' });
    }

    const capture = await axios({
      url: `${PAYPAL_API}/v2/checkout/orders/${orderID}/capture`,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    });

    console.log('Pago exitoso:', capture.data.id);

    res.json({ success: true, data: capture.data });

    // El correo con los datos de la reserva se manda después de contestar.
    notificarReserva(reserva || {}, capture.data)
      .catch(e => console.error('Error inesperado al notificar la reserva:', e));
  } catch (error) {
    console.error('Error capturando orden:', error.response?.data || error);
    res.status(500).json({ error: 'Error al capturar el pago' });
  }
});

// Responde "ok" y la versión: sirve para comprobar que Render ya tiene el código nuevo.
// Con ?correo=1 además le pregunta a Gmail si acepta el usuario y la contraseña de
// aplicación que tiene ESTE servidor (no manda ningún correo; máximo una vez por minuto).
let ultimaVerificacion = { t: 0, r: null };
app.get('/salud', async (req, res) => {
  const base = { ok: true, version: '2026-10-29-seguro', correo: !!(RESEND_API_KEY || transporter), via: RESEND_API_KEY ? 'resend' : (transporter ? 'smtp' : null) };
  if (req.query.correo !== '1' || RESEND_API_KEY || !transporter) return res.json(base);
  if (Date.now() - ultimaVerificacion.t > 60000) {
    ultimaVerificacion.t = Date.now();
    try {
      await transporter.verify();
      ultimaVerificacion.r = { smtp: 'ok' };
    } catch (e) {
      ultimaVerificacion.r = { smtp: 'error', codigo: e.code || '', detalle: String(e.message || '').slice(0, 160) };
    }
  }
  res.json({ ...base, ...ultimaVerificacion.r });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend corriendo en http://localhost:${PORT}`);
});
