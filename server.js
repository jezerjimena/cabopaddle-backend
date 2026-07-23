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
  const { total, descripcion } = req.body; // recibe total y descripción desde el frontend
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
          description: descripcion,
          amount: {
            currency_code: 'MXN',
            value: total.toFixed(2)
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
