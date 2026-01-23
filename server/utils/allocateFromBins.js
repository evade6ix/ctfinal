// server/utils/allocateFromBins.js

/**
 * locations: [{ bin: ObjectId | BinDoc, row: number, quantity: number }]
 * requestedQty: how many the order needs
 *
 * Returns:
 * {
 *   pickedLocations: [same shape as locations but with adjusted quantity],
 *   remainingLocations: [same shape as locations],
 *   unfilled: number
 * }
 */
export function allocateFromBins(locations, requestedQty) {
  // Normalize to plain JS objects so we don't lose fields when spreading
  const locs = Array.isArray(locations)
    ? locations.map((loc) =>
        loc && typeof loc.toObject === "function" ? loc.toObject() : loc
      )
    : [];

  let remainingToFill = Number(requestedQty) || 0;

  // Sort so we prefer bins with higher quantity first
  const sorted = [...locs].sort((a, b) => {
    const qa = Number(a.quantity) || 0;
    const qb = Number(b.quantity) || 0;
    return qb - qa;
  });

  const pickedLocations = [];
  const remainingLocations = [];

  for (const loc of sorted) {
    const available = Number(loc.quantity) || 0;

    if (remainingToFill <= 0) {
      // We've filled everything; keep the rest unchanged
      remainingLocations.push({ ...loc });
      continue;
    }

    if (available <= 0) {
      // Nothing usable here
      remainingLocations.push({ ...loc });
      continue;
    }

    if (available <= remainingToFill) {
      // Use entire location
      pickedLocations.push({
        ...loc,
        quantity: available,
      });
      remainingToFill -= available;
      // nothing left from this location
    } else {
      // Use part of this location
      pickedLocations.push({
        ...loc,
        quantity: remainingToFill,
      });

      remainingLocations.push({
        ...loc,
        quantity: available - remainingToFill,
      });

      remainingToFill = 0;
    }
  }

  return {
    pickedLocations,
    remainingLocations,
    unfilled: remainingToFill,
  };
}
