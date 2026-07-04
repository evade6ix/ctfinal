import { buildMarketUrl } from "./marketUrl";
import type { CatalogCardCondition } from "./cardConditionMap";

export function getMarketPriceUrl(args: {
  blueprintId: string | number;
  condition: CatalogCardCondition;
  foil: boolean;
}) {
  return buildMarketUrl(args);
}
