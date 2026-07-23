// Settings routes — all scoped to a specific GHL location (client).
// The location_id comes from the GHL Custom Menu Link URL param injection.
//
// Every mutation of an existing record (by :id) must verify it actually belongs
// to the client derived from location_id — a bare `where: { id }` lets one
// client reference or modify another client's data by guessing/reusing an ID.

import { Router } from 'express';
import db from '../lib/db.js';
import { asyncHandler } from '../lib/async-handler.js';
import { ghlRequest } from '../lib/ghl.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { listCustomObjectTypes, getObjectFields } from '../lib/ghl-contacts.js';

const router = Router();

// Helper: get-or-create the Client record for a given GHL location ID.
async function getOrCreateClient(ghlLocationId) {
  return db.client.upsert({
    where: { ghlLocationId },
    create: { ghlLocationId },
    update: {},
    include: { services: true, addOns: true, capacityPools: { include: { units: true } } },
  });
}

// GET /api/settings?location_id=xxx
// Returns the full settings for a client (creates the client record if first visit).
// Never returns the encrypted token itself — only whether one is connected.
router.get('/', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { ghlApiTokenEncrypted, ...client } = await getOrCreateClient(locationId);
  res.json({ client: { ...client, ghlConnected: !!ghlApiTokenEncrypted } });
}));

// PUT /api/settings/ghl-connection
// Validates the pasted GHL Private Integration Token live (against this same
// location) before saving, so a typo or wrong-scope token is caught immediately
// rather than failing mysteriously on the next booking request.
router.put('/ghl-connection', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { apiToken } = req.body;
  if (!apiToken) return res.status(400).json({ error: 'apiToken required' });

  // Note: GET /locations/:id is Agency-only and always 403s for a sub-account
  // Private Integration Token, even with correct scopes — /contacts/ is a
  // sub-account-scoped endpoint every PIT can actually reach, so it validates
  // both the token and that it's scoped to this location.
  const check = await ghlRequest('GET', '/contacts/', { params: { locationId, limit: 1 }, token: apiToken });
  if (!check.ok) {
    const detail = check.data?.message || check.data?.error || `HTTP ${check.status}`;
    return res.status(400).json({ error: `That token could not access this GHL location: ${detail}` });
  }

  const client = await getOrCreateClient(locationId);
  await db.client.update({
    where: { id: client.id },
    data: { ghlApiTokenEncrypted: encrypt(apiToken) },
  });

  res.json({ ghlConnected: true });
}));

// Same guard as routes/bookings.js — these endpoints call GHL on the business's
// behalf, so they need that business's own connected token.
function requireGhlToken(client) {
  if (!client.ghlApiTokenEncrypted) {
    const err = new Error('Connect your GHL account first');
    err.statusCode = 400;
    throw err;
  }
  return decrypt(client.ghlApiTokenEncrypted);
}

// GET /api/settings/dog-object-types
// Lists this business's own custom object types, so they can pick which one is
// their Dog object instead of us guessing/hardcoding a schema key.
router.get('/dog-object-types', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const client = await getOrCreateClient(locationId);
  const token = requireGhlToken(client);

  const types = await listCustomObjectTypes({ locationId, token });
  res.json({ types });
}));

// GET /api/settings/dog-object-fields?objectKey=
// Lists the real fields on a specific object, so name/breed/notes/vaccine fields
// can be picked from what's actually there instead of typed in blind.
router.get('/dog-object-fields', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  const { objectKey } = req.query;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  if (!objectKey) return res.status(400).json({ error: 'objectKey required' });

  const client = await getOrCreateClient(locationId);
  const token = requireGhlToken(client);

  const fields = await getObjectFields({ objectKey, locationId, token });
  res.json({ fields });
}));

// PUT /api/settings/dog-object-mapping
// Saves which object + fields represent a dog for this business. Name is
// required; everything else is optional. Feeding and behavioral notes are
// kept as separate fields (not folded into general notes) so a behavioral
// flag (e.g. a reactive/aggressive dog) can't get buried inside routine
// feeding text — see requests.html's prominent behavioral-notes badge.
router.put('/dog-object-mapping', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const {
    dogObjectKey,
    dogNameFieldKey,
    dogBreedFieldKey,
    dogNotesFieldKey,
    dogFeedingFieldKey,
    dogBehavioralFieldKey,
    dogMedsFieldKey,
    dogVaccineFieldKeys,
  } = req.body;
  if (!dogObjectKey || !dogNameFieldKey) {
    return res.status(400).json({ error: 'dogObjectKey and dogNameFieldKey required' });
  }

  const client = await getOrCreateClient(locationId);
  const { ghlApiTokenEncrypted, ...updated } = await db.client.update({
    where: { id: client.id },
    data: {
      dogObjectKey,
      dogNameFieldKey,
      dogBreedFieldKey: dogBreedFieldKey || null,
      dogNotesFieldKey: dogNotesFieldKey || null,
      dogFeedingFieldKey: dogFeedingFieldKey || null,
      dogBehavioralFieldKey: dogBehavioralFieldKey || null,
      dogMedsFieldKey: dogMedsFieldKey || null,
      dogVaccineFieldKeys: JSON.stringify(Array.isArray(dogVaccineFieldKeys) ? dogVaccineFieldKeys : []),
    },
  });

  res.json({ client: { ...updated, ghlConnected: !!ghlApiTokenEncrypted } });
}));

// PUT /api/settings/services/:serviceType
// Upserts settings for one service (BOARDING, DAY_CARE, or DAY_TRAINING).
router.put('/services/:serviceType', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { serviceType } = req.params;
  const validTypes = ['BOARDING', 'DAY_CARE', 'DAY_TRAINING'];
  if (!validTypes.includes(serviceType)) {
    return res.status(400).json({ error: `serviceType must be one of: ${validTypes.join(', ')}` });
  }

  const {
    billingUnit,
    baseRate,
    capacityPoolId,
    activeDays,
    depositType,
    depositValue,
    depositTiming,
  } = req.body;

  if (!capacityPoolId) {
    return res.status(400).json({ error: 'capacityPoolId required' });
  }

  const client = await getOrCreateClient(locationId);

  const pool = await db.capacityPool.findUnique({ where: { id: capacityPoolId } });
  if (!pool || pool.clientId !== client.id) {
    return res.status(400).json({ error: 'capacityPoolId does not belong to this client' });
  }

  const service = await db.serviceSettings.upsert({
    where: { clientId_serviceType: { clientId: client.id, serviceType } },
    create: {
      clientId: client.id,
      serviceType,
      billingUnit,
      baseRate: parseFloat(baseRate),
      capacityPoolId,
      activeDays: JSON.stringify(activeDays),
      depositType,
      depositValue: parseFloat(depositValue ?? 0),
      depositTiming: depositTiming ?? 'at_booking',
    },
    update: {
      billingUnit,
      baseRate: parseFloat(baseRate),
      capacityPoolId,
      activeDays: JSON.stringify(activeDays),
      depositType,
      depositValue: parseFloat(depositValue ?? 0),
      depositTiming: depositTiming ?? 'at_booking',
    },
  });

  res.json({ service });
}));

// DELETE /api/settings/services/:serviceType
// Removes service settings (owner is disabling that service).
router.delete('/services/:serviceType', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { serviceType } = req.params;
  const client = await getOrCreateClient(locationId);

  await db.serviceSettings.deleteMany({
    where: { clientId: client.id, serviceType },
  });

  res.json({ ok: true });
}));

// A pool can name another pool (same client, not itself) as its overflow —
// e.g. Crates <-> Kennels used interchangeably once the primary is full.
// See lib/availability.js / routes/bookings.js confirm for how this is used.
async function resolveFallbackPoolId(clientId, fallbackPoolId, excludeId) {
  if (!fallbackPoolId) return null;
  if (fallbackPoolId === excludeId) {
    const err = new Error('A capacity cannot be its own fallback');
    err.statusCode = 400;
    throw err;
  }
  const fallback = await db.capacityPool.findUnique({ where: { id: fallbackPoolId } });
  if (!fallback || fallback.clientId !== clientId) {
    const err = new Error('fallbackPoolId does not belong to this client');
    err.statusCode = 400;
    throw err;
  }
  return fallbackPoolId;
}

// POST /api/settings/pools
// Creates a new capacity pool for this client (e.g. "Kennels: 20 total").
router.post('/pools', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { name, totalCapacity, fallbackPoolId } = req.body;
  const client = await getOrCreateClient(locationId);
  const resolvedFallbackId = await resolveFallbackPoolId(client.id, fallbackPoolId, null);

  const pool = await db.capacityPool.create({
    data: {
      clientId: client.id,
      name,
      totalCapacity: parseInt(totalCapacity),
      fallbackPoolId: resolvedFallbackId,
    },
  });

  res.status(201).json({ pool });
}));

// PUT /api/settings/pools/:id
// Updates an existing capacity pool.
router.put('/pools/:id', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { name, totalCapacity, fallbackPoolId } = req.body;
  const client = await getOrCreateClient(locationId);
  const resolvedFallbackId = await resolveFallbackPoolId(client.id, fallbackPoolId, req.params.id);

  const result = await db.capacityPool.updateMany({
    where: { id: req.params.id, clientId: client.id },
    data: { name, totalCapacity: parseInt(totalCapacity), fallbackPoolId: resolvedFallbackId },
  });
  if (result.count === 0) return res.status(404).json({ error: 'Capacity not found' });

  const pool = await db.capacityPool.findUnique({ where: { id: req.params.id } });
  res.json({ pool });
}));

// DELETE /api/settings/pools/:id
// Fails if any service is still linked to this pool (foreign key restriction).
router.delete('/pools/:id', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  const client = await getOrCreateClient(locationId);

  const pool = await db.capacityPool.findUnique({ where: { id: req.params.id } });
  if (!pool || pool.clientId !== client.id) return res.status(404).json({ error: 'Capacity not found' });

  try {
    await db.capacityPool.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'Cannot delete this capacity while services are linked to it. Reassign those services to another capacity first.' });
  }
}));

// POST /api/settings/units
// Creates a new physical unit (e.g. "Kennel 1") under a capacity pool.
router.post('/units', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { name, capacityPoolId } = req.body;
  if (!name || !capacityPoolId) {
    return res.status(400).json({ error: 'name and capacityPoolId required' });
  }

  const client = await getOrCreateClient(locationId);
  const pool = await db.capacityPool.findUnique({ where: { id: capacityPoolId } });
  if (!pool || pool.clientId !== client.id) {
    return res.status(400).json({ error: 'capacityPoolId does not belong to this client' });
  }

  const unit = await db.unit.create({
    data: { name, capacityPoolId },
  });

  res.status(201).json({ unit });
}));

// DELETE /api/settings/units/:id
// Fails if any booking is still linked to this unit (foreign key restriction).
router.delete('/units/:id', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  const client = await getOrCreateClient(locationId);

  const unit = await db.unit.findUnique({ where: { id: req.params.id }, include: { capacityPool: true } });
  if (!unit || unit.capacityPool.clientId !== client.id) return res.status(404).json({ error: 'Unit not found' });

  try {
    await db.unit.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'Cannot delete this unit while a booking is linked to it.' });
  }
}));

// POST /api/settings/addons
// Creates a new add-on for this client.
router.post('/addons', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { name, price } = req.body;
  const client = await getOrCreateClient(locationId);

  const addOn = await db.addOn.create({
    data: {
      clientId: client.id,
      name,
      price: parseFloat(price),
    },
  });

  res.status(201).json({ addOn });
}));

// PUT /api/settings/addons/:id
// Updates an existing add-on.
router.put('/addons/:id', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { name, price } = req.body;
  const client = await getOrCreateClient(locationId);

  const result = await db.addOn.updateMany({
    where: { id: req.params.id, clientId: client.id },
    data: { name, price: parseFloat(price) },
  });
  if (result.count === 0) return res.status(404).json({ error: 'Add-on not found' });

  const addOn = await db.addOn.findUnique({ where: { id: req.params.id } });
  res.json({ addOn });
}));

// PUT /api/settings/max-addons-per-day
// Updates the combined cap on add-on selections per day for this client
// (applies across the whole add-on list, not per individual add-on).
router.put('/max-addons-per-day', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { maxAddOnsPerDay } = req.body;
  const client = await getOrCreateClient(locationId);

  const { ghlApiTokenEncrypted, ...updated } = await db.client.update({
    where: { id: client.id },
    data: { maxAddOnsPerDay: parseInt(maxAddOnsPerDay) },
  });

  res.json({ client: { ...updated, ghlConnected: !!ghlApiTokenEncrypted } });
}));

// PUT /api/settings/business-name
// Display name shown on the client-facing booking form (request.html).
router.put('/business-name', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { businessName } = req.body;
  const client = await getOrCreateClient(locationId);

  const { ghlApiTokenEncrypted, ...updated } = await db.client.update({
    where: { id: client.id },
    data: { businessName: businessName || null },
  });

  res.json({ client: { ...updated, ghlConnected: !!ghlApiTokenEncrypted } });
}));

// PUT /api/settings/intake-forms
// External GHL Form links request.html sends dog owners to instead of
// collecting a new dog / updated vaccine records itself. Either can be left
// blank to turn that gate off (see schema.prisma's Client model for why).
router.put('/intake-forms', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { newDogFormUrl, vaccineUpdateFormUrl } = req.body;
  const client = await getOrCreateClient(locationId);

  const { ghlApiTokenEncrypted, ...updated } = await db.client.update({
    where: { id: client.id },
    data: {
      newDogFormUrl: newDogFormUrl || null,
      vaccineUpdateFormUrl: vaccineUpdateFormUrl || null,
    },
  });

  res.json({ client: { ...updated, ghlConnected: !!ghlApiTokenEncrypted } });
}));

// PUT /api/settings/balance-auto-charge
// This business's own GHL Workflow webhook URL (Inbound Webhook -> Stripe
// One-Time Charge, Customer ID/Amount mapped dynamically) — Check Out POSTs
// the final balance here to charge it automatically. Blank turns this off;
// Check Out just emails the balance invoice as before.
router.put('/balance-auto-charge', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { balanceAutoChargeWebhookUrl } = req.body;
  const client = await getOrCreateClient(locationId);

  const { ghlApiTokenEncrypted, ...updated } = await db.client.update({
    where: { id: client.id },
    data: { balanceAutoChargeWebhookUrl: balanceAutoChargeWebhookUrl || null },
  });

  res.json({ client: { ...updated, ghlConnected: !!ghlApiTokenEncrypted } });
}));

// PUT /api/settings/denial-notification
// This business's own GHL Workflow webhook URL (Inbound Webhook -> Find
// Contact -> Send Email + Send SMS) — Deny POSTs the contact ID, dog name,
// and denial reason here so the client gets notified with delivery tracking
// on the business's end. Blank falls back to a plain direct SMS instead.
router.put('/denial-notification', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { denialNotificationWebhookUrl } = req.body;
  const client = await getOrCreateClient(locationId);

  const { ghlApiTokenEncrypted, ...updated } = await db.client.update({
    where: { id: client.id },
    data: { denialNotificationWebhookUrl: denialNotificationWebhookUrl || null },
  });

  res.json({ client: { ...updated, ghlConnected: !!ghlApiTokenEncrypted } });
}));

// PUT /api/settings/notifications
// Who gets texted when a new booking request comes in. Both fields optional —
// clearing the phone turns notifications off for this client.
router.put('/notifications', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { staffNotifyName, staffNotifyPhone } = req.body;
  const client = await getOrCreateClient(locationId);

  const { ghlApiTokenEncrypted, ...updated } = await db.client.update({
    where: { id: client.id },
    data: {
      staffNotifyName: staffNotifyName || null,
      staffNotifyPhone: staffNotifyPhone || null,
    },
  });

  res.json({ client: { ...updated, ghlConnected: !!ghlApiTokenEncrypted } });
}));

// DELETE /api/settings/addons/:id
router.delete('/addons/:id', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  const client = await getOrCreateClient(locationId);

  const result = await db.addOn.deleteMany({ where: { id: req.params.id, clientId: client.id } });
  if (result.count === 0) return res.status(404).json({ error: 'Add-on not found' });
  res.json({ ok: true });
}));

export default router;
