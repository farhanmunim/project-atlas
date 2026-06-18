/**
 * sources/postcodes.js — postcodes.io bulk geocoder (free, open, no key).
 * POST up to 100 postcodes → { [postcode]: {lat,lng} }. Used to place garages.
 */
import { getJson } from "../lib/http.js";

export async function geocode(postcodes) {
  const out = {};
  const uniq = [...new Set(postcodes.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const batch = uniq.slice(i, i + 100);
    const res = await fetch("https://api.postcodes.io/postcodes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postcodes: batch }),
    });
    if (!res.ok) throw new Error("postcodes.io HTTP " + res.status);
    const j = await res.json();
    for (const r of j.result || []) {
      if (r.result && typeof r.result.latitude === "number") out[r.query] = { lat: r.result.latitude, lng: r.result.longitude };
    }
  }
  return out;
}
