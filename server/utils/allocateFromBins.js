// server/utils/allocateFromBins.js

/**
 * locations: [{ bin: ObjectId or populated object, row: number, quantity: number }]
 * requestedQty: number (how many the order needs)
 */
export function allocateFromBins(locations, requestedQty) {
  let remainingToFill = requestedQty;

  // Clone so we don't mutate the original directly
  const sorted = [...locations].sort((a, b) => {
    // strategy: prefer higher quantity first
    return (b.quantity || 0) - (a.quantity || 0);
  });

  const pickedLocations = [];
  const remainingLocations = [];

  for (const loc of sorted) {
    if (remainingToFill <= 0) {
      // we've already filled everything; keep the rest as-is
      remainingLocations.push({ ...loc });
      continue;
    }

    const available = loc.quantity || 0;

    if (available <= 0) {
      // nothing useful here
      remainingLocations.push({ ...loc });
      continue;
    }

    if (available <= remainingToFill) {
      // use entire location
      pickedLocations.push({
        ...loc,
        quantity: available,
      });
      remainingToFill -= available;
      // nothing left from this location, so we don't push it to remainingLocations
    } else {
      // we only need part of this location
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
    unfilled: remainingToFill, // >0 if you didn't have enough stock
  };
}
