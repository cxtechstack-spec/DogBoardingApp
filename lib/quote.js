// Computes the authoritative price for a booking server-side — never trust a
// client-submitted amount for anything that becomes a real invoice/charge.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// NIGHT billing counts nights stayed (checkout day isn't a night); DAY billing counts inclusive days.
function countUnits(startDate, endDate, billingUnit) {
  const dayDiff = Math.round((new Date(endDate) - new Date(startDate)) / MS_PER_DAY);
  return Math.max(1, billingUnit === 'NIGHT' ? dayDiff : dayDiff + 1);
}

export function computeBookingQuote({ service, startDate, endDate, addOnsSelected, addOns }) {
  const units = countUnits(startDate, endDate, service.billingUnit);
  const serviceCost = service.baseRate * units;

  const addOnLines = (addOnsSelected ?? []).map(({ addOnId, qty }) => {
    const addOn = addOns.find((a) => a.id === addOnId);
    if (!addOn) throw new Error(`Unknown add-on: ${addOnId}`);
    const lineQty = parseInt(qty) || 1;
    return { addOnId: addOn.id, name: addOn.name, price: addOn.price, qty: lineQty, lineTotal: addOn.price * lineQty };
  });
  const addOnCost = addOnLines.reduce((sum, l) => sum + l.lineTotal, 0);

  const subtotal = serviceCost + addOnCost;

  let deposit = 0;
  if (service.depositType === 'PERCENT') deposit = subtotal * (service.depositValue / 100);
  if (service.depositType === 'FLAT') deposit = service.depositValue;

  return { units, serviceCost, addOnLines, addOnCost, subtotal, deposit: Math.round(deposit * 100) / 100 };
}

// Recomputes the full stay cost from a booking's own locked-in snapshot
// (lockedRate + addOnsSelected) rather than current settings, so a rate change
// after booking doesn't silently change what's owed at check-out.
export function computeStayTotalFromBooking(booking, service) {
  const units = countUnits(booking.startDate, booking.endDate, service.billingUnit);
  const serviceCost = booking.lockedRate * units;

  const addOns = typeof booking.addOnsSelected === 'string' ? JSON.parse(booking.addOnsSelected) : booking.addOnsSelected;
  const addOnCost = addOns.reduce((sum, a) => sum + a.price * a.qty, 0);

  return Math.round((serviceCost + addOnCost) * 100) / 100;
}
