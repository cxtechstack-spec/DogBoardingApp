// Pushes a confirmed booking onto the business's own connected Google
// Calendar — entirely optional per business (see Client.googleAccessTokenEncrypted).
// One-way only (app -> Google) and fire-and-forget: called from
// PUT /:id/confirm in routes/bookings.js after the response is already sent,
// so a Google failure never blocks or fails a booking confirmation.
import db from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { getDogRecord, getContact, dogSummaryFromRecord, buildDogFieldMap } from './ghl-contacts.js';
import { getValidAccessToken, createCalendarEvent, deleteCalendarEvent } from './google-calendar.js';

const SERVICE_LABELS = { BOARDING: 'Boarding', DAY_CARE: 'Day Care', DAY_TRAINING: 'Board and Train' };

// Combines a pure calendar date (UTC-midnight, no time-of-day meaning — see
// prisma/schema.prisma) with an "HH:MM" wall-clock time into the naive
// datetime string Google's API expects when paired with a separate timeZone
// field (no offset/'Z' suffix — that's what tells Google it's local time in
// that zone, not UTC).
function localDateTime(date, hhmm) {
  return `${date.toISOString().slice(0, 10)}T${hhmm}:00`;
}

function getClientAccessToken(client) {
  return getValidAccessToken({
    accessToken: decrypt(client.googleAccessTokenEncrypted),
    refreshToken: decrypt(client.googleRefreshTokenEncrypted),
    expiry: client.googleTokenExpiry,
    onRefreshed: async ({ accessToken: newAccessToken, expiry }) => {
      await db.client.update({
        where: { id: client.id },
        data: { googleAccessTokenEncrypted: encrypt(newAccessToken), googleTokenExpiry: expiry },
      });
    },
  });
}

export async function syncBookingToGoogleCalendar({ client, booking, locationId, token }) {
  if (!client.googleAccessTokenEncrypted || !client.googleRefreshTokenEncrypted || !client.timeZone) return;
  if (!booking.dropOffTime || !booking.pickUpTime) {
    console.warn(`Google Calendar sync skipped for booking ${booking.id}: missing dropOffTime/pickUpTime`);
    return;
  }

  const dogFieldMap = buildDogFieldMap(client);
  const [dogRecord, contact] = await Promise.all([
    dogFieldMap.objectKey ? getDogRecord(booking.ghlDogObjectId, dogFieldMap.objectKey, token) : null,
    getContact(booking.ghlOwnerContactId, token),
  ]);
  const dogName = dogRecord ? dogSummaryFromRecord(dogRecord, dogFieldMap).name : null;
  const ownerName = contact ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() : null;
  const serviceLabel = SERVICE_LABELS[booking.serviceType] || booking.serviceType;

  const summary = `${dogName || 'Dog'} (${serviceLabel})${ownerName ? ` — ${ownerName}` : ''}`;
  const description = [
    `Dog: ${dogName || 'Unknown'}`,
    `Owner: ${ownerName || 'Unknown'}${contact?.phone ? ` (${contact.phone})` : ''}`,
    `Drop-off: ${booking.dropOffTime}`,
    `Pick-up: ${booking.pickUpTime}`,
  ].join('\n');

  const accessToken = await getClientAccessToken(client);

  const event = await createCalendarEvent({
    accessToken,
    summary,
    description,
    startDateTime: localDateTime(booking.startDate, booking.dropOffTime),
    endDateTime: localDateTime(booking.endDate, booking.pickUpTime),
    timeZone: client.timeZone,
  });

  await db.booking.update({ where: { id: booking.id }, data: { googleEventId: event.id } });
}

// Called from PUT /:id/cancel — same fire-and-forget contract as the sync above.
export async function removeBookingFromGoogleCalendar({ client, booking }) {
  if (!booking.googleEventId || !client.googleAccessTokenEncrypted || !client.googleRefreshTokenEncrypted) return;
  const accessToken = await getClientAccessToken(client);
  await deleteCalendarEvent({ accessToken, eventId: booking.googleEventId });
  await db.booking.update({ where: { id: booking.id }, data: { googleEventId: null } });
}
