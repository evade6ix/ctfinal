import { mapCatalogCardCondition, type CatalogCardCondition } from "./cardConditionMap";

export function buildMarketUrl(args: {
  blueprintId: string | number;
  condition: CatalogCardCondition;
  foil: boolean;
}) {
  const params = new URLSearchParams({
    blueprint_id: String(args.blueprintId),
    condition: mapCatalogCardCondition(args.condition),
    foil: args.foil ? "true" : "false",
    language: "en",
  });

  return `/api/catalog/market?${params.toString()}`;
}
