// Deploy this as the existing metar-proxy Worker to support FAA NOTAM and AWOS data.
// Keep the FAA credentials in Worker secrets:
//   FAA_NMS_CLIENT_ID
//   FAA_NMS_CLIENT_SECRET
// METAR remains the default product for backward compatibility.
// The weather-batch product accepts comma-separated ICAO codes; existing single-ICAO routes remain unchanged.

const FAA_AUTH_URL = 'https://api-nms.aim.faa.gov/v1/auth/token';
const FAA_NMS_URL = 'https://api-nms.aim.faa.gov/nmsapi';
const AWOS_ICAOS = new Set('EKAR EKSI ESSB ESGG ESNL ESKM ESUP ESNG ESMX ESOK ESND ESGP ESSL ESMS ESOW ESOH ESNX ESNK ESNV ESMK ESOE ESGT ESKN ESGJ ESUT ESNS EDAZ ESSA'.split(' '));
let cachedFaaToken = '';
let cachedFaaTokenExpiresAt = 0;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return plain('Method not allowed', 405, cors);

    const url = new URL(request.url);
    const product = (url.searchParams.get('product') || 'metar').trim().toLowerCase();
    if (product === 'weather-batch') {
      const requestedIds = (url.searchParams.get('ids') || '').split(',').map(id => id.trim().toUpperCase());
      const icaos = [...new Set(requestedIds)];
      const products = [...new Set((url.searchParams.get('products') || 'metar,taf').split(',').map(value => value.trim().toLowerCase()))];
      if (!requestedIds.length || requestedIds.some(id => !/^[A-Z0-9]{4}$/.test(id))) {
        return plain('Missing or invalid ICAO codes', 400, cors);
      }
      if (icaos.length > 100) return plain('Weather batches are limited to 100 ICAO codes', 413, cors);
      if (!products.length || products.some(value => value !== 'metar' && value !== 'taf')) {
        return plain('Weather batches support METAR and TAF only', 400, cors);
      }
      try {
        const reports = await getWeatherBatch(icaos, products);
        return new Response(JSON.stringify({ reports }), {
          headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'public, max-age=60' },
        });
      } catch (error) {
        return plain(`Error fetching weather batch: ${error.message}`, error.status || 502, cors);
      }
    }

    const icao = (url.searchParams.get('icao') || url.searchParams.get('ids') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(icao)) return plain('Missing or invalid ICAO code', 400, cors);

    if (product === 'notam') {
      try {
        const data = await getNotams(icao, env);
        return new Response(JSON.stringify(data), {
          headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'public, max-age=60' },
        });
      } catch (error) {
        return plain(`Error fetching NOTAMs: ${error.message}`, 502, cors);
      }
    }
    if (product === 'awos') {
      if (!AWOS_ICAOS.has(icao)) return plain('AWOS is not available for this airport', 404, cors);
      try {
        const data = await getAwosReport(icao);
        return new Response(JSON.stringify(data), {
          headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        return plain(`Error fetching AWOS for ${icao}: ${error.message}`, 502, cors);
      }
    }
    if (product !== 'metar' && product !== 'taf' && product !== 'metar-history') return plain('Unsupported product', 400, cors);

    const aviationProduct = product === 'taf' ? 'taf' : 'metar';
    const query = new URLSearchParams({ ids: icao, format: 'raw' });
    if (product === 'metar-history') query.set('hours', '72');
    const aviationUrl = `https://aviationweather.gov/api/data/${aviationProduct}?${query}`;
    try {
      const response = await fetch(aviationUrl, {
        headers: { 'User-Agent': 'AviationBriefingApp/1.0 (Personal Aviation Tool)' },
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { ...cors, 'Content-Type': 'text/plain;charset=UTF-8', 'Cache-Control': 'public, max-age=60' },
      });
    } catch (error) {
      return plain(`Error fetching ${product.toUpperCase()}: ${error.message}`, 502, cors);
    }
  },
};

async function getWeatherBatch(icaos, products) {
  const responses = await Promise.all(products.map(async product => {
    const query = new URLSearchParams({ ids: icaos.join(','), format: 'raw' });
    const response = await fetch(`https://aviationweather.gov/api/data/${product}?${query}`, {
      headers: { 'User-Agent': 'AviationBriefingApp/1.0 (Personal Aviation Tool)' },
    });
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`${product.toUpperCase()} API returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return { product, body };
  }));
  const reports = Object.fromEntries(icaos.map(icao => [icao, Object.fromEntries(products.map(product => [product, '']))]));
  for (const { product, body } of responses) {
    const reportPattern = product === 'taf'
      ? /(?:^|\s)(TAF\s+(?:(?:AMD|COR)\s+)?([A-Z0-9]{4})\b)/g
      : /(?:^|\s)((?:METAR|SPECI)\s+(?:COR\s+)?([A-Z0-9]{4})\b)/g;
    const matches = [...body.matchAll(reportPattern)].map(match => ({
      start: match.index + match[0].length - match[1].length,
      icao: match[2],
    }));
    for (let index = 0; index < matches.length; index++) {
      const { start, icao } = matches[index];
      if (reports[icao]) reports[icao][product] = body.slice(start, matches[index + 1]?.start ?? body.length).trim();
    }
  }
  return reports;
}

async function getAwosReport(icao) {
  const pageResponse = await fetch(`https://wx.awos.se/?siteId=${encodeURIComponent(icao)}`, {
    headers: { 'User-Agent': 'AviationBriefingApp/1.0 (Personal Aviation Tool)' },
  });
  if (!pageResponse.ok) throw new Error(`AWOS site returned HTTP ${pageResponse.status}`);
  const page = await pageResponse.text();
  const viewMatch = page.match(/\.load\(['"]get\.aspx\?viewId=([^&'"]+)/i);
  if (!viewMatch) throw new Error('AWOS page did not include an overview');

  const dataUrl = new URL('https://wx.awos.se/get.aspx');
  dataUrl.searchParams.set('viewId', viewMatch[1]);
  dataUrl.searchParams.set('refresh', String(Date.now()));
  const cookie = pageResponse.headers.get('set-cookie')?.split(';', 1)[0];
  const headers = { 'User-Agent': 'AviationBriefingApp/1.0 (Personal Aviation Tool)' };
  if (cookie) headers.Cookie = cookie;
  const dataResponse = await fetch(dataUrl, { headers });
  if (!dataResponse.ok) throw new Error(`AWOS data returned HTTP ${dataResponse.status}`);
  const raw = (await dataResponse.text()).trim();
  if (!raw) throw new Error('AWOS site returned an empty report');
  return { raw, retrievedAt: Date.now() };
}

function plain(text, status, cors) {
  return new Response(text, { status, headers: { ...cors, 'Content-Type': 'text/plain;charset=UTF-8' } });
}

async function getFaaAccessToken(env) {
  if (!env.FAA_NMS_CLIENT_ID || !env.FAA_NMS_CLIENT_SECRET) {
    throw new Error('FAA NMS Worker secrets are not configured');
  }
  if (cachedFaaToken && Date.now() < cachedFaaTokenExpiresAt) return cachedFaaToken;
  const basic = btoa(`${env.FAA_NMS_CLIENT_ID}:${env.FAA_NMS_CLIENT_SECRET}`);
  const response = await fetch(FAA_AUTH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) throw new Error(`FAA auth returned HTTP ${response.status}`);
  const data = await response.json();
  if (!data.access_token) throw new Error('FAA auth response did not include an access token');
  cachedFaaToken = data.access_token;
  cachedFaaTokenExpiresAt = Date.now() + Math.max(60, (Number(data.expires_in) || 3000) - 60) * 1000;
  return cachedFaaToken;
}

async function getNotams(icao, env) {
  const token = await getFaaAccessToken(env);
  const searchTerms = [icao];
  if (icao.startsWith('K')) searchTerms.push(icao.slice(1));
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setUTCHours(23, 59, 59, 999);

  for (const term of searchTerms) {
    const response = await fetch(`${FAA_NMS_URL}/v1/notams?location=${encodeURIComponent(term)}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'client_id': env.FAA_NMS_CLIENT_ID,
        'client_secret': env.FAA_NMS_CLIENT_SECRET,
        'nmsResponseFormat': 'GEOJSON',
        'Accept': 'application/json',
      },
    });
    if (!response.ok) throw new Error(`FAA NOTAM API returned HTTP ${response.status}`);
    const parsed = await response.json();
    const items = Array.isArray(parsed?.data?.geojson) ? parsed.data.geojson
      : Array.isArray(parsed?.features) ? parsed.features
        : Array.isArray(parsed?.items) ? parsed.items : [];
    const allNotams = [];
    const filteredNotams = [];
    for (const item of items) {
      const properties = item?.properties || {};
      const core = properties.coreNOTAMData?.notam || {};
      const start = core.effectiveStart || properties.effectiveStart;
      const end = core.effectiveEnd || properties.effectiveEnd;
      if (start && new Date(start) > endOfDay) continue;
      if (end && String(end).toUpperCase() !== 'PERM' && new Date(end) < startOfDay) continue;
      const translations = properties.coreNOTAMData?.notamTranslation;
      const translated = Array.isArray(translations) ? translations.find(entry => entry?.formattedText)?.formattedText : '';
      const raw = String(translated || `${core.number ? `${core.number} ` : ''}${core.text || properties.traditionalMessage || properties.text || ''}`).trim();
      if (!raw) continue;
      allNotams.push(simplifyNotam(raw));
      if (!/(?:^|\s)E\)\s*PPR FOR ALL FLIGHTS\b/i.test(raw) && !/^PPR FOR ALL FLIGHTS\b/i.test(raw)
        && /HOURS OF SERVICE|OPR HR|OPERATING HOURS/i.test(raw)) {
        filteredNotams.push(simplifyNotam(raw));
      }
    }
    if (items.length) return { allNotams, filteredNotams };
  }
  return { allNotams: [], filteredNotams: [] };
}

function simplifyNotam(raw) {
  const text = raw.replace(/Q\)[^\n\r]+/g, '').trim();
  const field = letter => {
    const match = text.match(new RegExp(`(?:^|\\s)${letter}\\)\\s*([\\s\\S]*?)(?=(?:\\s+[A-G]\\)|$))`, 'i'));
    return match ? match[1].trim() : '';
  };
  const start = formatNotamDate(field('B'));
  const end = formatNotamDate(field('C'));
  const schedule = field('D');
  const body = field('E');
  if (!body) return raw.replace(/\s+/g, ' ').trim();
  return `${start}${end ? ` - ${end}` : ''}${schedule ? ` (${schedule})` : ''}${start || end || schedule ? '\n' : ''}${body}`.trim();
}

function formatNotamDate(value) {
  if (!value) return '';
  if (value.toUpperCase() === 'PERM') return 'PERM';
  const match = value.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return value;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${match[3]} ${months[Number(match[2]) - 1] || match[2]} ${match[4]}:${match[5]}Z`;
}
