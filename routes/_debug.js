// TEMPORARY diagnostic route — read-only inspection of GHL's Transactions API
// to see whether a paid invoice's transaction record exposes a Stripe
// Customer ID we could use for an automated one-time charge later. No writes,
// no money moved. To be removed once confirmed either way.
import { Router } from 'express';
import db from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';

const router = Router();
const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

router.get('/list-transactions', async (req, res) => {
  try {
    const locationId = req.query.location_id;
    const client = await db.client.findUnique({ where: { ghlLocationId: locationId } });
    if (!client) return res.status(404).json({ error: 'client not found' });
    const token = decrypt(client.ghlApiTokenEncrypted);

    const headers = { Authorization: `Bearer ${token}`, Version: API_VERSION, Accept: 'application/json' };

    const url = new URL(`${BASE_URL}/payments/transactions`);
    url.searchParams.set('altId', locationId);
    url.searchParams.set('altType', 'location');
    url.searchParams.set('limit', '10');

    const txRes = await fetch(url.toString(), { headers });
    const txText = await txRes.text();

    res.json({ status: txRes.status, body: txText });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

router.get('/get-invoice', async (req, res) => {
  try {
    const locationId = req.query.location_id;
    const invoiceId = req.query.invoiceId;
    const client = await db.client.findUnique({ where: { ghlLocationId: locationId } });
    if (!client) return res.status(404).json({ error: 'client not found' });
    const token = decrypt(client.ghlApiTokenEncrypted);
    const headers = { Authorization: `Bearer ${token}`, Version: API_VERSION, Accept: 'application/json' };

    const url = new URL(`${BASE_URL}/invoices/${invoiceId}`);
    url.searchParams.set('altId', locationId);
    url.searchParams.set('altType', 'location');

    const invRes = await fetch(url.toString(), { headers });
    const invText = await invRes.text();
    res.json({ status: invRes.status, body: invText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
