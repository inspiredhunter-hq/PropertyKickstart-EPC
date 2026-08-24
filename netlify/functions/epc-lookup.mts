import type { Context } from "@netlify/functions";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchRequest {
  op: "search";
  postcode: string;
}

interface CertificateRequest {
  op: "certificate";
  uprn?: string;
  address?: string;
  postcode?: string;
}

type EpcRequest = SearchRequest | CertificateRequest;

interface EpcAddress {
  uprn: string;
  address: string;
  postcode: string;
}

interface EpcRecommendation {
  improvement: string;
  indicativeCost?: string;
  typicalSaving?: string;
}

interface EpcCertificate {
  uprn: string;
  address: string;
  postcode: string;
  epcRating: string;
  score: number | null;
  potentialRating: string | null;
  potentialScore: number | null;
  certDate: string | null;
  expiryDate: string | null;
  certNumber: string | null;
  propertyType: string | null;
  builtForm: string | null;
  totalFloorArea: number | null;
  floorLevel: string | null;
  heatingType: string | null;
  hotWaterDescription: string | null;
  wallsDescription: string | null;
  roofDescription: string | null;
  windowsDescription: string | null;
  recommendations: EpcRecommendation[];
  isExpired: boolean;
  isHistorical: boolean;
  lookupTimestamp: string;
  source: string;
  epcEvidenceStatus: "Verified" | "Not found" | "Not checked";
  failureReason?: string;
  officialCertUrl: string | null;
}

interface ServiceResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MHCLG_BASE = "https://epc.opendatacommunities.org/api/v1";
const ALLOWED_ORIGINS = [
  "https://epc.propertykickstart.co.uk",
  "http://localhost:8888",
  "http://localhost:3000",
];

// Scottish/NI/Channel Islands/Isle of Man/overseas postcode prefixes to reject
const NON_ENGLAND_WALES_PREFIXES = [
  // Scotland
  "AB", "DD", "DG", "EH", "FK", "G", "HS", "IV", "KA", "KW", "KY",
  "ML", "PA", "PH", "TD", "ZE",
  // Northern Ireland
  "BT",
  // Channel Islands / Isle of Man (not in EPC register)
  "GY", "JE", "IM",
];

// Fetch timeout
const FETCH_TIMEOUT_MS = 10_000;

// ─── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_ADDRESSES: EpcAddress[] = [
  {
    uprn: "100023336956",
    address: "10 Downing Street, London",
    postcode: "SW1A 2AA",
  },
  {
    uprn: "100023336957",
    address: "11 Downing Street, London",
    postcode: "SW1A 2AB",
  },
  {
    uprn: "100023336958",
    address: "12 Downing Street, London",
    postcode: "SW1A 2AC",
  },
];

const MOCK_CERTIFICATE: EpcCertificate = {
  uprn: "100023336956",
  address: "10 Downing Street, London",
  postcode: "SW1A 2AA",
  epcRating: "D",
  score: 62,
  potentialRating: "B",
  potentialScore: 84,
  certDate: "2022-03-15",
  expiryDate: "2032-03-14",
  certNumber: "0000-0000-0000-0000-0001",
  propertyType: "Mid-terrace house",
  builtForm: "Mid-Terrace",
  totalFloorArea: 145,
  floorLevel: null,
  heatingType: "Gas boiler",
  hotWaterDescription: "From main system",
  wallsDescription: "Solid brick, no insulation (assumed)",
  roofDescription: "Pitched, 100 mm loft insulation",
  windowsDescription: "Mostly double glazing",
  recommendations: [
    {
      improvement: "Add loft insulation",
      indicativeCost: "£300–£500",
      typicalSaving: "£150 per year",
    },
    {
      improvement: "Install solar water heating",
      indicativeCost: "£4,000–£6,000",
      typicalSaving: "£55 per year",
    },
    {
      improvement: "Solar photovoltaic panels, 2.5 kWp",
      indicativeCost: "£3,500–£5,500",
      typicalSaving: "£217 per year",
    },
  ],
  isExpired: false,
  isHistorical: false,
  lookupTimestamp: new Date().toISOString(),
  source: "MHCLG EPC API (mock)",
  epcEvidenceStatus: "Verified",
  officialCertUrl:
    "https://find-energy-certificate.service.gov.uk/energy-certificate/0000-0000-0000-0000-0001",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

function validateEnglandWalesPostcode(raw: string): {
  valid: boolean;
  normalised?: string;
  code?: string;
  error?: string;
} {
  // Basic UK postcode regex
  const cleaned = raw.replace(/\s+/g, "").toUpperCase();
  const uk = /^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][ABD-HJLNP-UW-Z]{2}$/.test(
    cleaned
  );
  if (!uk) {
    return {
      valid: false,
      code: "INVALID_POSTCODE",
      error: "Please enter a valid postcode.",
    };
  }

  // Extract prefix (1 or 2 letters)
  const prefix2 = cleaned.substring(0, 2).replace(/[0-9]/g, "");
  const prefix1 = cleaned.substring(0, 1);

  for (const p of NON_ENGLAND_WALES_PREFIXES) {
    if (
      cleaned.startsWith(p) &&
      (p.length === 2 || prefix1 === p)
    ) {
      return {
        valid: false,
        code: "OUTSIDE_ENGLAND_WALES",
        error:
          "This tool covers England and Wales only. EPC certificates for Scotland and Northern Ireland are held in separate registers.",
      };
    }
  }

  // Normalise: insert space before last 3 chars
  const normalised = cleaned.slice(0, -3) + " " + cleaned.slice(-3);
  return { valid: true, normalised };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options);
      if (res.status === 429 && attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error("Fetch failed after retries");
}

function parseExpiryDate(certDate: string | null): string | null {
  if (!certDate) return null;
  const d = new Date(certDate);
  if (isNaN(d.getTime())) return null;
  d.setFullYear(d.getFullYear() + 10);
  return d.toISOString().substring(0, 10);
}

function isExpired(expiryDate: string | null): boolean {
  if (!expiryDate) return false;
  return new Date(expiryDate) < new Date();
}

function mapRow(row: Record<string, unknown>): EpcCertificate {
  const certDate =
    (row["lodgement-date"] as string) ||
    (row["inspection-date"] as string) ||
    null;
  const expiryDate =
    (row["valid-until"] as string) || parseExpiryDate(certDate);
  const uprn = String(row["uprn"] || row["building-reference-number"] || "");
  const certNumber = (row["lmk-key"] as string) || null;

  return {
    uprn,
    address: [
      row["address1"],
      row["address2"],
      row["address3"],
      row["posttown"],
    ]
      .filter(Boolean)
      .join(", "),
    postcode: (row["postcode"] as string) || "",
    epcRating: (row["current-energy-rating"] as string) || "Unknown",
    score: row["current-energy-efficiency"]
      ? Number(row["current-energy-efficiency"])
      : null,
    potentialRating: (row["potential-energy-rating"] as string) || null,
    potentialScore: row["potential-energy-efficiency"]
      ? Number(row["potential-energy-efficiency"])
      : null,
    certDate,
    expiryDate,
    certNumber,
    propertyType: (row["property-type"] as string) || null,
    builtForm: (row["built-form"] as string) || null,
    totalFloorArea: row["total-floor-area"]
      ? Number(row["total-floor-area"])
      : null,
    floorLevel: (row["floor-level"] as string) || null,
    heatingType: (row["main-heat-description"] as string) || null,
    hotWaterDescription: (row["hot-water-description"] as string) || null,
    wallsDescription: (row["walls-description"] as string) || null,
    roofDescription: (row["roof-description"] as string) || null,
    windowsDescription: (row["windows-description"] as string) || null,
    recommendations: [],
    isExpired: isExpired(expiryDate),
    isHistorical: false,
    lookupTimestamp: new Date().toISOString(),
    source: "MHCLG EPC API",
    epcEvidenceStatus: "Verified",
    officialCertUrl: certNumber
      ? `https://find-energy-certificate.service.gov.uk/energy-certificate/${certNumber}`
      : null,
  };
}

// ─── Operation Handlers ───────────────────────────────────────────────────────

async function handleSearch(
  postcode: string,
  token: string,
  isMock: boolean
): Promise<ServiceResponse<EpcAddress[]>> {
  const validation = validateEnglandWalesPostcode(postcode);
  if (!validation.valid) {
    return { ok: false, error: validation.error!, code: validation.code };
  }

  if (isMock) {
    return {
      ok: true,
      data: MOCK_ADDRESSES.map((a) => ({ ...a, postcode: validation.normalised! })),
    };
  }

  const url = `${MHCLG_BASE}/domestic/search?postcode=${encodeURIComponent(
    validation.normalised!
  )}&size=25`;

  let res: Response;
  try {
    res = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: "The EPC lookup service is temporarily unavailable. Please try again shortly.",
      code: "API_TIMEOUT",
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "EPC API authentication error.", code: "AUTH_ERROR" };
  }
  if (res.status === 404) {
    return { ok: true, data: [] };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `EPC API returned status ${res.status}.`,
      code: "API_ERROR",
    };
  }

  let json: { rows?: Record<string, unknown>[] };
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Invalid response from EPC API.", code: "PARSE_ERROR" };
  }

  const rows = json.rows ?? [];
  const addresses: EpcAddress[] = rows.map((row) => ({
    uprn: String(row["uprn"] || row["building-reference-number"] || ""),
    address: [row["address1"], row["address2"], row["address3"], row["posttown"]]
      .filter(Boolean)
      .join(", "),
    postcode: (row["postcode"] as string) || validation.normalised!,
  }));

  return { ok: true, data: addresses };
}

async function handleCertificate(
  req: CertificateRequest,
  token: string,
  isMock: boolean
): Promise<ServiceResponse<EpcCertificate | EpcCertificate[]>> {
  if (isMock) {
    return { ok: true, data: MOCK_CERTIFICATE };
  }

  let url: string;
  if (req.uprn) {
    url = `${MHCLG_BASE}/domestic/certificate/${encodeURIComponent(req.uprn)}`;
  } else if (req.address && req.postcode) {
    const validation = validateEnglandWalesPostcode(req.postcode);
    if (!validation.valid) {
      return { ok: false, error: validation.error!, code: validation.code };
    }
    url = `${MHCLG_BASE}/domestic/search?postcode=${encodeURIComponent(
      validation.normalised!
    )}&address=${encodeURIComponent(req.address)}&size=5`;
  } else {
    return {
      ok: false,
      error: "Provide either uprn r or address+postcode.",
      code: "MISSING_PARAMS",
    };
  }

  let res: Response;
  try {
    res = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
    return {
      ok: false,
      error: "The EPC lookup service is temporarily unavailable. Please try again shortly.",
      code: "API_TIMEOUT",
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "EPC API authentication error.", code: "AUTH_ERROR" };
  }

  if (res.status === 404) {
    return {
      ok: true,
      data: {
        ...MOCK_CERTIFICATE,
        epcEvidenceStatus: "Not found",
        failureReason: "No EPC certificate found for this property.",
        lookupTimestamp: new Date().toISOString(),
        source: "MHCLG EPC API",
        epcRating: "Unknown",
        score: null,
      },
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `EPC API returned status ${res.status}.`,
      code: "API_ERROR",
    };
  }

  let json: { rows?: Record<string, unknown>[] } | Record<string, unknown>;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: "Invalid response from EPC API.", code: "PARSE_ERROR" };
  }

  if ("rows" in json && Array.isArray(json.rows)) {
    const rows = json.rows as Record<string, unknown>[];
    if (rows.length === 0) {
      return {
        ok: true,
        data: {
          ...MOCK_CERTIFICATE,
          uprn: req.uprn || "",
          address: req.address || "",
          postcode: req.postcode || "",
          epcEvidenceStatus: "Not found",
          failureReason: "No EPC certificate found for this property.",
          lookupTimestamp: new Date().toISOString(),
          source: "MHCLG EPC API",
          epcRating: "Unknown",
          score: null,
          recommendations: [],
        },
      };
    }
    const mapped = rows.map((row, i) => ({ ...mapRow(row), isHistorical: i > 0 }));
    return { ok: true, data: mapped.length === 1 ? mapped[0] : mapped };
  }

  const cert = mapRow(json as Record<string, unknown>);
  return { ok: true, data: cert };
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

export default async function handler(req: Request, _ctx: Context) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { ok: false, error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" },
      405,
      origin
    );
  }

  let body: EpcRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { ok: false, error: "Invalid JSON body.", code: "BAD_REQUEST" },
      400,
      origin
    );
  }

  // @ts-ignore — Netlify.env is available at runtime
  const token: string = Netlify.env.get("EPC_API_TOKEN") ?? "";
  const isMock = !token || token === "mock";

  if (body.op === "search") {
    if (!body.postcode) {
      return jsonResponse(
        { ok: false, error: "postcode is required.", code: "MISSING_POSTCODE" },
        400,
        origin
      );
    }
    const result = await handleSearch(body.postcode, token, isMock);
    return jsonResponse(result, result.ok ? 200 : 400, origin);
  }

  if (body.op === "certificate") {
    const result = await handleCertificate(
      body as CertificateRequest,
      token,
      isMock
    );
    return jsonResponse(result, result.ok ? 200 : 400, origin);
  }

  return jsonResponse(
    { ok: false, error: "Unknown operation.", code: "UNKNOWN_OP" },
    400,
    origin
  );
}

export const config = {
  path: "/api/epc-lookup",
};
