// Booking request + review routes.
// GET /availability, POST /contacts, POST /dogs, and POST / are public (no login) —
// used by the client-facing request.html form. GET /, PUT /:id/confirm, and
// PUT /:id/deny are staff-only, called from the GHL-embedded requests.html queue.

import { Router } from 'express';
import db from '../lib/db.js';
import { asyncHandler } from '../lib/async-handler.js';
import { decrypt } from '../lib/crypto.js';
import { checkPoolAvailability } from '../lib/availability.js';
import { computeBookingQuote, computeStayTotalFromBooking } from '../lib/quote.js';
import { createAndSendInvoice, getInvoiceStatus } from '../lib/ghl-invoices.js';
import { notifyStaff } from '../lib/ghl-notifications.js';
import {
  upsertContact,
  findDogsForContact,
  createDogRecord,
  getDogRecord,
  getContact,
  getVaccineStatus,
  vaccineStatusFromRecord,
  dogSummaryFromRecord,
} from '../lib/ghl-contacts.js';

const router = Router();

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
    vaccineKeys: JSON.parse(client.dogVaccineFieldKeys || '[]'),
  };
}

// Shared dog/owner/vaccine/unit enrichment — used by both the staff queue and
// the calendar view, which need the same live-resolved GHL + unit info per booking.
// Degrades gracefully (dog: null) if the mapping isn't configured yet, rather than
// failing the whole dashboard — staff should still see requests either way.
async function enrichBooking(booking, dogFieldMap, token) {
  const [dogRecord, contact, unit] = await Promise.all([
    dogFieldMap.objectKey ? getDogRecord(booking.ghlDogObjectId, dogFieldMap.objectKey, token) : null,
    getContact(booking.ghlOwnerContactId, token),
    booking.unitId ? db.unit.findUnique({ where: { id: booking.unitId } }) : null,
  ]);
  return {
    ...booking,
    addOnsSelected: JSON.parse(booking.addOnsSelected),
    dog: dogRecord ? dogSummaryFromRecord(dogRecord, dogFieldMap) : null,
    owner: contact ? { name: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(), phone: contact.phone, email: contact.email } : null,
    vaccine: dogRecord ? vaccineStatusFromRecord(dogRecord, dogFieldMap.vaccineKeys) : { tracked: false, current: false, missing: false, expirationDate: null },
    unit: unit ? { id: unit.id, name: unit.name } : null,
  };
}

const SERVICE_LABELS = { BOARDING: 'Boarding', DAY_CARE: 'Day Care', DAY_TRAINING: 'Day Training' };

// Used to build a tap-to-open link in the staff notification text.
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// Best-effort — a failed notification never fails or delays the booking itself.
async function notifyBookingRequest({ client, booking, dogFieldMap, locationId, token }) {
  const dogRecord = dogFieldMap.objectKey
    ? await getDogRecord(booking.ghlDogObjectId, dogFieldMap.objectKey, token).catch(() => null)
    : null;
  const dogName = dogRecord ? dogSummaryFromRecord(dogRecord, dogFieldMap).name : 'a dog';
  const dateRange = `${booking.startDate.toISOString().slice(0, 10)} to ${booking.endDate.toISOString().slice(0, 10)}`;
  const message = `New booking request: ${SERVICE_LABELS[booking.serviceType] || booking.serviceType} for ${dogName}, ${dateRange}. Review: ${APP_BASE_URL}/requests.html?location_id=${locationId}`;

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

  const requestedAddOns = Array.isArray(addOnsSelected) ? addOnsSelected : [];
  const totalQty = requestedAddOns.reduce((sum, a) => sum + (parseInt(a.qty) || 0), 0);
  if (totalQty > client.maxAddOnsPerDay) {
    const err = new Error(`Add-ons selected (${totalQty}) exceed the max of ${client.maxAddOnsPerDay} per day`);
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
  const dogs = dogRecords.map((r) => dogSummaryFromRecord(r, dogFieldMap));

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

// POST /api/bookings/invoices?location_id=
// Creates and sends a GHL invoice for exactly the deposit amount (never GHL's
// Partial Payment/Payment Plan features — see lib/ghl-invoices.js for why).
// Returns the hosted payment URL the client is redirected to.
router.post('/invoices', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const { serviceType, startDate, endDate, addOnsSelected, ghlOwnerContactId } = req.body;
  if (!serviceType || !startDate || !endDate || !ghlOwnerContactId) {
    return res.status(400).json({ error: 'serviceType, startDate, endDate, and ghlOwnerContactId required' });
  }

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);

  const { service } = await validateBookingRequest({ client, serviceType, startDate, endDate, addOnsSelected });

  const quote = computeBookingQuote({ service, startDate, endDate, addOnsSelected, addOns: client.addOns });
  if (quote.deposit <= 0) {
    return res.status(400).json({ error: 'This service has no deposit configured — nothing to invoice' });
  }

  const contact = await getContact(ghlOwnerContactId, token);
  if (!contact) return res.status(404).json({ error: 'Owner contact not found' });

  const { invoiceId, paymentUrl } = await createAndSendInvoice({
    locationId,
    contact,
    description: `Deposit — ${SERVICE_LABELS[serviceType] || serviceType} (${startDate} to ${endDate})`,
    amount: quote.deposit,
    token,
  });

  if (!paymentUrl) {
    console.warn(`Invoice ${invoiceId} sent but no payment URL could be extracted from the notification`);
  }

  res.status(201).json({ invoiceId, paymentUrl, quote });
}));

// GET /api/bookings/invoices/:invoiceId?location_id=
// Live payment status check — used before finalizing a booking.
router.get('/invoices/:invoiceId', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);

  const status = await getInvoiceStatus(req.params.invoiceId, locationId, token);
  res.json(status);
}));

// POST /api/bookings?location_id=
// Creates a booking request. Capacity is a hard gate; vaccine status is
// informational only and never blocks submission. Requires a paid deposit invoice.
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
    invoiceId,
  } = req.body;

  if (!serviceType || !startDate || !endDate || !ghlDogObjectId || !ghlOwnerContactId) {
    return res.status(400).json({ error: 'serviceType, startDate, endDate, ghlDogObjectId, and ghlOwnerContactId required' });
  }

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);

  const { service, requestedAddOns } = await validateBookingRequest({ client, serviceType, startDate, endDate, addOnsSelected });

  // Only require a paid deposit invoice if this service actually has a deposit
  // configured — POST /invoices refuses to create a $0 invoice, so a service
  // with no deposit must be able to skip this check entirely.
  const quote = computeBookingQuote({ service, startDate, endDate, addOnsSelected, addOns: client.addOns });
  if (quote.deposit > 0) {
    if (!invoiceId) {
      return res.status(402).json({ error: 'A paid deposit invoice is required to submit a booking request' });
    }
    const invoiceStatus = await getInvoiceStatus(invoiceId, locationId, token);
    if (!invoiceStatus.paid) {
      return res.status(402).json({ error: 'Deposit invoice has not been paid yet' });
    }
  }

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
      ghlInvoiceId: invoiceId ?? null,
      vaccineCheckBooking: JSON.stringify(vaccineCheck),
    },
  });

  res.status(201).json({ booking });

  // Fire-and-forget — staff should get the booking response fast regardless of SMS delivery.
  if (client.staffNotifyPhone) {
    notifyBookingRequest({ client, booking, dogFieldMap, locationId, token }).catch((err) => {
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
  const bookings = await db.booking.findMany({
    where: { clientId: client.id, status },
    orderBy: { startDate: 'asc' },
  });

  const enriched = await Promise.all(bookings.map((b) => enrichBooking(b, dogFieldMap, token)));

  res.json({ bookings: enriched });
}));

// GET /api/bookings/calendar?location_id=&start=&end=
// Confirmed/Active bookings overlapping [start, end], enriched, plus the full
// pool -> unit structure so the frontend can render every unit as a row —
// including empty ones — not just occupied ones.
router.get('/calendar', asyncHandler(async (req, res) => {
  const locationId = req.query.location_id;
  const { start, end } = req.query;
  if (!locationId) return res.status(400).json({ error: 'location_id required' });
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const client = await getClient(locationId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const token = requireGhlToken(client);
  const dogFieldMap = buildDogFieldMap(client);

  const bookings = await db.booking.findMany({
    where: {
      clientId: client.id,
      status: { in: ['CONFIRMED', 'ACTIVE'] },
      unitId: { not: null },
      startDate: { lte: new Date(end) },
      endDate: { gte: new Date(start) },
    },
    orderBy: { startDate: 'asc' },
  });

  const enriched = await Promise.all(bookings.map((b) => enrichBooking(b, dogFieldMap, token)));

  res.json({
    bookings: enriched,
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
// Pure DB operation — no GHL call, no token needed.
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

  const updated = await db.booking.update({
    where: { id: req.params.id },
    data: { status: 'CONFIRMED', unitId },
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

  const updated = await db.booking.update({
    where: { id: req.params.id },
    data: { status: 'ACTIVE', vaccineCheckDropoff: JSON.stringify(vaccineCheck) },
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

  const stayTotal = computeStayTotalFromBooking(booking, service);

  let depositPaid = 0;
  if (booking.ghlInvoiceId) {
    const depositStatus = await getInvoiceStatus(booking.ghlInvoiceId, locationId, token);
    depositPaid = depositStatus.amountPaid ?? 0;
  }

  const remainder = Math.round((stayTotal - depositPaid) * 100) / 100;

  let remainderInvoiceId = null;
  if (remainder > 0) {
    const contact = await getContact(booking.ghlOwnerContactId, token);
    if (!contact) return res.status(404).json({ error: 'Owner contact not found' });

    const dateRange = `${booking.startDate.toISOString().slice(0, 10)} to ${booking.endDate.toISOString().slice(0, 10)}`;
    const created = await createAndSendInvoice({
      locationId,
      contact,
      description: `Balance Due — ${SERVICE_LABELS[booking.serviceType] || booking.serviceType} (${dateRange})`,
      amount: remainder,
      token,
    });
    remainderInvoiceId = created.invoiceId;
  }

  const updated = await db.booking.update({
    where: { id: req.params.id },
    data: { status: 'COMPLETED', ghlRemainderInvoiceId: remainderInvoiceId },
  });

  res.json({ booking: updated, remainder, remainderInvoiceId });
}));

export default router;
