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
}

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

  let body: { op: string; postcode?: string; certificateNumber: string };
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
