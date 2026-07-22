// Booking request + review routes.
// GET /availability, POST /contacts, POST /dogs, and POST / are public (no login) —
// used by the client-facing request.html form. GET /, PUT /:id/confirm, and
// PUT /:id/deny are staff-only, called from the GHL-embedded requests.html queue.

import { Router } from 'express';
import db from '../lib/db.js';
import { asyncHandler } from '../lib/async-handler.js';
import { decrypt } from '../lib/crypto.js';
import { checkPoolAvailability } from '../lib/availability.js';
import { computeStayTotalFromBooking, computeDepositFromBooking, countUnits } from '../lib/quote.js';
import { createAndSendInvoice, getInvoiceStatus, getStripeCustomerIdForInvoice } from '../lib/ghl-invoices.js';
import { notifyStaff } from '../lib/ghl-notifications.js';
import {
  upsertContact,
  findDogsForContact,
  createDogRecord,
  updateDogVaccineFields,
  getDogRecord,
  getContact,
  getVaccineStatus,
  vaccineStatusFromRecord,
  dogSummaryFromRecord,
} from '../lib/ghl-contacts.js';

const router = Router();

// Bookings store pure calendar dates (UTC midnight, no time-of-day meaning) —
// used to stamp the real check-in/check-out date as "today" in that same
// convention, so it lines up with startDate/endDate for billing purposes.
function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function getClient(ghlLocationId) {
  return db.client.findUnique({
    where: { ghlLocationId },
    include: {
      services: { include: { capacityPool: true } },
      addOns: true,
      capacityPools: { include: { units: true } },
    },
  });
}

// Every GHL call needs this client's own decrypted token (see lib/crypto.js) —
// there's no shared/global token anymore, each business connects their own account.
function requireGhlToken(client) {
  if (!client.ghlApiTokenEncrypted) {
    const err = new Error('Connect your GHL account in Settings first');
    err.statusCode = 400;
    throw err;
  }
  return decrypt(client.ghlApiTokenEncrypted);
}

// Every business's Dog object has different field keys (see lib/ghl-contacts.js) —
// this is required specifically where an unmapped call would silently write to a
// bogus field key or make dog lookup meaninglessly always-empty.
function requireDogMapping(client) {
  if (!client.dogObjectKey || !client.dogNameFieldKey) {
    const err = new Error('Configure your Dog object mapping in Settings first');
    err.statusCode = 400;
    throw err;
  }
  return buildDogFieldMap(client);
}

function buildDogFieldMap(client) {
  return {
    objectKey: client.dogObjectKey,
    nameKey: client.dogNameFieldKey,
    breedKey: client.dogBreedFieldKey,
    notesKey: client.dogNotesFieldKey,
    feedingKey: client.dogFeedingFieldKey,
    behavioralKey: client.dogBehavioralFieldKey,
    vaccineKeys: JSON.parse(client.dogVaccineFieldKeys || '[]'),
  };
}

// Captures the Stripe Customer ID behind the (already paid) deposit invoice,
// so the final balance can be auto-charged at Check Out without the client
// clicking anything — see lib/ghl-invoices.js's getStripeCustomerIdForInvoice.
// Best-effort and idempotent: called at both Check In and Check Out (deposit
// may not be paid yet at Check In), does nothing once already captured, and
// never throws — a business without balanceAutoChargeWebhookUrl configured
// doesn't need this at all, and a failure here shouldn't block check-in/out.
async function ensureStripeCustomerId(booking, locationId, token) {
  if (booking.stripeCustomerId || !booking.ghlInvoiceId) return booking.stripeCustomerId ?? null;
  try {
    const invoiceStatus = await getInvoiceStatus(booking.ghlInvoiceId, locationId, token);
    if (!invoiceStatus.paid) return null;

    const stripeCustomerId = await getStripeCustomerIdForInvoice(booking.ghlInvoiceId, locationId, token);
    if (!stripeCustomerId) return null;

    await db.booking.update({ where: { id: booking.id }, data: { stripeCustomerId } });
    return stripeCustomerId;
  } catch (err) {
    console.warn(`ensureStripeCustomerId failed for booking ${booking.id}: ${err.message}`);
    return null;
  }
}

// Fires this business's own GHL Workflow (Inbound Webhook -> Stripe One-Time
// Charge, both Customer ID and Amount mapped dynamically from this payload)
// to charge the final balance with no click from staff or the client. This
// is a plain webhook POST, not a GHL REST call — no bearer token involved.
// Returns whether GHL *accepted* the request, not whether the charge itself
// succeeded (see the check-out handler's comment on why that can't be known
// synchronously).
async function triggerBalanceAutoCharge({ webhookUrl, stripeCustomerId, amount, description }) {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stripeCustomerId, amount, description }),
    });
    return res.ok;
  } catch (err) {
    console.warn(`Balance auto-charge webhook failed: ${err.message}`);
    return false;
  }
}

// Shared dog/owner/vaccine/unit enrichment — used by both the staff queue and
// the calendar view, which need the same live-resolved GHL + unit info per booking.
// Degrades gracefully (dog: null) if the mapping isn't configured yet, rather than
// failing the whole dashboard — staff should still see requests either way.
async function enrichBooking(booking, dogFieldMap, locationId, token) {
  const [dogRecord, contact, unit, depositStatus] = await Promise.all([
    dogFieldMap.objectKey ? getDogRecord(booking.ghlDogObjectId, dogFieldMap.objectKey, token) : null,
    getContact(booking.ghlOwnerContactId, token),
    booking.unitId ? db.unit.findUnique({ where: { id: booking.unitId } }) : null,
    // null here means "no deposit was required for this booking", not "unknown" —
    // ghlInvoiceId only ever gets set at Confirm time when a deposit applies.
    booking.ghlInvoiceId ? getInvoiceStatus(booking.ghlInvoiceId, locationId, token).catch(() => null) : null,
  ]);
  return {
    ...booking,
    addOnsSelected: JSON.parse(booking.addOnsSelected),
    dog: dogRecord ? dogSummaryFromRecord(dogRecord, dogFieldMap) : null,
    owner: contact ? { name: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(), phone: contact.phone, email: contact.email } : null,
    vaccine: dogRecord ? vaccineStatusFromRecord(dogRecord, dogFieldMap.vaccineKeys) : { tracked: false, current: false, missing: false, expirationDate: null },
    unit: unit ? { id: unit.id, name: unit.name } : null,
    deposit: booking.ghlInvoiceId ? { required: true, paid: depositStatus?.paid ?? null } : { required: false, paid: null },
  };
}

const SERVICE_LABELS = { BOARDING: 'Boarding', DAY_CARE: 'Day Care', DAY_TRAINING: 'Day Training' };

// Used to build a tap-to-open link in the staff notification text.
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// Best-effort — a failed notification never fails or delays the booking itself.
async function notifyBookingRequest({ client, booking, dogFieldMap, vaccineCheck, locationId, token }) {
  const dogRecord = dogFieldMap.objectKey
    ? await getDogRecord(booking.ghlDogObjectId, dogFieldMap.objectKey, token).catch(() => null)
    : null;
  const dogName = dogRecord ? dogSummaryFromRecord(dogRecord, dogFieldMap).name : 'a dog';
  const dateRange = `${booking.startDate.toISOString().slice(0, 10)} to ${booking.endDate.toISOString().slice(0, 10)}`;
  const vaccineDetails = vaccineCheck?.details;
  const vaccineFlag = vaccineDetails?.tracked && (vaccineDetails.missing || !vaccineDetails.current)
    ? ' ⚠️ Vaccine records needed.'
    : '';
  const message = `New booking request: ${SERVICE_LABELS[booking.serviceType] || booking.serviceType} for ${dogName}, ${dateRange}.${vaccineFlag} Review: ${APP_BASE_URL}/requests.html?location_id=${locationId}`;

  await notifyStaff({
    locationId,
    staffName: client.staffNotifyName || 'Staff',
    staffPhone: client.staffNotifyPhone,
    message,
    token,
  });
}

// Shared validation for both invoice creation and booking creation — availability
// can change between the two steps, so both need to check it independently.
async function validateBookingRequest({ client, serviceType, startDate, endDate, addOnsSelected }) {
  const service = client.services.find((s) => s.serviceType === serviceType);
  if (!service) {
    const err = new Error(`${serviceType} is not enabled for this client`);
    err.statusCode = 400;
    throw err;
  }

  const availability = await checkPoolAvailability({
    capacityPoolId: service.capacityPoolId,
    startDate,
    endDate,
  });
  if (!availability.available) {
    const err = new Error(`No availability on ${availability.blockedDate}`);
    err.statusCode = 409;
    throw err;
  }

  // The cap is per day of the stay, not a flat total — a 5-night stay wanting
  // one dock-diving session per night is 5 total, not 1.
  const stayUnits = countUnits(startDate, endDate, service.billingUnit);
  const maxAddOnsTotal = client.maxAddOnsPerDay * stayUnits;
  const requestedAddOns = Array.isArray(addOnsSelected) ? addOnsSelected : [];
  const totalQty = requestedAddOns.reduce((sum, a) => sum + (parseInt(a.qty) || 0), 0);
  if (totalQty > maxAddOnsTotal) {
    const err = new Error(`Add-ons selected (${totalQty}) exceed the max of ${client.maxAddOnsPerDay} per day (${maxAddOnsTotal} total for this ${stayUnits}-${service.billingUnit === 'NIGHT' ? 'night' : 'day'} stay)`);
    err.statusCode = 400;
    throw err;
  }

  return { service, requestedAddOns };
}

// GET /api/bookings/availability?location_id=&serviceType=&startDate=&endDate=
// Pure DB query — no GHL call, no token needed.
router.get('/availability', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  const { serviceType, startDate, endDate } = req.query;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  if (!serviceType || !startDate || !endDate) {
    return res.status(400).json({ error: 'serviceType, startDate, and endDate required' });
  }

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const service = client.services.find((s) => s.serviceType === serviceType);
  if (!service) return res.status(400).json({ error: `${serviceType} is not enabled for this client` });

  const result = await checkPoolAvailability({
    capacityPoolId: service.capacityPoolId,
    startDate,
    endDate,
  });

  res.json(result);
}));

// POST /api/bookings/contacts?location_id=
// Finds-or-creates the owner contact, and returns any dogs already on file for them.
router.post('/contacts', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { email, phone, firstName, lastName } = req.body;
  if (!email && !phone) return res.status(400).json({ error: 'email or phone required' });

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);
  const dogFieldMap = requireDogMapping(client);

  const contact = await upsertContact({ locationId, email, phone, firstName, lastName, token });
  const dogRecords = await findDogsForContact({ locationId, contactId: contact.id, dogFieldMap, token });
  // Vaccine status is included so the booking form can gate a dog whose
  // records are missing/expired behind the client's vaccine-update form
  // (see Client.vaccineUpdateFormUrl) before letting the booking proceed.
  const dogs = dogRecords.map((r) => ({
    ...dogSummaryFromRecord(r, dogFieldMap),
    vaccine: vaccineStatusFromRecord(r, dogFieldMap.vaccineKeys),
  }));

  res.json({ contact, dogs });
}));

// POST /api/bookings/dogs?location_id=
// Creates a new dog record for an owner who has none on file yet.
router.post('/dogs', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { ownerContactId, name, breed, notes } = req.body;
  if (!ownerContactId || !name) return res.status(400).json({ error: 'ownerContactId and name required' });

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);
  const dogFieldMap = requireDogMapping(client);

  const dog = await createDogRecord({ locationId, ownerContactId, name, breed, notes, dogFieldMap, token });
  res.status(201).json({ dog });
}));

// PUT /api/bookings/dogs/:id/vaccines?location_id=
// Updates only this one dog's configured vaccine-expiration fields, directly
// by record ID — bypasses GHL's own "Update Associated Record for Contact"
// workflow action, which has no way to target a single record among several
// tied to the same contact (confirmed live: it silently overwrites every dog
// under that contact instead of just the one being renewed).
router.put('/dogs/:id/vaccines', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { vaccineDates } = req.body;
  if (!vaccineDates || typeof vaccineDates !== 'object') {
    return res.status(400).json({ error: 'vaccineDates required' });
  }

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);
  const dogFieldMap = requireDogMapping(client);

  // Only ever write to fields this business actually configured as vaccine
  // fields — never let an arbitrary key through to a real GHL property write.
  const allowedKeys = new Set(dogFieldMap.vaccineKeys);
  for (const key of Object.keys(vaccineDates)) {
    if (!allowedKeys.has(key)) {
      return res.status(400).json({ error: `${key} is not a configured vaccine field` });
    }
  }

  const dog = await updateDogVaccineFields({
    dogObjectId: req.params.id,
    objectKey: dogFieldMap.objectKey,
    locationId,
    vaccineDates,
    token,
  });

  res.json({ dog });
}));

// POST /api/bookings?location_id=
// Creates a booking request. Capacity is a hard gate; vaccine status is
// informational only and never blocks submission. No payment is collected at
// this point — the deposit invoice is only created once staff confirm the
// booking (see PUT /:id/confirm), so a denied request was never charged
// anything to begin with.
router.post('/', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const {
    serviceType,
    startDate,
    endDate,
    addOnsSelected,
    ghlDogObjectId,
    ghlOwnerContactId,
  } = req.body;

  if (!serviceType || !startDate || !endDate || !ghlDogObjectId || !ghlOwnerContactId) {
    return res.status(400).json({ error: 'serviceType, startDate, endDate, ghlDogObjectId, and ghlOwnerContactId required' });
  }

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);

  const { service, requestedAddOns } = await validateBookingRequest({ client, serviceType, startDate, endDate, addOnsSelected });

  const snapshotAddOns = requestedAddOns.map((requested) => {
    const addOn = client.addOns.find((a) => a.id === requested.addOnId);
    if (!addOn) throw new Error(`Unknown add-on: ${requested.addOnId}`);
    return { addOnId: addOn.id, name: addOn.name, price: addOn.price, qty: parseInt(requested.qty) || 1 };
  });

  const dogFieldMap = buildDogFieldMap(client);

  let vaccineCheck;
  try {
    const status = await getVaccineStatus(ghlDogObjectId, dogFieldMap, token);
    vaccineCheck = { checked: true, timestamp: new Date().toISOString(), details: status };
  } catch {
    vaccineCheck = { checked: false, timestamp: new Date().toISOString(), details: null };
  }

  const booking = await db.booking.create({
    data: {
      clientId: client.id,
      ghlDogObjectId,
      ghlOwnerContactId,
      serviceType,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      addOnsSelected: JSON.stringify(snapshotAddOns),
      status: 'REQUESTED',
      lockedRate: service.baseRate,
      vaccineCheckBooking: JSON.stringify(vaccineCheck),
    },
  });

  res.status(201).json({ booking });

  // Fire-and-forget — staff should get the booking response fast regardless of SMS delivery.
  if (client.staffNotifyPhone) {
    notifyBookingRequest({ client, booking, dogFieldMap, vaccineCheck, locationId, token }).catch((err) => {
      console.warn(`Staff notification failed: ${err.message}`);
    });
  }
}));

// GET /api/bookings?location_id=&status=REQUESTED
// Staff queue — enriches each booking with live dog/owner info and a vaccine flag.
router.get('/', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);
  const dogFieldMap = buildDogFieldMap(client);

  const status = req.query.status || 'REQUESTED';
  // Requests are sorted oldest-first (not by stay date) so that when two
  // people want the same dates, staff naturally see who asked first and can
  // give them first chance if the other gets denied. Confirmed/Active stay
  // sorted by stay date, which is what matters for check-in/out planning.
  const bookings = await db.booking.findMany({
    where: { clientId: client.id, status },
    orderBy: status === 'REQUESTED' ? { createdAt: 'asc' } : { startDate: 'asc' },
  });

  const enriched = await Promise.all(bookings.map((b) => enrichBooking(b, dogFieldMap, locationId, token)));

  res.json({ bookings: enriched });
}));

// GET /api/bookings/calendar?location_id=&start=&end=
// Confirmed/Active bookings overlapping [start, end], enriched, plus the full
// pool -> unit structure so the frontend can render every unit as a row —
// including empty ones — not just occupied ones. Also returns still-pending
// REQUESTED bookings for the same range (they have no unit yet, so the
// frontend renders them in a separate "Pending Requests" row per pool
// instead) — staff asked for these to be visible on the calendar itself so
// none get missed, sorted oldest-first so competing requests for the same
// dates are handled in the order they came in.
router.get('/calendar', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  const { start, end } = req.query;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);
  const dogFieldMap = buildDogFieldMap(client);

  const [bookings, pendingRequests] = await Promise.all([
    db.booking.findMany({
      where: {
        clientId: client.id,
        status: { in: ['CONFIRMED', 'ACTIVE'] },
        unitId: { not: null },
        startDate: { lte: new Date(end) },
        endDate: { gte: new Date(start) },
      },
      orderBy: { startDate: 'asc' },
    }),
    db.booking.findMany({
      where: {
        clientId: client.id,
        status: 'REQUESTED',
        startDate: { lte: new Date(end) },
        endDate: { gte: new Date(start) },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const enriched = await Promise.all(bookings.map((b) => enrichBooking(b, dogFieldMap, locationId, token)));
  const enrichedPending = await Promise.all(pendingRequests.map(async (b) => ({
    ...(await enrichBooking(b, dogFieldMap, locationId, token)),
    capacityPoolId: client.services.find((s) => s.serviceType === b.serviceType)?.capacityPoolId ?? null,
  })));

  res.json({
    bookings: enriched,
    pendingRequests: enrichedPending,
    pools: client.capacityPools.map((p) => ({
      id: p.id,
      name: p.name,
      units: p.units.map((u) => ({ id: u.id, name: u.name })),
    })),
  });
}));

// PUT /api/bookings/:id/confirm
// Staff picks a specific unit from the service's capacity pool — no auto-assignment.
// A unit is a hard, single-occupancy resource, so overlapping-date double-booking
// onto the same unit is rejected outright (unlike pool-wide capacity, which is a count).
// If this service has a deposit configured, the deposit invoice is created and
// sent here — not at request time — so a request that gets denied (no
// availability, wrong breed, etc.) was never charged anything to begin with.
router.put('/:id/confirm', asyncHandler(async (req, res) => {
  const { unitId } = req.body;
  if (!unitId) return res.status(400).json({ error: 'unitId required' });

  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const booking = await db.booking.findUnique({ where: { id: req.params.id } });
  if (!booking || booking.clientId !== client.id) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'REQUESTED') {
    return res.status(400).json({ error: `Cannot confirm a booking with status ${booking.status}` });
  }

  const service = client.services.find((s) => s.serviceType === booking.serviceType);
  const unit = await db.unit.findUnique({ where: { id: unitId } });
  const allowedPoolIds = service
    ? [service.capacityPoolId, service.capacityPool.fallbackPoolId].filter(Boolean)
    : [];
  if (!unit || !service || !allowedPoolIds.includes(unit.capacityPoolId)) {
    return res.status(400).json({ error: "That unit isn't part of this booking's capacity pool" });
  }

  const overlapping = await db.booking.findFirst({
    where: {
      unitId,
      status: { in: ['CONFIRMED', 'ACTIVE'] },
      startDate: { lte: booking.endDate },
      endDate: { gte: booking.startDate },
      id: { not: booking.id },
    },
  });
  if (overlapping) {
    return res.status(409).json({ error: `${unit.name} is already booked for overlapping dates` });
  }

  // Send the deposit invoice before touching the booking record, so a GHL
  // failure here leaves the booking untouched (still REQUESTED) — staff just
  // retry Confirm rather than ending up with a confirmed-but-uninvoiced stay.
  let ghlInvoiceId = null;
  const deposit = computeDepositFromBooking(booking, service);
  if (deposit > 0) {
    const token = requireGhlToken(client);
    const contact = await getContact(booking.ghlOwnerContactId, token);
    if (!contact) return res.status(404).json({ error: 'Owner contact not found' });

    const dateRange = `${booking.startDate.toISOString().slice(0, 10)} to ${booking.endDate.toISOString().slice(0, 10)}`;
    const created = await createAndSendInvoice({
      locationId,
      contact,
      description: `Deposit — ${SERVICE_LABELS[booking.serviceType] || booking.serviceType} (${dateRange})`,
      amount: deposit,
      token,
    });
    ghlInvoiceId = created.invoiceId;
  }

  const updated = await db.booking.update({
    where: { id: req.params.id },
    data: { status: 'CONFIRMED', unitId, ghlInvoiceId },
  });

  res.json({ booking: updated });
}));

// PUT /api/bookings/:id/reassign-unit
// Moves an already-confirmed/active booking to a different unit (e.g. dragging
// a dog to a different kennel/crate on the calendar) without touching its
// dates. Same pool + overlap validation as /confirm, since a unit is still a
// hard, single-occupancy resource.
// Pure DB operation — no GHL call, no token needed.
router.put('/:id/reassign-unit', asyncHandler(async (req, res) => {
  const { unitId } = req.body;
  if (!unitId) return res.status(400).json({ error: 'unitId required' });

  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const booking = await db.booking.findUnique({ where: { id: req.params.id } });
  if (!booking || booking.clientId !== client.id) return res.status(404).json({ error: 'Booking not found' });
  if (!['CONFIRMED', 'ACTIVE'].includes(booking.status)) {
    return res.status(400).json({ error: `Cannot reassign a booking with status ${booking.status}` });
  }

  const service = client.services.find((s) => s.serviceType === booking.serviceType);
  const unit = await db.unit.findUnique({ where: { id: unitId } });
  const allowedPoolIds = service
    ? [service.capacityPoolId, service.capacityPool.fallbackPoolId].filter(Boolean)
    : [];
  if (!unit || !service || !allowedPoolIds.includes(unit.capacityPoolId)) {
    return res.status(400).json({ error: "That unit isn't part of this booking's capacity pool" });
  }

  const overlapping = await db.booking.findFirst({
    where: {
      unitId,
      status: { in: ['CONFIRMED', 'ACTIVE'] },
      startDate: { lte: booking.endDate },
      endDate: { gte: booking.startDate },
      id: { not: booking.id },
    },
  });
  if (overlapping) {
    return res.status(409).json({ error: `${unit.name} is already booked for overlapping dates` });
  }

  const updated = await db.booking.update({
    where: { id: req.params.id },
    data: { unitId },
  });

  res.json({ booking: updated });
}));

// PUT /api/bookings/:id/deny
// Denied is terminal — it never moves on to Active or Completed.
// Pure DB operation — no GHL call, no token needed.
router.put('/:id/deny', asyncHandler(async (req, res) => {
  const { denialReason } = req.body;

  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const booking = await db.booking.findUnique({ where: { id: req.params.id } });
  if (!booking || booking.clientId !== client.id) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'REQUESTED') {
    return res.status(400).json({ error: `Cannot deny a booking with status ${booking.status}` });
  }

  const updated = await db.booking.update({
    where: { id: req.params.id },
    data: { status: 'DENIED', denialReason: denialReason ?? null },
  });

  res.json({ booking: updated });
}));

// PUT /api/bookings/:id/check-in
// CONFIRMED -> ACTIVE. Re-checks vaccine status live (non-blocking, same pattern
// as the request-time check) since time has passed since the original request.
router.put('/:id/check-in', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);
  const dogFieldMap = buildDogFieldMap(client);

  const booking = await db.booking.findUnique({ where: { id: req.params.id } });
  if (!booking || booking.clientId !== client.id) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'CONFIRMED') {
    return res.status(400).json({ error: `Cannot check in a booking with status ${booking.status}` });
  }

  let vaccineCheck;
  try {
    const status = await getVaccineStatus(booking.ghlDogObjectId, dogFieldMap, token);
    vaccineCheck = { checked: true, timestamp: new Date().toISOString(), details: status };
  } catch {
    vaccineCheck = { checked: false, timestamp: new Date().toISOString(), details: null };
  }

  // Best-effort: the deposit may already be paid by check-in time, in which
  // case this saves needing to try again at check-out.
  if (client.balanceAutoChargeWebhookUrl) {
    await ensureStripeCustomerId(booking, locationId, token);
  }

  const updated = await db.booking.update({
    where: { id: req.params.id },
    data: { status: 'ACTIVE', actualStartDate: todayUTC(), vaccineCheckDropoff: JSON.stringify(vaccineCheck) },
  });

  res.json({ booking: updated });
}));

// PUT /api/bookings/:id/check-out
// ACTIVE -> COMPLETED. Computes the remaining balance (stay total minus deposit
// already paid) from the booking's own locked-rate/add-on snapshot and creates a
// separate invoice for it if there's anything left to collect.
router.put('/:id/check-out', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);

  const booking = await db.booking.findUnique({ where: { id: req.params.id } });
  if (!booking || booking.clientId !== client.id) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'ACTIVE') {
    return res.status(400).json({ error: `Cannot check out a booking with status ${booking.status}` });
  }

  const service = client.services.find((s) => s.serviceType === booking.serviceType);
  if (!service) {
    return res.status(400).json({ error: `${booking.serviceType} is no longer configured for this client` });
  }

  // Bill for what actually happened (extended stay, early pickup, etc.), not
  // what was originally booked — actualStartDate was already set at Check In;
  // actualEndDate is "today" (real pickup date) instead of the booked endDate.
  const actualEndDate = todayUTC();
  const stayTotal = computeStayTotalFromBooking({ ...booking, actualEndDate }, service);

  let depositPaid = 0;
  if (booking.ghlInvoiceId) {
    const depositStatus = await getInvoiceStatus(booking.ghlInvoiceId, locationId, token);
    depositPaid = depositStatus.amountPaid ?? 0;
  }

  const remainder = Math.round((stayTotal - depositPaid) * 100) / 100;

  let remainderInvoiceId = null;
  let autoChargeAttempted = false;
  if (remainder > 0) {
    const contact = await getContact(booking.ghlOwnerContactId, token);
    if (!contact) return res.status(404).json({ error: 'Owner contact not found' });

    const actualStart = booking.actualStartDate ?? booking.startDate;
    const dateRange = `${actualStart.toISOString().slice(0, 10)} to ${actualEndDate.toISOString().slice(0, 10)}`;
    const description = `Balance Due — ${SERVICE_LABELS[booking.serviceType] || booking.serviceType} (${dateRange})`;

    // The invoice is still created either way — it's the business's own
    // record of what's owed, and the fallback if auto-charge isn't set up or
    // doesn't have a usable Stripe customer yet.
    const created = await createAndSendInvoice({ locationId, contact, description, amount: remainder, token });
    remainderInvoiceId = created.invoiceId;

    if (client.balanceAutoChargeWebhookUrl) {
      const stripeCustomerId = await ensureStripeCustomerId(booking, locationId, token);
      if (stripeCustomerId) {
        autoChargeAttempted = await triggerBalanceAutoCharge({
          webhookUrl: client.balanceAutoChargeWebhookUrl,
          stripeCustomerId,
          amount: remainder,
          description,
        });
      }
    }
  }

  const updated = await db.booking.update({
    where: { id: req.params.id },
    data: { status: 'COMPLETED', actualEndDate, ghlRemainderInvoiceId: remainderInvoiceId },
  });

  // autoChargeAttempted only means the charge request was accepted by GHL's
  // workflow webhook, not that the charge itself succeeded — GHL workflows
  // run asynchronously, so there's no synchronous success/failure to report
  // here. Staff should still confirm via GHL's Transactions/Payments that it
  // actually went through, especially early on.
  res.json({ booking: updated, remainder, remainderInvoiceId, autoChargeAttempted });
}));

export default router;
