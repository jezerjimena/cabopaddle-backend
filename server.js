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
const EMAIL_DESTINO = process.env.EMAIL_DESTINO || EMAIL_USER;

const transporter = (EMAIL_USER && EMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD }
    })
  : null;

function fila(etiqueta, valor) {
  if (valor === undefined || valor === null || valor === '') return '';
  return `<tr>
    <td style="padding:9px 16px;border-bottom:1px solid #f0ece4;color:#4C6470;font-size:14px;">${etiqueta}</td>
    <td style="padding:9px 16px;border-bottom:1px solid #f0ece4;color:#16323D;font-weight:bold;font-size:14px;text-align:right;">${valor}</td>
  </tr>`;
}

async function enviarCorreoReserva(reserva, captureData) {
  const captura = (((captureData || {}).purchase_units || [])[0] || {});
  const pago = (((captura.payments || {}).captures || [])[0] || {});
  const monto = pago.amount ? `$${pago.amount.value} ${pago.amount.currency_code}` : 'N/D';
  const pagador = (captureData || {}).payer || {};
  const nombrePagador = [((pagador.name || {}).given_name), ((pagador.name || {}).surname)].filter(Boolean).join(' ');

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
        ${fila('Fecha', reserva.fecha)}
        ${fila('Hora', reserva.hora)}
        ${fila('Adultos', reserva.adultos)}
        ${fila('Niños (6-12)', reserva.ninos)}
        ${fila('Cliente', reserva.nombre)}
        ${fila('Correo del cliente', reserva.email)}
        ${fila('Teléfono / WhatsApp', reserva.telefono)}
        ${fila('Total del tour', reserva.total)}
      </table>

      <p style="margin:18px 26px 6px;color:#16323D;font-size:15px;font-weight:bold;">💳 Datos del pago</p>
      <table style="width:100%;border-collapse:collapse;">
        ${fila('Anticipo pagado (40%)', monto)}
        ${fila('Resto por cobrar el día del tour', reserva.resto)}
        ${fila('Estado', pago.status || captureData.status)}
        ${fila('ID de transacción', pago.id)}
        ${fila('Pagador (PayPal)', nombrePagador)}
        ${fila('Correo PayPal', pagador.email_address)}
      </table>

      <div style="margin:18px 26px;padding:14px 16px;background:#F4EBDC;border-radius:10px;">
        <p style="margin:0;color:#16323D;font-size:13px;line-height:1.6;">
          💡 <strong>Recuerda enviarle al cliente:</strong> las fotos del tour por WhatsApp, el enlace para dejar reseña en Google,
          y este mensaje de recompra: <em>"¿Vuelves a Cabo? Tu próximo tour con 20% off — guarda este correo."</em>
        </p>
      </div>
      <p style="margin:18px 26px 24px;color:#8CA0A6;font-size:12px;line-height:1.6;">
        Este correo se generó automáticamente cuando el cliente completó su pago con PayPal.
        Puedes responder directamente a este correo para contactar al cliente.
      </p>
    </div>
  </div>`;

  await transporter.sendMail({
    from: `"Cabo Paddle Web" <${EMAIL_USER}>`,
    to: EMAIL_DESTINO,
    replyTo: reserva.email || undefined,
    subject: `🌊 Nueva reserva pagada — ${reserva.nombre || nombrePagador || 'Cliente'}${reserva.fecha ? ' · ' + reserva.fecha : ''}`,
    html
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PRECIOS — esta tabla TIENE que decir lo mismo que booking.js del sitio
   ───────────────────────────────────────────────────────────────────────────
   Antes el navegador le decía al servidor cuánto cobrar y el servidor le
   creía. Eso significaba que cualquiera con un poco de conocimiento podía
   abrir las herramientas del navegador y apartar una salida de $8,900
   pagando un anticipo de $1 peso.

   Ahora el precio lo calcula el servidor. El navegador solo dice QUÉ se
   reserva y CUÁNTOS van; el monto lo pone esta tabla.

   SI CAMBIAS UN PRECIO: cámbialo aquí Y en booking.js del sitio. Son dos
   archivos en dos servidores distintos y tienen que coincidir. Si se
   desincronizan, el servidor lo avisa en los registros de Render.
   ═══════════════════════════════════════════════════════════════════════════ */
const ANTICIPO = 0.4;

const PAQUETES = {
  tour:       { adulto: 890, nino: 500, min: 2, max: 10, nombre: 'Tour Privado al Arco' },
  yoga:       { adulto: 990, nino: 500, min: 1, max: 8,  nombre: 'Yoga en Paddle' },
  meditacion: { adulto: 990, nino: 500, min: 1, max: 8,  nombre: 'Meditación Guiada' },
  tarot:      { adulto: 990, nino: 500, min: 1, max: 8,  nombre: 'Tarot a la Orilla' }
};

// Nombres de planes que ya no existen, por si alguien reserva desde un
// enlace viejo que todavía ande circulando por WhatsApp.
const ALIAS = {
  esencial: 'tour', pareja: 'tour', amigos: 'tour',
  completa: 'tour', familiar: 'tour'
};

function cotizar(paqueteId, adultos, ninos) {
  const p = PAQUETES[ALIAS[paqueteId] || paqueteId];
  if (!p) return { error: 'Ese paquete no existe' };

  adultos = parseInt(adultos, 10) || 0;
  ninos = parseInt(ninos, 10) || 0;
  const personas = adultos + ninos;

  if (personas < p.min) return { error: `${p.nombre} sale desde ${p.min} persona(s)` };
  if (personas > p.max) return { error: `${p.nombre} admite hasta ${p.max} personas` };

  const total = adultos * p.adulto + ninos * p.nino;
  return {
    nombre: p.nombre, adultos, ninos, total,
    anticipo: Math.round(total * ANTICIPO)
  };
}

/* Todos los anticipos que pueden salir legítimamente de la tabla de arriba.
   Sirve para las páginas que quedaron guardadas en el navegador de alguien
   y todavía mandan el total ya calculado: si el número que llega no está en
   esta lista, es que lo manipularon y se rechaza. */
const ANTICIPOS_VALIDOS = (() => {
  const set = new Set();
  for (const id of Object.keys(PAQUETES)) {
    const p = PAQUETES[id];
    for (let a = 0; a <= p.max; a++) {
      for (let n = 0; a + n <= p.max; n++) {
        if (a + n < p.min) continue;
        set.add(Math.round((a * p.adulto + n * p.nino) * ANTICIPO));
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
  const { paquete, adultos, ninos, total, descripcion } = req.body;

  let monto, detalle;

  if (paquete) {
    // Camino normal: el servidor calcula el precio. El navegador no decide.
    const c = cotizar(paquete, adultos, ninos);
    if (c.error) {
      console.warn('Reserva rechazada:', c.error, req.body);
      return res.status(400).json({ error: c.error });
    }
    monto = c.anticipo;
    detalle = `Anticipo 40% — ${c.nombre} · ${c.adultos} adulto(s) + ${c.ninos} niño(s)`;

    // Si el sitio mandó también su propia cuenta y no coincide, es que las
    // dos tablas de precios se desincronizaron. Se cobra la del servidor,
    // pero queda el aviso en los registros de Render para corregirlo.
    if (typeof total === 'number' && Math.round(total) !== monto) {
      console.warn(`PRECIOS DESINCRONIZADOS: el sitio dice ${total} y el servidor ${monto}. ` +
                   `Revisa que booking.js y server.js tengan los mismos precios.`);
    }
  } else if (typeof total === 'number' && ANTICIPOS_VALIDOS.has(Math.round(total))) {
    // Camino de respaldo: alguien tiene la página vieja guardada en su
    // navegador y todavía manda el total ya hecho. Se acepta solo si ese
    // número de verdad puede salir de la tabla de precios.
    monto = Math.round(total);
    detalle = descripcion || 'Anticipo 40% — cabopaddle';
  } else {
    console.warn('Intento de orden con datos inválidos:', req.body);
    return res.status(400).json({ error: 'Datos de la reserva no válidos' });
  }

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
          description: detalle,
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
    if (!ANTICIPOS_VALIDOS.has(valorOrden)) {
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

    // Enviar correo con los datos de la reserva (sin bloquear la respuesta al cliente)
    if (transporter) {
      try {
        await enviarCorreoReserva(reserva || {}, capture.data);
        console.log('Correo de reserva enviado a', EMAIL_DESTINO);
      } catch (e) {
        console.error('El pago se capturó pero falló el envío del correo:', e.message);
      }
    } else {
      console.warn('EMAIL_USER / EMAIL_APP_PASSWORD no configurados: no se envió el correo de notificación.');
    }

    res.json({ success: true, data: capture.data });
  } catch (error) {
    console.error('Error capturando orden:', error.response?.data || error);
    res.status(500).json({ error: 'Error al capturar el pago' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend corriendo en http://localhost:${PORT}`);
});
