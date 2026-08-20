import type { Context } from "@netlify/functions";

const EPC_API_BASE = "https://api.get-energy-performance-data.communities.gov.uk";

interface SearchResult {
  address: string;
  certificateNumber: string;
  postcode: string;
}

interface EpcCertificate {
  epcRating: string;
  score: number;
  potentialRating: string;
  potentialScore: number;
  certDate: string;
  expiryDate: string;
  certNumber: string;
  propertyType: string;
  address: string;
  certificateNumber: string;
  lookupTimestamp: string;
  source: string;
  epcEvidenceStatus: "Verified" | "Not found" | "Not checked";
  failureReason?: string;
  officialCertUrl: string;
  recommendations: string[];
  // ACT-633: comparator enrichment fields
  postcode?: string;
  floorAreaSqm?: number | null;
  builtForm?: string;
}

// ACT-633: comparator types
interface ComparableSale {
  address: string;
  soldPrice: number;
  soldDate: string;
  floorAreaSqm: number | null;
  pricePerSqm: number | null;
  matchConfidence: string;
}

interface ComparatorResult {
  evidenceStrength: "Strong" | "Moderate" | "Limited" | "Insufficient";
  selectedCount: number;
  evidenceCount: number;
  medianSoldPricePerSqm: number | null;
  impliedValue: number | null;
  impliedValueLow: number | null;
  impliedValueHigh: number | null;
  askingPricePerSqm: number | null;
  premiumDiscountPct: number | null;
  newestSaleDate: string | null;
  oldestSaleDate: string | null;
  geographyUsed: string | null;
  timeWindowMonths: number | null;
  comparables: ComparableSale[];
  relaxationNotes: string[];
}

type ComparatorAvailability =
  | { available: true; result: ComparatorResult }
  | { available: false; reason: "temporarily_unavailable" | "insufficient_subject_data" | "unmapped_property_type" };

function isMockMode(token: string | undefined): boolean {
  return !token || token === "mock";
}

function getMockAddresses(postcode: string): SearchResult[] {
  const pc = postcode.toUpperCase().replace(/\s+/g, " ");
  return [
    { address: `Flat 1, 12 Example Street, ${pc}`, certificateNumber: "0000-0000-0000-0000-0001", postcode: pc },
    { address: `Flat 2, 12 Example Street, ${pc}`, certificateNumber: "0000-0000-0000-0000-0002", postcode: pc },
    { address: `14 Example Street, ${pc}`, certificateNumber: "0000-0000-0000-0000-0003", postcode: pc },
  ];
}

function getMockCertificate(certificateNumber: string): EpcCertificate {
  const ratings = ["A", "B", "C", "D", "E", "F", "G"];
  const idx = parseInt(certificateNumber.slice(-1)) % ratings.length;
  const rating = ratings[idx];
  const scores: Record<string, number> = { A: 92, B: 82, C: 72, D: 60, E: 45, F: 30, G: 15 };
  return {
    epcRating: rating,
    score: scores[rating] || 60,
    potentialRating: rating === "A" ? "A" : ratings[Math.max(0, idx - 1)],
    potentialScore: Math.min(100, (scores[rating] || 60) + 12),
    certDate: "2022-06-15",
    expiryDate: "2032-06-14",
    certNumber: certificateNumber,
    propertyType: "Flat",
    address: `Mock Property, ${certificateNumber}`,
    certificateNumber,
    lookupTimestamp: new Date().toISOString(),
    source: "mock",
    epcEvidenceStatus: "Verified",
    officialCertUrl: `https://find-energy-certificate.service.gov.uk/energy-certificate/${certificateNumber}`,
    recommendations: [
      "Add loft insulation",
      "Install a more efficient boiler",
      "Upgrade to double glazing",
    ],
    postcode: "AL10 0FR",
    floorAreaSqm: 82,
    builtForm: "Mid-Terrace",
  };
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
    await new Promise((r) => setTimeout(r, backoff));
    lastError = new Error("Rate limited by EPC API");
  }
  throw lastError ?? new Error("Max retries exceeded");
}

async function searchAddresses(
  postcode: string,
  token: string
): Promise<SearchResult[]> {
  const url = `${EPC_API_BASE}/api/domestic/search?postcode=${encodeURIComponent(postcode)}&page_size=20`;
  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (res.status === 404) {
    return [];
  }

  if (!res.ok) {
    throw new Error(`EPC API error: ${res.status}`);
  }

  const json = await res.json();
  const rows = json?.data ?? [];

  return rows.map((row: any) => {
    const addressParts = [
      row.addressLine1,
      row.addressLine2,
      row.addressLine3,
      row.addressLine4,
      row.postTown,
    ].filter(Boolean);
    return {
      address: addressParts.join(", "),
      certificateNumber: row.certificateNumber,
      postcode: row.postcode ?? postcode,
    };
  });
}

async function fetchCertificate(
  certificateNumber: string,
  token: string
): Promise<EpcCertificate> {
  const url = `${EPC_API_BASE}/api/certificate?certificate_number=${encodeURIComponent(certificateNumber)}`;
  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (res.status === 404) {
    return {
      epcRating: "Unknown",
      score: 0,
      potentialRating: "Unknown",
      potentialScore: 0,
      certDate: "",
      expiryDate: "",
      certNumber: "",
      propertyType: "",
      address: "",
      certificateNumber,
      lookupTimestamp: new Date().toISOString(),
      source: "live",
      epcEvidenceStatus: "Not found",
      failureReason: "No EPC certificate found for this property",
      officialCertUrl: "",
      recommendations: [],
    };
  }

  if (!res.ok) {
    throw new Error(`EPC API error: ${res.status}`);
  }

  const json = await res.json();
  const d = json?.data;
  if (!d) throw new Error("No data returned from EPC API");

  const get = (...keys: string[]) => {
    for (const k of keys) {
      if (d[k] !== undefined && d[k] !== null) return d[k];
    }
    return undefined;
  };

  const regDate = get("registration_date", "lodgement_date") ?? "";
  const explicitExpiry = get("expiry_date");
  const expiryDate = explicitExpiry
    ? String(explicitExpiry).slice(0, 10)
    : regDate
    ? new Date(new Date(regDate).getTime() + 10 * 365.25 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10)
    : "";

  const addressParts = [
    get("address_line_1", "addressLine1"),
    get("address_line_2", "addressLine2"),
    get("address_line_3", "addressLine3"),
    get("post_town", "postTown"),
  ].filter(Boolean);

  // ACT-633: capture postcode, floor area and built form for comparator enrichment
  const postcodeRaw = get("postcode");
  const floorAreaRaw = get("total_floor_area", "totalFloorArea");
  const floorAreaSqm =
    floorAreaRaw !== undefined && floorAreaRaw !== null && floorAreaRaw !== ""
      ? Number(floorAreaRaw)
      : null;
  const builtForm = get("built_form", "builtForm") ?? "";

  return {
    epcRating: get("current_energy_efficiency_band", "currentEnergyEfficiencyBand") ?? "Unknown",
    score: parseInt(get("current_energy_efficiency", "currentEnergyEfficiency")) || 0,
    potentialRating: get("potential_energy_efficiency_band", "potentialEnergyEfficiencyBand") ?? "Unknown",
    potentialScore: parseInt(get("potential_energy_efficiency", "potentialEnergyEfficiency")) || 0,
    certDate: regDate,
    expiryDate,
    certNumber: get("certificate_number", "certificateNumber") ?? certificateNumber,
    propertyType: get("property_type", "propertyType") ?? "",
    address: addressParts.join(", "),
    certificateNumber: get("certificate_number", "certificateNumber") ?? certificateNumber,
    lookupTimestamp: new Date().toISOString(),
    source: "live",
    epcEvidenceStatus: "Verified",
    officialCertUrl: `https://find-energy-certificate.service.gov.uk/energy-certificate/${certificateNumber}`,
    recommendations: [],
    postcode: postcodeRaw ?? undefined,
    floorAreaSqm: Number.isFinite(floorAreaSqm as number) ? floorAreaSqm : null,
    builtForm,
  };
}

function rejectOutOfScope(postcode: string): boolean {
  // Scotland: starts with EH, G, KA, KY, DD, PH, AB, IV, KW, HS, ZE, PA, ML, FK, TD, DG, KA
  // Northern Ireland: starts with BT
  const outOfScope = /^(BT|AB|DF|DG|EH|FK|G[0-9]|HS|IV|KA|KW|KY|ML|PA|PH|TD|ZE)/i;
  return outOfScope.test(postcode.trim());
}

// ACT-633: server-side comparator helper.
// Calls the authenticated Supabase Edge Function; never exposes the Supabase
// key or any HMLR/EPC database access to the browser. Comparator failure
// must never break the underlying EPC lookup.
async function fetchComparables(params: {
  postcode?: string;
  epcPropertyType?: string;
  epcBuiltForm?: string;
  floorAreaSqm?: number | null;
  askingPrice?: number | null;
}): Promise<ComparatorAvailability> {
  const supabaseUrl = Netlify.env.get("PK_COMPARATOR_SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("PK_COMPARATOR_SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return { available: false, reason: "temporarily_unavailable" };
  }

  const postcode = (params.postcode ?? "").trim();
  const floorArea = params.floorAreaSqm;

  if (!postcode || !floorArea || floorArea <= 0) {
    return { available: false, reason: "insufficient_subject_data" };
  }

  if (!params.epcPropertyType) {
    return { available: false, reason: "unmapped_property_type" };
  }

  try {
    const res = await fetchWithRetry(
      `${supabaseUrl}/functions/v1/property-comparables`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseAnonKey}`,
          apikey: supabaseAnonKey,
        },
        body: JSON.stringify({
          postcode,
          epc_property_type: params.epcPropertyType,
          epc_built_form: params.epcBuiltForm ?? null,
          floor_area_sqm: floorArea,
          asking_price: params.askingPrice ?? null,
          target_count: 5,
        }),
      },
      2 // comparator failures must not hold up the EPC result; fewer retries
    );

    if (!res.ok) {
      return { available: false, reason: "temporarily_unavailable" };
    }

    const json = await res.json();
    if (!json || typeof json !== "object" || !json.result) {
      return { available: false, reason: "temporarily_unavailable" };
    }

    return { available: true, result: json.result as ComparatorResult };
  } catch {
    // Never let a comparator failure surface database errors, stack traces
    // or connectivity details to the client.
    return { available: false, reason: "temporarily_unavailable" };
  }
}

export default async function handler(
  req: Request,
  context: Context
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const token = Netlify.env.get("EPC_API_TOKEN");
  const mock = isMockMode(token);

  let body: {
    op: string;
    postcode?: string;
    certificateNumber: string;
    askingPrice?: number;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (body.op === "search") {
      const postcode = (body.postcode ?? "").trim().toUpperCase();
      if (!postcode) {
        return new Response(
          JSON.stringify({ error: "postcode is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      if (rejectOutOfScope(postcode)) {
        return new Response(
          JSON.stringify({
            error: "out_of_scope",
            message:
              "The EPC Checker only covers England and Wales. Scotland and Northern Ireland are not currently supported.",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } }
        );
      }

      const results = mock
        ? getMockAddresses(postcode)
        : await searchAddresses(postcode, token!);

      return new Response(JSON.stringify({ addresses: results, mock }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.op === "certificate") {
      const certificateNumber = (body.certificateNumber ?? "").trim();
      if (!certificateNumber) {
        return new Response(
          JSON.stringify({ error: "certificateNumber is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const cert = mock
        ? getMockCertificate(certificateNumber)
        : await fetchCertificate(certificateNumber, token!);

      // ACT-633: attach comparator evidence. A comparator failure must never
      // break the EPC result — always return the EPC data; comparables is
      // its own independent, gracefully-degrading field.
      let comparables: ComparatorAvailability = {
        available: false,
        reason: "insufficient_subject_data",
      };

      if (cert.epcEvidenceStatus === "Verified") {
        const epcPropertyType = mapEpcPropertyTypeToHmlr(cert.propertyType);
        comparables = await fetchComparables({
          postcode: cert.postcode,
          epcPropertyType,
          epcBuiltForm: cert.builtForm,
          floorAreaSqm: cert.floorAreaSqm ?? null,
          askingPrice: null,
        });
      }

      return new Response(
        JSON.stringify({ certificate: cert, comparables, mock }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // ACT-633: optional standalone asking-price recalculation. Never calls
    // Supabase from the browser — always routes through this server function.
    if (body.op === "comparables") {
      const postcode = (body.postcode ?? "").trim();
      const askingPrice =
        typeof body.askingPrice === "number" && body.askingPrice > 0
          ? body.askingPrice
          : null;

      // These fields are supplied by the frontend from the already-fetched
      // certificate response, not re-derived from EPC address data.
      const epcPropertyType = (body as any).epcPropertyType as string | undefined;
      const epcBuiltForm = (body as any).epcBuiltForm as string | undefined;
      const floorAreaSqm = (body as any).floorAreaSqm as number | undefined;

      const comparables = await fetchComparables({
        postcode,
        epcPropertyType: epcPropertyType
          ? mapEpcPropertyTypeToHmlr(epcPropertyType)
          : undefined,
        epcBuiltForm,
        floorAreaSqm: floorAreaSqm ?? null,
        askingPrice,
      });

      return new Response(JSON.stringify({ comparables }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown op" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ACT-633: map EPC-native property type + built form to HMLR D/S/T/F/O.
// Mapping logic stays server-side only, per the governing spec.
function mapEpcPropertyTypeToHmlr(epcPropertyType: string | undefined): string | undefined {
  if (!epcPropertyType) return undefined;
  const t = epcPropertyType.trim().toLowerCase();
  if (t.includes("flat") || t.includes("maisonette")) return "F";
  if (t.includes("detached") && !t.includes("semi")) return "D";
  if (t.includes("semi-detached") || t.includes("semi detached")) return "S";
  if (t.includes("terrace")) return "T";
  return undefined; // unmapped types are excluded from the comparator, not guessed
}
