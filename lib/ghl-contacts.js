// Contact + Dog resolution against GHL's API. Reuses ghlRequest for auth/base URL.
//
// Every function takes the calling client's own decrypted GHL token (see
// lib/crypto.js + routes/bookings.js) — there is no shared/global token anymore,
// since each business now connects their own GHL account.
//
// Real schema key + field keys confirmed from the GHL object created in the test
// account (2026-07-16). Dog-to-owner linking uses a native GHL Association
// (contact <-> custom_objects.dogs), confirmed working live the same day.
import { ghlRequest } from './ghl.js';

const DOG_SCHEMA_KEY = 'custom_objects.dogs';
const DOG_FIELD_NAME = 'dogs_name';
const DOG_FIELD_BREED = 'breed';
const DOG_FIELD_NOTES = 'notes';
const DOG_FIELD_VACCINE_EXPIRATION = 'vaccine_due';

// Association IDs are per-location, so we look the dog-owner association up by
// its object keys rather than hardcoding an ID from one account. Cached per
// location since association definitions essentially never change at runtime.
const associationIdCache = new Map();

async function getDogOwnerAssociationId(locationId, token) {
  if (associationIdCache.has(locationId)) return associationIdCache.get(locationId);

  const result = await ghlRequest('GET', '/associations/', { params: { locationId }, token });
  if (!result.ok) {
    throw new Error(`GHL association lookup failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const associations = result.data.associations ?? [];
  const dogOwner = associations.find((a) =>
    (a.firstObjectKey === 'contact' && a.secondObjectKey === DOG_SCHEMA_KEY)
    || (a.firstObjectKey === DOG_SCHEMA_KEY && a.secondObjectKey === 'contact')
  );
  if (!dogOwner) {
    throw new Error(`No contact <-> ${DOG_SCHEMA_KEY} association found for location ${locationId}`);
  }

  const info = { id: dogOwner.id, contactIsFirst: dogOwner.firstObjectKey === 'contact' };
  associationIdCache.set(locationId, info);
  return info;
}

// Finds an existing contact by email/phone, or creates one. Idempotent — safe to
// call every time the request form's owner-lookup step completes.
export async function upsertContact({ locationId, email, phone, firstName, lastName, token }) {
  const result = await ghlRequest('POST', '/contacts/upsert', {
    body: { locationId, email, phone, firstName, lastName },
    token,
  });
  if (!result.ok) {
    throw new Error(`GHL contact upsert failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  return result.data.contact ?? result.data;
}

// Lists dog records for a given owner contact via the native GHL Association.
//
// Treats any failure (most notably: the Dog object or association doesn't
// exist in this GHL location) as "no dogs found" rather than blocking the
// request form — the caller already has a fallback path (enter a new dog).
export async function findDogsForContact({ locationId, contactId, token }) {
  try {
    const association = await getDogOwnerAssociationId(locationId, token);
    const result = await ghlRequest('GET', `/associations/relations/${contactId}`, {
      params: { locationId },
      token,
    });
    if (!result.ok) {
      console.warn(`GHL relation lookup failed: ${result.status} ${JSON.stringify(result.data)}`);
      return [];
    }

    const relations = (result.data.relations ?? []).filter((r) => r.associationId === association.id);
    const dogRecordIds = relations.map((r) => (association.contactIsFirst ? r.secondRecordId : r.firstRecordId));

    const records = await Promise.all(dogRecordIds.map((id) => getDogRecord(id, token)));
    return records.filter(Boolean);
  } catch (err) {
    console.warn(`findDogsForContact failed: ${err.message}`);
    return [];
  }
}

export async function createDogRecord({ locationId, ownerContactId, name, breed, notes, token }) {
  const result = await ghlRequest('POST', `/objects/${DOG_SCHEMA_KEY}/records`, {
    body: {
      locationId,
      properties: {
        [DOG_FIELD_NAME]: name,
        [DOG_FIELD_BREED]: breed ?? '',
        [DOG_FIELD_NOTES]: notes ?? '',
      },
    },
    token,
  });
  if (!result.ok) {
    throw new Error(`GHL dog record create failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const record = result.data.record ?? result.data;

  const association = await getDogOwnerAssociationId(locationId, token);
  const relationResult = await ghlRequest('POST', '/associations/relations', {
    body: {
      locationId,
      associationId: association.id,
      firstRecordId: association.contactIsFirst ? ownerContactId : record.id,
      secondRecordId: association.contactIsFirst ? record.id : ownerContactId,
    },
    token,
  });
  if (!relationResult.ok) {
    throw new Error(`GHL dog-owner relation create failed: ${relationResult.status} ${JSON.stringify(relationResult.data)}`);
  }

  return record;
}

export async function getDogRecord(dogObjectId, token) {
  const result = await ghlRequest('GET', `/objects/${DOG_SCHEMA_KEY}/records/${dogObjectId}`, { token });
  if (!result.ok) return null;
  return result.data.record ?? result.data;
}

export async function getContact(contactId, token) {
  const result = await ghlRequest('GET', `/contacts/${contactId}`, { token });
  if (!result.ok) return null;
  return result.data.contact ?? result.data;
}

// Normalizes a raw GHL dog record into a shape the frontend can rely on without
// knowing GHL's internal field keys (which are per-account and have already
// caused one bug from being leaked directly into the UI).
export function dogSummaryFromRecord(record) {
  const props = record?.properties ?? {};
  return {
    id: record?.id ?? null,
    name: props[DOG_FIELD_NAME] ?? null,
    breed: props[DOG_FIELD_BREED] ?? null,
    notes: props[DOG_FIELD_NOTES] ?? null,
  };
}

export function vaccineStatusFromRecord(record) {
  const expirationDate = record?.properties?.[DOG_FIELD_VACCINE_EXPIRATION] ?? null;
  if (!expirationDate) {
    return { current: false, missing: true, expirationDate: null };
  }
  const current = new Date(expirationDate) >= new Date();
  return { current, missing: false, expirationDate };
}

// Reads vaccine status live (never cached) from the dog's GHL record.
// Non-blocking by design — callers store this as a flag, they don't reject on it.
export async function getVaccineStatus(dogObjectId, token) {
  const record = await getDogRecord(dogObjectId, token);
  if (!record) return { current: false, missing: true, expirationDate: null };
  return vaccineStatusFromRecord(record);
}
