// Contact + Dog resolution against GHL's API. Reuses ghlRequest for auth/base URL.
//
// Every function takes the calling client's own decrypted GHL token (see
// lib/crypto.js + routes/bookings.js) — there is no shared/global token anymore,
// since each business now connects their own GHL account.
//
// There's also no fixed Dog object schema — every business's independently-built
// GHL object has different field keys (confirmed by a real client's object having
// separate Bordetella/Rabies/DHLPP fields instead of one generic vaccine field, no
// notes field, etc.). A `dogFieldMap` — `{ objectKey, nameKey, breedKey, notesKey,
// vaccineKeys }` — configured per client in Settings (see routes/settings.js's
// dog-object-* endpoints) is threaded through instead of hardcoded constants.
import { ghlRequest } from './ghl.js';

// Every business's Dog object has different field keys — this maps our
// concepts (name, breed, notes, vaccine dates) to their actual field keys,
// as configured per client in Settings (see routes/settings.js's dog-object-*
// endpoints). Shared by routes/bookings.js and lib/google-calendar-sync.js.
export function buildDogFieldMap(client) {
  return {
    objectKey: client.dogObjectKey,
    nameKey: client.dogNameFieldKey,
    breedKey: client.dogBreedFieldKey,
    notesKey: client.dogNotesFieldKey,
    feedingKey: client.dogFeedingFieldKey,
    behavioralKey: client.dogBehavioralFieldKey,
    medsKey: client.dogMedsFieldKey,
    vaccineKeys: JSON.parse(client.dogVaccineFieldKeys || '[]'),
  };
}

// Association IDs are per-location, so we look the dog-owner association up by
// its object keys rather than hardcoding an ID from one account. Cached per
// (location, objectKey) pair since association definitions essentially never
// change at runtime.
//
// A location can have MORE THAN ONE contact <-> dog-object association
// defined in GHL — confirmed live: one business had both a "Dog" and a "Dog
// Owner" association pointing at the same two object types (most likely one
// created by hand and one by a data-import tool). Existing relations can be
// linked under either one, so every lookup has to check relations against
// ALL of them — picking just the first match (the old behavior) meant
// existing dogs whose relation used the *other* association silently never
// matched, making the request form think that owner had no dogs on file.
const associationCache = new Map();

async function getDogOwnerAssociations(locationId, objectKey, token) {
  const cacheKey = `${locationId}:${objectKey}`;
  if (associationCache.has(cacheKey)) return associationCache.get(cacheKey);

  const result = await ghlRequest('GET', '/associations/', { params: { locationId }, token });
  if (!result.ok) {
    throw new Error(`GHL association lookup failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const associations = result.data.associations ?? [];
  const matches = associations
    .filter((a) =>
      (a.firstObjectKey === 'contact' && a.secondObjectKey === objectKey)
      || (a.firstObjectKey === objectKey && a.secondObjectKey === 'contact')
    )
    .map((a) => ({ id: a.id, contactIsFirst: a.firstObjectKey === 'contact' }));
  if (!matches.length) {
    throw new Error(`No contact <-> ${objectKey} association found for location ${locationId}`);
  }

  associationCache.set(cacheKey, matches);
  return matches;
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
// Used to silently treat any failure (most notably: the association isn't set
// up right) as "no dogs found" so it wouldn't block the request form — but
// that's exactly what was causing duplicate dog custom objects: an owner who
// already had a dog on file would hit a lookup hiccup (misconfigured
// association, expired token, a flaky GHL response), silently get told "no
// dogs on file," and re-add the same dog through the "add a new dog" path.
// Now this throws instead, so the caller (POST /contacts, see routes/bookings.js)
// surfaces a real error and the request form's existing "Something went wrong
// looking up your info" handling stops the owner before a duplicate gets created,
// rather than quietly waving them through.
export async function findDogsForContact({ locationId, contactId, dogFieldMap, token }) {
  const associations = await getDogOwnerAssociations(locationId, dogFieldMap.objectKey, token);
  const result = await ghlRequest('GET', `/associations/relations/${contactId}`, {
    params: { locationId },
    token,
  });
  if (!result.ok) {
    throw new Error(`GHL relation lookup failed: ${result.status} ${JSON.stringify(result.data)}`);
  }

  // Match against whichever of the possibly-several contact<->dog
  // associations this relation actually used (see getDogOwnerAssociations) —
  // and compare ids as strings, since GHL doesn't document the two endpoints
  // as guaranteeing matching id types.
  const byId = new Map(associations.map((a) => [String(a.id), a]));
  const dogRecordIds = (result.data.relations ?? [])
    .map((r) => ({ relation: r, association: byId.get(String(r.associationId)) }))
    .filter(({ association }) => association)
    .map(({ relation, association }) => (association.contactIsFirst ? relation.secondRecordId : relation.firstRecordId));

  const records = await Promise.all(dogRecordIds.map((id) => getDogRecord(id, dogFieldMap.objectKey, token)));
  return records.filter(Boolean);
}

export async function createDogRecord({ locationId, ownerContactId, name, breed, notes, dogFieldMap, token }) {
  const properties = { [dogFieldMap.nameKey]: name };
  if (dogFieldMap.breedKey) properties[dogFieldMap.breedKey] = breed ?? '';
  if (dogFieldMap.notesKey) properties[dogFieldMap.notesKey] = notes ?? '';

  const result = await ghlRequest('POST', `/objects/${dogFieldMap.objectKey}/records`, {
    body: { locationId, properties },
    token,
  });
  if (!result.ok) {
    throw new Error(`GHL dog record create failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const record = result.data.record ?? result.data;

  // When a location has more than one matching association (see
  // getDogOwnerAssociations), new dogs are always linked under the first one
  // — arbitrary, but consistent, and findDogsForContact checks all of them
  // on read regardless of which one a given dog ended up under.
  const [association] = await getDogOwnerAssociations(locationId, dogFieldMap.objectKey, token);
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

// Updates only the given fields (vaccine dates, or feeding/meds/behavioral
// notes) on one specific dog record, by its exact record ID. Used instead of
// relying on GHL's own "Update Associated Record for Contact" workflow
// action, which has no way to target a single record — it updates every
// record under an association label, so a multi-dog household updating one
// dog's info would silently overwrite every other dog's data too (confirmed
// live against a real sandbox record, originally for vaccine renewals).
export async function updateDogFields({ dogObjectId, objectKey, locationId, fields, token }) {
  const result = await ghlRequest('PUT', `/objects/${objectKey}/records/${dogObjectId}`, {
    params: { locationId },
    body: { properties: fields },
    token,
  });
  if (!result.ok) {
    throw new Error(`GHL dog field update failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  return result.data.record ?? result.data;
}

export async function getDogRecord(dogObjectId, objectKey, token) {
  const result = await ghlRequest('GET', `/objects/${objectKey}/records/${dogObjectId}`, { token });
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
export function dogSummaryFromRecord(record, dogFieldMap) {
  const props = record?.properties ?? {};
  return {
    id: record?.id ?? null,
    name: props[dogFieldMap.nameKey] ?? null,
    breed: dogFieldMap.breedKey ? (props[dogFieldMap.breedKey] ?? null) : null,
    notes: dogFieldMap.notesKey ? (props[dogFieldMap.notesKey] ?? null) : null,
    feeding: dogFieldMap.feedingKey ? (props[dogFieldMap.feedingKey] ?? null) : null,
    behavioral: dogFieldMap.behavioralKey ? (props[dogFieldMap.behavioralKey] ?? null) : null,
    meds: dogFieldMap.medsKey ? (props[dogFieldMap.medsKey] ?? null) : null,
  };
}

// Aggregates however many vaccine-expiration fields a business tracks into one
// status. "Current" only if every configured field has a value and it isn't in
// the past — a business tracking three vaccines shouldn't read as current just
// because one of them is fine. Zero fields configured means nothing was actually
// checked, so it's reported as untracked rather than defaulting to "current".
export function vaccineStatusFromRecord(record, vaccineKeys) {
  if (!vaccineKeys || vaccineKeys.length === 0) {
    return { tracked: false, current: false, missing: false, expirationDate: null };
  }

  const props = record?.properties ?? {};
  const values = vaccineKeys.map((key) => props[key]).filter(Boolean);
  if (values.length < vaccineKeys.length) {
    return { tracked: true, current: false, missing: true, expirationDate: null };
  }

  const dates = values.map((v) => new Date(v)).sort((a, b) => a - b);
  const earliest = dates[0];
  const current = earliest >= new Date();
  return { tracked: true, current, missing: false, expirationDate: earliest.toISOString() };
}

// Reads vaccine status live (never cached) from the dog's GHL record.
// Non-blocking by design — callers store this as a flag, they don't reject on it.
export async function getVaccineStatus(dogObjectId, dogFieldMap, token) {
  const record = await getDogRecord(dogObjectId, dogFieldMap.objectKey, token);
  if (!record) return { tracked: dogFieldMap.vaccineKeys?.length > 0, current: false, missing: true, expirationDate: null };
  return vaccineStatusFromRecord(record, dogFieldMap.vaccineKeys);
}

// -- Settings-time helpers: let a business pick their real object/fields rather
// -- than typing in GHL's internal keys blind. --

// Custom object types only (excludes the built-in contact/opportunity/business).
export async function listCustomObjectTypes({ locationId, token }) {
  const result = await ghlRequest('GET', '/objects/', { params: { locationId }, token });
  if (!result.ok) {
    throw new Error(`GHL object list failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const objects = result.data.objects ?? result.data ?? [];
  return objects
    .filter((o) => o.type === 'USER_DEFINED')
    .map((o) => ({ key: o.key, label: o.labels?.singular ?? o.key }));
}

export async function getObjectFields({ objectKey, locationId, token }) {
  const result = await ghlRequest('GET', `/objects/${objectKey}`, { params: { locationId }, token });
  if (!result.ok) {
    throw new Error(`GHL object fields lookup failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const fields = result.data.fields ?? [];
  // GHL returns fieldKey fully-qualified (e.g. "custom_objects.dogs.dogs_name"), but
  // record properties (both read and write) are keyed by the short form ("dogs_name") —
  // confirmed live, a record create using the qualified key 400s with "missing required
  // property". Strip the object-key prefix here so every downstream consumer of a saved
  // dogFieldMap (createDogRecord, dogSummaryFromRecord, vaccineStatusFromRecord) gets a
  // key that actually matches record.properties.
  const prefix = `${objectKey}.`;
  return fields.map((f) => ({
    fieldKey: f.fieldKey.startsWith(prefix) ? f.fieldKey.slice(prefix.length) : f.fieldKey,
    name: f.name,
  }));
}
