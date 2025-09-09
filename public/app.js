let lastResults = [];

function getByPath(obj, pathArr) {
  try {
    return pathArr.reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
  } catch (_) {
    return undefined;
  }
}

function normalizeResult(item) {
  // Many Apollo responses wrap data under `organization` or `company`
  if (item && typeof item === 'object') {
    if (item.organization && typeof item.organization === 'object') return item.organization;
    if (item.company && typeof item.company === 'object') return item.company;
  }
  return item;
}

function getFirstByPaths(obj, paths) {
  for (const p of paths) {
    const val = getByPath(obj, p);
    if (val !== undefined && val !== null && !(typeof val === 'string' && val.trim() === '')) return val;
  }
  return undefined;
}

function parseEmployeesCount(org) {
  const raw = getFirstByPaths(org, [
    ['num_employees'],
    ['estimated_num_employees'],
    ['employee_count'],
    ['employees'],
    ['organization_num_employees'],
    ['organization', 'num_employees'],
    ['organization', 'estimated_num_employees'],
    ['organization', 'employee_count'],
    ['organization', 'employees'],
    ['organization', 'organization_num_employees'],
    ['metrics', 'num_employees'],
    ['metrics', 'employee_count']
  ]);
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    // Handle ranges like "50-200", "50 — 200", "50 to 200"
    const matchRange = s.match(/(\d+[\,\.]?\d*)\s*(?:-|—|to|\.)\s*(\d+[\,\.]?\d*)/);
    if (matchRange) {
      const a = Number(matchRange[1].replace(/[,\.]/g, ''));
      const b = Number(matchRange[2].replace(/[,\.]/g, ''));
      if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.round((a + b) / 2);
    }
    const n = Number(s.replace(/[,\.]/g, ''));
    if (!Number.isNaN(n)) return n;
    return null;
  }
  return null;
}

const EMP_BUCKETS = [
  { label: '1-10', min: 1, max: 10 },
  { label: '11-50', min: 11, max: 50 },
  { label: '51-200', min: 51, max: 200 },
  { label: '201-500', min: 201, max: 500 },
  { label: '501-1000', min: 501, max: 1000 },
  { label: '1001-5000', min: 1001, max: 5000 },
  { label: '5001-10000', min: 5001, max: 10000 },
  { label: '10001+', min: 10001, max: Infinity }
];

function bucketForEmployees(n) {
  if (n == null) return 'Unknown';
  for (const b of EMP_BUCKETS) {
    if (n >= b.min && n <= b.max) return b.label;
  }
  return 'Unknown';
}

function renderOrgCard(org) {
  const name = getFirstByPaths(org, [
    ['name'],
    ['organization_name'],
    ['company_name'],
    ['organization', 'name']
  ]) || 'Unknown Name';
  const domain = getFirstByPaths(org, [
    ['website_url'],
    ['domain'],
    ['organization', 'website_url'],
    ['organization', 'domain']
  ]) || '';
  const location = getFirstByPaths(org, [
    ['location'],
    ['headquarters_location'],
    ['country'],
    ['organization', 'location'],
    ['organization', 'headquarters_location'],
    ['organization', 'country']
  ]) || '';
  const employees = (function getEmployeesDisplay(o) {
    const primary = getFirstByPaths(o, [
      ['num_employees'],
      ['estimated_num_employees'],
      ['employee_count'],
      ['employees'],
      ['organization_num_employees'],
      ['organization', 'num_employees'],
      ['organization', 'estimated_num_employees'],
      ['organization', 'employee_count'],
      ['organization', 'employees'],
      ['organization', 'organization_num_employees'],
      ['metrics', 'num_employees'],
      ['metrics', 'employee_count']
    ]);
    if (typeof primary === 'number') return primary.toLocaleString();
    if (typeof primary === 'string' && primary.trim()) return primary.trim().replace(/\s*employees?$/i, '');

    // Range fallbacks (flat and nested)
    const min = getFirstByPaths(o, [
      ['organization_num_employees_min'],
      ['organization', 'organization_num_employees_min'],
      ['metrics', 'organization_num_employees_min']
    ]);
    const max = getFirstByPaths(o, [
      ['organization_num_employees_max'],
      ['organization', 'organization_num_employees_max'],
      ['metrics', 'organization_num_employees_max']
    ]);
    if (typeof min === 'number' && typeof max === 'number') return `${min.toLocaleString()}-${max.toLocaleString()}`;
    if (typeof min === 'number' && (max === undefined || max === null)) return `${min.toLocaleString()}+`;
    return '';
  })(org);
  const li = document.createElement('div');
  li.className = 'result-card';
  li.innerHTML = `<div><strong>${name}</strong></div>
    <div class="muted">${domain}${domain && location ? ' · ' : ''}${location}${employees ? ' · Employees: ' + employees : ''}</div>`;
  return li;
}

function toRangeString(label) {
  const m = label.match(/^(\d+)(?:\+|-([\d]+))$/);
  if (!m) return null;
  const min = Number(m[1]);
  const isPlus = /\+$/.test(label);
  const max = isPlus ? 100000 : Number(m[2]);
  if (Number.isNaN(min) || Number.isNaN(max)) return null;
  return `${min},${max}`;
}

function defaultRangeStrings() {
  const labels = EMP_BUCKETS.map(b => b.label);
  return labels.map(toRangeString).filter(Boolean);
}

async function doSearch() {
  const prompt = document.getElementById('prompt').value.trim();
  const page = Number(document.getElementById('page').value) || 1;
  const per_page = Number(document.getElementById('per_page').value) || 25;

  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  try {
    // Always use API ranges to get comprehensive employee data
    const res = await fetch('/api/search_by_ranges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        prompt, 
        page, 
        per_page: Math.min(per_page, 25), 
        ranges: defaultRangeStrings(),
        fetch_all: false
      }),
    });
    
    const ct = res.headers.get('content-type') || '';
    let data, textFallback;
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      textFallback = await res.text();
    }
    
    console.log('API response:', { status: res.status, ok: res.ok, data: data || textFallback });
    
    if (!res.ok) {
      document.getElementById('payload').textContent = JSON.stringify({ prompt, ranges: defaultRangeStrings() }, null, 2);
      if (data) {
        const msg = data.message || data.error || 'Unknown error';
        const status = data.status ? ` (status ${data.status})` : '';
        const details = data.details ? `<pre>${JSON.stringify(data.details, null, 2)}</pre>` : '';
        document.getElementById('results').innerHTML = `<div class="result-card"><strong>API Error${status}:</strong> ${msg}${details}</div>`;
      } else {
        const safe = (textFallback || '').slice(0, 1000);
        document.getElementById('results').innerHTML = `<div class="result-card"><strong>API Error:</strong><pre>${safe.replace(/</g,'&lt;')}</pre></div>`;
      }
      return;
    }
    
    if (!data) {
      const safe = (textFallback || '').slice(0, 1000);
      document.getElementById('results').innerHTML = `<div class="result-card"><strong>Unexpected non-JSON response:</strong><pre>${safe.replace(/</g,'&lt;')}</pre></div>`;
      return;
    }
    
    // Display the Apollo payload that was actually sent to Apollo API
    const apolloPayload = data.request?.apollo_payload || {};
    document.getElementById('payload').textContent = JSON.stringify(apolloPayload, null, 2);
    
    // Always group by employee ranges
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const container = document.getElementById('results');
    container.innerHTML = '';
    
    for (const g of groups) {
      if (g.error || g.total_entries === 0) continue;
      
      const header = document.createElement('div');
      header.className = 'result-card';
      header.innerHTML = `<strong>${g.range} employees</strong> <span class="muted">(${g.total_entries} total)</span>`;
      container.appendChild(header);
      
      const items = Array.isArray(g.organizations) ? g.organizations : [];
      for (const org of items) {
        container.appendChild(renderOrgCard(normalizeResult(org)));
      }
    }
  } catch (err) {
    document.getElementById('results').innerHTML = `<div class="result-card"><strong>Error</strong><br/>${String(err.message || err)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search';
  }
}

document.getElementById('searchBtn').addEventListener('click', doSearch);