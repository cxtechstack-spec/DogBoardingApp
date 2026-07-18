// Staff SMS notifications via GHL's Conversations API. Confirmed live
// (2026-07-18) that sending requires an existing contactId — there's no way
// to text a raw phone number directly — so we upsert a GHL contact for the
// staff phone first (same idempotent upsert used for booking owners) and
// message that contact.
import { ghlRequest } from './ghl.js';
import { upsertContact } from './ghl-contacts.js';

export async function notifyStaff({ locationId, staffName, staffPhone, message, token }) {
  const contact = await upsertContact({ locationId, phone: staffPhone, firstName: staffName, token });

  const result = await ghlRequest('POST', '/conversations/messages', {
    body: { type: 'SMS', contactId: contact.id, message },
    token,
  });
  if (!result.ok) {
    throw new Error(`GHL SMS send failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  return result.data;
}
