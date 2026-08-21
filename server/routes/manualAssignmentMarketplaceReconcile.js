import express from "express";
import { syncInventoryItemIdsToCardTrader } from "../services/cardtraderInventorySync.js";

const router = express.Router();

function summarizeManaPoolSyncs(syncs) {
  const list = Array.isArray(syncs) ? syncs : [];
  return {
    attempted: list.length,
    succeeded: list.filter((sync) => sync?.ok === true).length,
    failed: list.filter((sync) => sync?.ok !== true).length,
  };
}

function summarizeCardTraderSyncs(syncs) {
  const list = Array.isArray(syncs) ? syncs : [];
  return {
    attempted: list.length,
    succeeded: list.filter((sync) => sync?.ok === true).length,
    failed: list.filter((sync) => sync?.ok !== true).length,
    updated: list.filter((sync) => sync?.updated === true).length,
    alreadyCorrect: list.filter(
      (sync) => sync?.ok === true && sync?.updated === false
    ).length,
  };
}

// Wrap the existing manual-assignment handlers. They still own the Mongo
// allocation, physical inventory deduction, stale-record cleanup and ManaPool
// sync. This middleware waits for their successful response, then verifies the
// final Mongo quantity against CardTrader and updates CardTrader only when the
// listing differs.
router.post("/:allocationId/assign", (req, res, next) => {
  const originalJson = res.json.bind(res);
  let handled = false;

  res.json = function reconciledJson(body) {
    const updatedInventoryItems = Array.isArray(body?.updatedInventoryItems)
      ? body.updatedInventoryItems
      : [];

    if (
      handled ||
      body?.ok !== true ||
      body?.type === "already_allocated" ||
      updatedInventoryItems.length === 0
    ) {
      return originalJson(body);
    }

    handled = true;
    const inventoryItemIds = [
      ...new Set(
        updatedInventoryItems
          .map((item) => item?.inventoryItemId)
          .filter(Boolean)
          .map(String)
      ),
    ];

    Promise.resolve(
      syncInventoryItemIdsToCardTrader(inventoryItemIds, {
        source: "manual_card_list_assignment",
        allocationId: req.params.allocationId,
        orderId: body?.orderId || null,
        orderItemId: body?.orderItemId || null,
        requestedQuantity: body?.requestedQuantity || null,
      })
    )
      .then((cardTraderSyncs) => {
        const manaPoolSummary = summarizeManaPoolSyncs(body?.manaPoolSyncs);
        const cardTraderSummary = summarizeCardTraderSyncs(cardTraderSyncs);

        return originalJson({
          ...body,
          cardTraderSyncs,
          marketplaceReconciliation: {
            ok:
              manaPoolSummary.failed === 0 &&
              cardTraderSummary.failed === 0,
            mongoQuantitySourceOfTruth: true,
            manaPool: manaPoolSummary,
            cardTrader: cardTraderSummary,
          },
        });
      })
      .catch((error) => {
        console.error("❌ Manual assignment CardTrader reconciliation failed", {
          allocationId: req.params.allocationId,
          inventoryItemIds,
          error: error?.message || String(error),
        });

        const cardTraderSyncs = [
          {
            ok: false,
            checked: false,
            updated: false,
            error: error?.message || String(error),
          },
        ];
        const manaPoolSummary = summarizeManaPoolSyncs(body?.manaPoolSyncs);

        return originalJson({
          ...body,
          cardTraderSyncs,
          marketplaceReconciliation: {
            ok: false,
            mongoQuantitySourceOfTruth: true,
            manaPool: manaPoolSummary,
            cardTrader: summarizeCardTraderSyncs(cardTraderSyncs),
          },
        });
      });

    return res;
  };

  return next();
});

export default router;
