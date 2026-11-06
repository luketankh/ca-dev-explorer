import { NAIP_YEARS } from "./config";

const PC = "https://planetarycomputer.microsoft.com/api/data/v1";
const cache = new Map<number, Promise<string>>();

/** Most recent NAIP vintage at or before `year` (falls back to the earliest one). */
export function naipYearFor(year: number): number {
  const prior = NAIP_YEARS.filter((y) => y <= year);
  return prior.length ? prior[prior.length - 1] : NAIP_YEARS[0];
}

/**
 * Register a Planetary Computer mosaic for one NAIP year in California and return an XYZ
 * tile URL template. Registration is cached per year.
 */
export function naipTileUrl(year: number): Promise<string> {
  if (!cache.has(year)) {
    cache.set(
      year,
      fetch(`${PC}/mosaic/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collections: ["naip"],
          "filter-lang": "cql2-json",
          filter: {
            op: "and",
            args: [
              { op: "=", args: [{ property: "naip:state" }, "ca"] },
              { op: "=", args: [{ property: "naip:year" }, String(year)] },
            ],
          },
        }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`NAIP mosaic registration failed (${r.status})`);
          return r.json();
        })
        .then(
          (d: { searchid: string }) =>
            `${PC}/mosaic/${d.searchid}/tiles/WebMercatorQuad/{z}/{x}/{y}@1x` +
            `?collection=naip&assets=image&asset_bidx=image%7C1%2C2%2C3&format=jpg`,
        )
        .catch((e) => {
          cache.delete(year);
          throw e;
        }),
    );
  }
  return cache.get(year)!;
}
