// Checks remaining capacity for a date range against a CapacityPool, accounting
// for every service that draws from the same pool (not just the one being booked).
import db from './db.js';

const ACTIVE_STATUSES = ['CONFIRMED', 'ACTIVE'];

function datesInRange(start, end) {
  const dates = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= last) {
    dates.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// Returns { available: true } or { available: false, blockedDate: 'YYYY-MM-DD' }
// for the first day in the range that's already at capacity.
export async function checkPoolAvailability({ capacityPoolId, startDate, endDate }) {
  const pool = await db.capacityPool.findUnique({ where: { id: capacityPoolId } });
  if (!pool) throw new Error('Capacity pool not found');

  const sharedServices = await db.serviceSettings.findMany({
    where: { capacityPoolId },
    select: { serviceType: true },
  });
  const serviceTypes = sharedServices.map(s => s.serviceType);

  const start = new Date(startDate);
  const end = new Date(endDate);

  const overlapping = await db.booking.findMany({
    where: {
      clientId: pool.clientId,
      serviceType: { in: serviceTypes },
      status: { in: ACTIVE_STATUSES },
      startDate: { lte: end },
      endDate: { gte: start },
    },
    select: { startDate: true, endDate: true },
  });

  for (const day of datesInRange(start, end)) {
    const usedOnDay = overlapping.filter(b => b.startDate <= day && b.endDate >= day).length;
    if (usedOnDay >= pool.totalCapacity) {
      return { available: false, blockedDate: day.toISOString().slice(0, 10) };
    }
  }

  return { available: true };
}
