const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

// Configuration
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';

// Lazy import to avoid requiring when not used in health checks
let GoogleGenerativeAI;

// App setup
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Helper: clamp pagination
function clamp(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

// Helper: basic keyword extraction fallback (very naive)
function extractKeywords(input) {
  if (!input || typeof input !== 'string') return '';
  const stopwords = new Set(['find', 'show', 'me', 'companies', 'company', 'with', 'in', 'the', 'a', 'an', 'and', 'or', 'that', 'which', 'who', 'of', 'for']);
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s,.-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !stopwords.has(w))
    .slice(0, 15)
    .join(' ');
}


// Helper: attempt to parse JSON from LLM text output
function parseJsonFromText(text) {
  if (!text) return null;
  try {
    // Remove common code fences
    const cleaned = text
      .replace(/```json/gi, '```')
      .replace(/```/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch (_) {
    // try to find first {...} block
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

async function generateApolloPayloadFromNL(naturalLanguageQuery, page, perPage) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  if (!GoogleGenerativeAI) {
    ({ GoogleGenerativeAI } = require('@google/generative-ai'));
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const systemInstruction = [
    'You are a JSON converter for Apollo Organization Search API.',
    'You MUST follow these rules exactly:',
    '',
    '1. ALWAYS scan the user query for any location words (countries, states, cities)',
    '2. If ANY location is found, include "organization_locations": [location] in your JSON',
    '3. Use proper capitalization: "Mexico", "California", "Texas", "Germany", etc.',
    '4. ALWAYS use "q_organization_keyword_tags" for industry/keyword searches, NEVER "q_organization_name"',
    '5. ALWAYS include relevance sorting',
    '',
    'MANDATORY FIELDS:',
    '- page: number',
    '- per_page: number', 
    '- sort_by: "relevance" (ALWAYS include this)',
    '- sort_order: "desc" (ALWAYS include this)',
    '- organization_locations: array of strings (REQUIRED if location mentioned)',
    '',
    'KEYWORD SEARCH RULES:',
    '- ALWAYS use "q_organization_keyword_tags": [] for ALL keyword searches',
    '- Examples: "solar", "fintech", "saas", "manufacturing", "healthcare"',
    '- FORBIDDEN: Do NOT include "q_organization_name" - this field is BANNED',
    '- If you include "q_organization_name" you have FAILED',
    '',
    'OTHER OPTIONAL FIELDS:',
    '- organization_num_employees_ranges: array of strings like ["1,10"]',
    '',
    'LOCATION EXAMPLES:',
    '- "companies in mexico" -> "organization_locations": ["Mexico"]',
    '- "startups in california" -> "organization_locations": ["California"]', 
    '- "firms in tokyo japan" -> "organization_locations": ["Tokyo", "Japan"]',
    '',
    'CRITICAL: You MUST include organization_locations if ANY geographic word appears in the query.',
    'CRITICAL: FORBIDDEN FIELD "q_organization_name" - DO NOT INCLUDE THIS FIELD EVER.',
    'CRITICAL: ONLY use q_organization_keyword_tags for keywords.',
    'CRITICAL: ALWAYS include sort_by: "relevance" and sort_order: "desc".',
    '',
    'Example input: "solar companies in mexico"',
    'Example output: {"page": 1, "per_page": 25, "sort_by": "relevance", "sort_order": "desc", "organization_locations": ["Mexico"], "q_organization_keyword_tags": ["solar"]}',
    '',
    'Return ONLY valid JSON. No explanations.',
  ].join('\n');

  const userInstruction = [
    'Convert this user request to Apollo API JSON:',
    `"${naturalLanguageQuery}"`,
    '',
    'STEP 1: Extract keywords and put them in "q_organization_keyword_tags" array',
    'STEP 2: Find locations and put them in "organization_locations" array', 
    'STEP 3: Add sort_by: "relevance" and sort_order: "desc"',
    'STEP 4: Add other fields as needed',
    '',
    'REMEMBER:',
    '- Use "q_organization_keyword_tags" for ALL keywords like "solar", "fintech", "saas"',
    '- BANNED FIELD: "q_organization_name" must NOT appear in your JSON response',
    '- ALWAYS include sort_by: "relevance" and sort_order: "desc"',
    '- SUCCESS = JSON without "q_organization_name", FAILURE = JSON with "q_organization_name"',
    '',
    'Output only JSON:'
  ].join('\n');

  const result = await model.generateContent({
    contents: [
      { role: 'user', parts: [{ text: systemInstruction }] },
      { role: 'user', parts: [{ text: userInstruction }] },
    ],
  });

  const raw = result.response.text();
  const parsed = parseJsonFromText(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Model did not return valid JSON');
  }

  // Ensure required pagination
  const safePage = clamp(Number(parsed.page) || page, 1, 500, 1);
  const safePerPage = clamp(Number(parsed.per_page) || perPage, 1, 100, 25);

  const payload = {
    page: safePage,
    per_page: safePerPage,
  };

  if (parsed.sort_by) payload.sort_by = parsed.sort_by;
  if (parsed.sort_order) payload.sort_order = parsed.sort_order;

  // Force remove q_organization_name if Gemini stubbornly includes it
  if ('q_organization_name' in parsed) {
    delete parsed.q_organization_name;
  }

  // Apply parsed fields directly to the payload (Apollo API expects them at root level)
  // Skip q_organization_name completely - we only want keyword tags

  // Apply all other fields from parsed response
  if (Array.isArray(parsed.organization_locations)) {
    payload.organization_locations = parsed.organization_locations;
  }
  if (Array.isArray(parsed.organization_num_employees_ranges)) {
    payload.organization_num_employees_ranges = parsed.organization_num_employees_ranges;
  }
  if (Array.isArray(parsed.q_organization_keyword_tags)) {
    payload.q_organization_keyword_tags = parsed.q_organization_keyword_tags;
  }
  if (parsed.revenue_range) {
    if (typeof parsed.revenue_range.min === 'number') {
      payload['revenue_range[min]'] = parsed.revenue_range.min;
    }
    if (typeof parsed.revenue_range.max === 'number') {
      payload['revenue_range[max]'] = parsed.revenue_range.max;
    }
  }

  return payload;
}

async function callApolloOrganizationSearch(apolloPayload) {
  if (!process.env.APOLLO_API_KEY) {
    throw new Error('APOLLO_API_KEY is not set');
  }

  const url = 'https://api.apollo.io/api/v1/mixed_companies/search';
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': process.env.APOLLO_API_KEY,
  };

  // Include api_key in body as an additional compatibility fallback
  const body = { api_key: process.env.APOLLO_API_KEY, ...apolloPayload };

  const { data } = await axios.post(url, body, { headers, timeout: 30000 });
  return data;
}

async function enrichOrganizationByDomain(org) {
  try {
    const domain = org.primary_domain || null;
    if (!domain) return org;
    const url = 'https://api.apollo.io/api/v1/organizations/enrich';
    const headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.APOLLO_API_KEY,
    };
    const params = { domain, api_key: process.env.APOLLO_API_KEY };
    const { data } = await axios.get(url, { headers, params, timeout: 20000 });
    const enriched = data?.organization || data || {};
    const est = enriched.estimated_num_employees || enriched.num_employees || null;
    if (est != null) {
      return { ...org, estimated_num_employees: est };
    }
    return org;
  } catch (_) {
    return org;
  }
}

async function enrichOrganizationById(org) {
  try {
    const id = org.id || org.organization_id || null;
    if (!id) return org;
    const url = `https://api.apollo.io/api/v1/organizations/${encodeURIComponent(id)}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.APOLLO_API_KEY,
    };
    const params = { api_key: process.env.APOLLO_API_KEY };
    const { data } = await axios.get(url, { headers, params, timeout: 20000 });
    const enriched = data?.organization || data || {};
    const est = enriched.estimated_num_employees || enriched.num_employees || null;
    if (est != null) {
      return { ...org, estimated_num_employees: est };
    }
    return org;
  } catch (_) {
    return org;
  }
}

async function enrichOrganization(org) {
  const byDomain = await enrichOrganizationByDomain(org);
  if (byDomain.estimated_num_employees != null) return byDomain;
  return enrichOrganizationById(byDomain);
}

async function enrichOrganizationsWithEmployees(orgs, concurrency = 5) {
  if (!Array.isArray(orgs) || orgs.length === 0) return [];
  const results = [];
  let index = 0;
  async function worker() {
    while (index < orgs.length) {
      const i = index++;
      const org = orgs[i];
      const enriched = await enrichOrganization(org);
      results[i] = enriched;
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, orgs.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

app.post('/api/search', async (req, res) => {
  try {
    const { prompt, page, per_page, enrich } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required (string)' });
    }

    const safePage = clamp(Number(page), 1, 500, 1);
    const safePerPage = clamp(Number(per_page), 1, 100, 25);

    let apolloPayload = await generateApolloPayloadFromNL(prompt, safePage, safePerPage);

    let apolloData;
    try {
      apolloData = await callApolloOrganizationSearch(apolloPayload);
    } catch (err) {
      // Fallback: minimal keyword search by name
      const fallbackPayload = {
        page: safePage,
        per_page: safePerPage,
        q_organization_name: extractKeywords(prompt) || prompt,
      };
      try {
        apolloData = await callApolloOrganizationSearch(fallbackPayload);
        apolloPayload = { ...apolloPayload, __fallback_used: true, __fallback_payload: fallbackPayload };
      } catch (err2) {
        const status = err2.response?.status || err.response?.status || 500;
        const data = err2.response?.data || err.response?.data || { message: String(err2.message || err.message) };
        const message = data?.error_message || data?.message || 'Unknown Apollo error';
        return res.status(status).json({ error: 'Apollo API error', status, message, details: data, attempted_payload: apolloPayload });
      }
    }

    // Optional enrichment for employee counts
    if (enrich && Array.isArray(apolloData?.organizations)) {
      const enriched = await enrichOrganizationsWithEmployees(apolloData.organizations);
      apolloData = { ...apolloData, organizations: enriched, __enriched: true };
    }

    return res.json({ request: { prompt, payload: apolloPayload, enrich: !!enrich }, results: apolloData });
  } catch (error) {
    return res.status(500).json({ error: 'Internal error', details: String(error.message || error) });
  }
});

function normalizeRangeInput(range) {
  if (typeof range === 'string') {
    const parts = range.split(',').map((s) => s.trim());
    if (parts.length === 2) return `${parts[0]},${parts[1]}`;
  }
  if (Array.isArray(range) && range.length === 2) {
    return `${range[0]},${range[1]}`;
  }
  if (range && typeof range === 'object' && 'min' in range && 'max' in range) {
    return `${range.min},${range.max}`;
  }
  return null;
}

async function searchForRange(basePayload, rangeString, pageOverride, perPageOverride) {
  const payload = JSON.parse(JSON.stringify(basePayload));
  // Remove conflicting fields
  delete payload.organization_num_employees_min;
  delete payload.organization_num_employees_max;
  if (payload.query) {
    delete payload.query.organization_num_employees_min;
    delete payload.query.organization_num_employees_max;
  }
  // Apply ranges in both root and query for compatibility
  payload.organization_num_employees_ranges = [rangeString];
  payload.query = { ...(payload.query || {}), organization_num_employees_ranges: [rangeString] };
  if (typeof pageOverride === 'number') payload.page = pageOverride;
  if (typeof perPageOverride === 'number') payload.per_page = perPageOverride;
  const data = await callApolloOrganizationSearch(payload);
  const pagination = data?.pagination || {};
  const total = typeof pagination.total_entries === 'number' ? pagination.total_entries : (Array.isArray(data?.organizations) ? data.organizations.length : 0);
  return { total, organizations: data?.organizations || [], raw: data, pagination };
}

app.all('/api/search_by_ranges', async (req, res) => {
  try {
    const source = req.method;
    const body = req.body || {};
    const query = req.query || {};
    const prompt = (body.prompt ?? query.prompt);
    const page = (body.page ?? query.page);
    const per_page = (body.per_page ?? query.per_page);
    const ranges = (body.ranges ?? query.ranges);
    const fetch_all = body.fetch_all === true || body.fetch_all === 'true' || query.fetch_all === 'true';
    console.log(`[search_by_ranges] ${source}`, { prompt, page, per_page, ranges, fetch_all });
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required (string)' });
    }
    const safePage = clamp(Number(page), 1, 500, 1);
    const safePerPage = clamp(Number(per_page), 1, 100, 25);

    // Build base payload from NL
    const base = await generateApolloPayloadFromNL(prompt, safePage, safePerPage);

    // Normalize ranges
    const inputRanges = Array.isArray(ranges) && ranges.length > 0 ? ranges : [
      '1,10', '11,50', '51,200', '201,500', '501,1000', '1001,5000', '5001,10000', '10001,20000'
    ];
    const normalized = inputRanges
      .map(normalizeRangeInput)
      .filter((s) => typeof s === 'string' && /\d+\s*,\s*\d+/.test(s));

    // Query per range with limited concurrency
    const results = [];
    let idx = 0;
    const concurrency = 4;
    async function worker() {
      while (idx < normalized.length) {
        const i = idx++;
        const r = normalized[i];
        try {
          // First page
          const first = await searchForRange(base, r, 1, fetch_all ? 100 : safePerPage);
          let allOrgs = Array.isArray(first.organizations) ? first.organizations.slice() : [];
          const totalPages = Number(first.pagination?.total_pages || 1);
          if (fetch_all && totalPages > 1) {
            for (let p = 2; p <= totalPages; p++) {
              const next = await searchForRange(base, r, p, 100);
              if (Array.isArray(next.organizations) && next.organizations.length > 0) {
                allOrgs = allOrgs.concat(next.organizations);
              }
            }
          }
          const limited = fetch_all ? allOrgs : allOrgs.slice(0, safePerPage);
          results[i] = { range: r, total_entries: first.total, organizations: limited };
        } catch (err) {
          const status = err.response?.status || 500;
          const details = err.response?.data || { message: String(err.message || err) };
          results[i] = { range: r, error: true, status, details, total_entries: 0, organizations: [] };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, normalized.length) }, () => worker()));

    return res.json({ 
      request: { 
        prompt, 
        ranges: normalized, 
        page: safePage, 
        per_page: safePerPage, 
        fetch_all,
        apollo_payload: base  // Add the generated Apollo payload here
      }, 
      groups: results 
    });
  } catch (error) {
    console.error('[search_by_ranges] error', error?.response?.data || error);
    return res.status(500).json({ error: 'Internal error', details: String(error.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});