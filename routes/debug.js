// TEMPORARY diagnostic route for the deposit-not-subtracted investigation —
// remove once resolved. Read-only: dumps raw GHL invoice data so we can see
// the actual field names/values GHL returns for amountDue/amountPaid, since
// lib/ghl-invoices.js's getInvoiceStatus reads those fields to compute the
// remainder owed at checkout.
import { Router } from 'express';
import db from '../lib/db.js';
import { asyncHandler } from '../lib/async-handler.js';
import { ghlRequest } from '../lib/ghl.js';
import { decrypt } from '../lib/crypto.js';

const router = Router();

router.get('/invoice', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  const { invoiceId } = req.query;
  if (!locationId || !invoiceId) return res.status(400).json({ error: 'location_id and invoiceId required' });

  const client = await db.client.findUnique({ where: { ghlLocationId: locationId } });
  if (!client?.ghlApiTokenEncrypted) return res.status(404).json({ error: 'Client not found or not connected' });
  const token = decrypt(client.ghlApiTokenEncrypted);

  const result = await ghlRequest('GET', `/invoices/${invoiceId}`, {
    params: { altId: locationId, altType: 'location' },
    token,
  });

  res.json({ status: result.status, data: result.data });
}));

export default router;
