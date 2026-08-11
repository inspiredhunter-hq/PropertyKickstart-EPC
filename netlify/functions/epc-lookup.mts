import type { Context } from "@netlify/functions";

const EPC_API_BASE = "https://epc.opendatacommunities.org/api/v1";

interface SearchResult {
  address: string;
  uprn: string;
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
  uprn: string;
  lookupTimestamp: string;
  source: string;
  epcEvidenceStatus: "Verified" | "Not found" | "Not checked";
  failureReason?: string;
  officialCertUrl: string;
  recommendations: string[];
}

function isMockMode(token: string | undefined): boolean {
  return !token || token === "mock";
}

function getMockAddresses(postcode: string): SearchResult[] {
  const pc = postcode.toUpperCase().replace(/\s+/g, " ");
  return [
    { address: `Flat 1, 12 Example Street, ${pc}`, uprn: "100012345671", postcode: pc },
    { address: `Flat 2, 12 Example Street, ${pc}`, uprn: "100012345672", postcode: pc },
    { address: `14 Example Street, ${pc}`, uprn: "100012345673", postcode: pc },
  ];
}

function getMockCertificate(uprn: string): EpcCertificate {
  const ratings = ["A", "B", "C", "D", "E", "F", "G"];
  const idx = parseInt(uprn.slice(-1)) % ratings.length;
  const rating = ratings[idx];
  const scores: Record<string, number> = { A: 92, B: 82, C: 72, D: 60, E: 45, F: 30, G: 15 };
  return {
    epcRating: rating,
    score: scores[rating] || 60,
    potentialRating: rating === "A" ? "A" : ratings[Math.max(0, idx - 1)],
    potentialScore: Math.min(100, (scores[rating] || 60) + 12),
    certDate: "2022-06-15",
    expiryDate: "2032-06-14",
    certNumber: `0000-0000-0000-${uprn.slice(-4)}-0000`,
    propertyType: "Flat",
    address: `Mock Property, ${uprn}`,
    uprn,
    lookupTimestamp: new Date().toISOString(),
    source: "mock",
    epcEvidenceStatus: "Verified",
    officialCertUrl: `https://find-energy-certificate.service.gov.uk/energy-certificate/0000-0000-0000-${uprn.slice(-4)}-0000`,
    recommendations: [
      "Add loft insulation",
      "Install a more efficient boiler",
      "Upgrade to double glazing",
    ],
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
  const url = `${EPC_API_BASE}/domestic/search?postcode=${encodeURIComponent(postcode)}&size=20`;
  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`EPC API error: ${res.status}`);
  }

  const data = await res.json();
  const rows: SearchResult[] = [];

  for (const row of data?.rows ?? []) {
    const cols = data.column_names ?? [];
    const get = (name: string) => row[cols.indexOf(name)] ?? "";
    rows.push({
      address: [
        get("address1"),
        get("address2"),
        get("address3"),
        get("posttown"),
      ]
        .filter(Boolean)
        .join(", "),
      uprn: get("uprn"),
      postcode: get("postcode"),
    });
  }

  return rows;
}

async function fetchCertificate(
  uprn: string,
  token: string
): Promise<EpcCertificate> {
  const url = `${EPC_API_BASE}/domestic/uprn/${encodeURIComponent(uprn)}`;
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
      uprn,
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

  const data = await res.json();
  const row = data?.rows?.[0];
  if (!row) throw new Error("No data returned from EPC API");

  const cols = data.column_names ?? [];
  const get = (name: string) => row[cols.indexOf(name)] ?? "";

  const certNumber = get("lmk-key");
  return {
    epcRating: get("current-energy-rating"),
    score: parseInt(get("current-energy-efficiency")) || 0,
    potentialRating: get("potential-energy-rating"),
    potentialScore: parseInt(get("potential-energy-efficiency")) || 0,
    certDate: get("lodgement-date"),
    expiryDate: get("lodgement-date")
      ? new Date(
          new Date(get("lodgement-date")).getTime() +
            10 * 365.25 * 24 * 3600 * 1000
        )
          .toISOString()
          .slice(0, 10)
      : "",
    certNumber,
    propertyType: get("property-type"),
    address: [get("address1"), get("address2"), get("address3"), get("posttown")]
      .filter(Boolean)
      .join(", "),
    uprn,
    lookupTimestamp: new Date().toISOString(),
    source: "live",
    epcEvidenceStatus: "Verified",
    officialCertUrl: certNumber
      ? `https://find-energy-certificate.service.gov.uk/energy-certificate/${certNumber}`
      : "",
    recommendations: [],
  };
}

function rejectOutOfScope(postcode: string): boolean {
  // Scotland: starts with EH, G, KA, KY, DD, PH, AB, IV, KW, HS, ZE, PA, ML, FK, TD, DG, KA
  // Northern Ireland: starts with BT
  const outOfScope = /^(BT|AB|DF|DG|EH|FK|G[0-9]|HS|IV|KA|KW|KY|ML|PA|PH|TD|ZE)/i;
  return outOfScope.test(postcode.trim());
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

  let body: { op: string; postcode?: string; uprn: string };
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
      const uprn = (body.uprn ?? "").trim();
      if (!uprn) {
        return new Response(
          JSON.stringify({ error: "uprn is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const cert = mock
        ? getMockCertificate(uprn)]
        : await fetchCertificate(uprn, token!);

      return new Response(JSON.stringify({ certificate: cert, mock }), {
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
