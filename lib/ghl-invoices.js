// Standalone invoice creation against GHL's Invoices API. Reuses ghlRequest for auth/base URL.
// Used for both the deposit invoice (at booking) and the balance-due invoice (at Check Out).
//
// Every function takes the calling client's own decrypted GHL token — no shared/global
// token anymore, since each business now connects their own GHL account.
//
// We deliberately don't use GHL's "Partial Payment"/"Payment Plans" invoice features —
// those are built for splitting one larger invoice and GHL only auto-drafts (doesn't
// auto-send) the remainder, which is more machinery than we need. Instead each charge
// (deposit, then balance) is its own standalone invoice for a fixed amount.
import { ghlRequest } from './ghl.js';

// Sending an invoice requires attributing it to a staff user. There's no configured
// "system" sender, so we use the location's first active user. Cached per location.
const staffUserIdCache = new Map();

async function getDefaultStaffUserId(locationId, token) {
  if (staffUserIdCache.has(locationId)) return staffUserIdCache.get(locationId);

  const result = await ghlRequest('GET', '/users/', { params: { locationId }, token });
  if (!result.ok) {
    throw new Error(`GHL users lookup failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const user = (result.data.users ?? [])[0];
  if (!user) throw new Error(`No staff users found for location ${locationId}`);

  staffUserIdCache.set(locationId, user.id);
  return user.id;
}

// Creates and sends an invoice for a fixed amount, returning its ID and the hosted
// payment URL. The URL is only available in the send notification body — GHL doesn't
// expose it as a stable field on the invoice record itself (confirmed via their own
// docs: {{invoice.url}} only works in the initial notification) — so we extract it
// from the notification text rather than a clean structured field.
export async function createAndSendInvoice({ locationId, contact, description, amount, token }) {
  const today = new Date().toISOString().slice(0, 10);

  const contactDetails = {
    id: contact.id,
    name: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || 'Customer',
    phoneNo: contact.phone ?? '',
    email: contact.email ?? '',
    additionalEmails: [],
    address: { countryCode: contact.country ?? 'US' },
    customFields: [],
  };

  const locationResult = await ghlRequest('GET', `/locations/${locationId}`, { token });
  const loc = locationResult.data?.location;
  const businessDetails = {
    name: loc?.business?.name ?? loc?.name ?? 'Business',
    phoneNo: loc?.phone ?? '',
    address: {
      addressLine1: loc?.address ?? '',
      city: loc?.city ?? '',
      state: loc?.state ?? '',
      countryCode: loc?.country ?? 'US',
      postalCode: loc?.postalCode ?? '',
    },
  };

  const createResult = await ghlRequest('POST', '/invoices/', {
    body: {
      altId: locationId,
      altType: 'location',
      name: description,
      currency: 'USD',
      issueDate: today,
      contactDetails,
      businessDetails,
      items: [{ name: description, description: '', qty: 1, amount, currency: 'USD', taxes: [], taxInclusive: false }],
    },
    token,
  });
  if (!createResult.ok) {
    throw new Error(`GHL invoice create failed: ${createResult.status} ${JSON.stringify(createResult.data)}`);
  }
  const invoiceId = createResult.data?.invoice?.id ?? createResult.data?._id ?? createResult.data?.id;

  const userId = await getDefaultStaffUserId(locationId, token);
  const sendResult = await ghlRequest('POST', `/invoices/${invoiceId}/send`, {
    body: { altId: locationId, altType: 'location', action: 'email', liveMode: true, userId },
    token,
  });
  if (!sendResult.ok) {
    throw new Error(`GHL invoice send failed: ${sendResult.status} ${JSON.stringify(sendResult.data)}`);
  }

  const notificationBody = sendResult.data?.emailData?.message?.body ?? '';
  const urlMatch = notificationBody.match(/https?:\/\/\S+/);
  const paymentUrl = urlMatch ? urlMatch[0].replace(/[\]\)]+$/, '') : null;

  return { invoiceId, paymentUrl };
}

// Checks live payment status — never cached, since this gates booking creation.
export async function getInvoiceStatus(invoiceId, locationId, token) {
  const result = await ghlRequest('GET', `/invoices/${invoiceId}`, {
    params: { altId: locationId, altType: 'location' },
    token,
  });
  if (!result.ok) {
    throw new Error(`GHL invoice status check failed: ${result.status} ${JSON.stringify(result.data)}`);
  }
  const invoice = result.data;
  return {
    status: invoice.status,
    amountDue: invoice.amountDue,
    amountPaid: invoice.amountPaid,
    paid: invoice.status === 'paid' || invoice.amountDue <= 0,
  };
}
