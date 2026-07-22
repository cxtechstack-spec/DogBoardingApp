// Computes the authoritative price for a booking server-side — never trust a
// client-submitted amount for anything that becomes a real invoice/charge.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// NIGHT billing counts nights stayed (checkout day isn't a night); DAY billing counts inclusive days.
// Also used to scale the per-day add-on cap to the length of the stay (see
// routes/bookings.js's validateBookingRequest) — a 5-night stay wanting one
// dock-diving session per day is 5 total, not capped at one flat per-stay number.
export function countUnits(startDate, endDate, billingUnit) {
  const dayDiff = Math.round((new Date(endDate) - new Date(startDate)) / MS_PER_DAY);
  return Math.max(1, billingUnit === 'NIGHT' ? dayDiff : dayDiff + 1);
}

// Recomputes the full stay cost from a booking's own locked-in snapshot
// (lockedRate + addOnsSelected) rather than current settings, so a rate change
// after booking doesn't silently change what's owed at check-out. Uses the
// booking's actual check-in/check-out dates when available (falling back to
// the originally booked dates otherwise — e.g. at Confirm time, before either
// has happened yet) so an extended or early-ended stay is billed for what
// actually happened, not what was originally booked.
export function computeStayTotalFromBooking(booking, service) {
  const start = booking.actualStartDate ?? booking.startDate;
  const end = booking.actualEndDate ?? booking.endDate;
  const units = countUnits(start, end, service.billingUnit);
  const serviceCost = booking.lockedRate * units;

  const addOns = typeof booking.addOnsSelected === 'string' ? JSON.parse(booking.addOnsSelected) : booking.addOnsSelected;
  const addOnCost = addOns.reduce((sum, a) => sum + a.price * a.qty, 0);

  return Math.round((serviceCost + addOnCost) * 100) / 100;
}

// Computes the deposit due for an already-created booking, from its own
// locked-in stay cost — used at Confirm time (not at request time) so a
// denied booking was never charged anything to begin with. Deposit
// type/value themselves aren't locked at request time (only the base rate
// is), so this reflects the service's current deposit policy, not whatever
// was quoted at request time.
export function computeDepositFromBooking(booking, service) {
  const stayTotal = computeStayTotalFromBooking(booking, service);
  let deposit = 0;
  if (service.depositType === 'PERCENT') deposit = stayTotal * (service.depositValue / 100);
  if (service.depositType === 'FLAT') deposit = service.depositValue;
  return Math.round(deposit * 100) / 100;
}
