export type CatalogCardCondition = "NM" | "LP" | "MP" | "HP";

export function mapCatalogCardCondition(value: CatalogCardCondition) {
  const map: Record<CatalogCardCondition, string> = {
    NM: "Near Mint",
    LP: "Slightly Played",
    MP: "Moderately Played",
    HP: "Heavily Played",
  };

  return map[value] || map.NM;
}
