require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_API = 'https://api-m.sandbox.paypal.com'; // Sandbox (pruebas)

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

// 3. Ruta para capturar (finalizar) el pago
app.post('/api/capturar-orden', async (req, res) => {
  const { orderID } = req.body;
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

    // Aquí podrías guardar la reserva en un archivo o base de datos.
    console.log('Pago exitoso:', capture.data);
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