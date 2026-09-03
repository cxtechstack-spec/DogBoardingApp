// TEMPORARY diagnostic route for the duplicate-dog investigation — remove
// once it's resolved. Read-only: dumps this client's association config and
// one contact's relations straight from GHL, so we can see exactly why
// findDogsForContact isn't finding an existing dog, without needing this
// client's raw GHL token locally.
import { Router } from 'express';
import db from '../lib/db.js';
import { asyncHandler } from '../lib/async-handler.js';
import { ghlRequest } from '../lib/ghl.js';
import { decrypt } from '../lib/crypto.js';

const router = Router();

router.get('/dog-association', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  const { contactId } = req.query;
  if (!locationId || !contactId) return res.status(400).json({ error: 'location_id and contactId required' });

  const client = await db.client.findUnique({ where: { ghlLocationId: locationId } });
  if (!client?.ghlApiTokenEncrypted) return res.status(404).json({ error: 'Client not found or not connected' });
  const token = decrypt(client.ghlApiTokenEncrypted);

  const assocRes = await ghlRequest('GET', '/associations/', { params: { locationId }, token });
  const relRes = await ghlRequest('GET', `/associations/relations/${contactId}`, { params: { locationId }, token });

  res.json({
    dogObjectKey: client.dogObjectKey,
    associations: assocRes.data,
    relations: relRes.data,
  });
}));

export default router;
