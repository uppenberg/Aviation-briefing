const STORAGE_KEY = 'aviation-briefing-v2';
const WEATHER_WORKER_URL = 'https://metar-proxy.uppenberg1.workers.dev/';
const RUNWAY_CACHE_PREFIX = 'aviation-briefing-runways-';
const RUNWAY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OURAIRPORTS_RUNWAYS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
const OURAIRPORTS_NAVAIDS_URL = 'https://davidmegginson.github.io/ourairports-data/navaids.csv';
let runwayCsvPromise = null;
let navaidCsvPromise = null;
const state = {
  airports: [],
  groups: [],
  activeGroup: null,
  departureTime: '',
  arrivalTime: '',
  selected: new Set(),
  sidebarOpen: false,
  busy: new Set(),
  expandedWind: new Set()
};

document.addEventListener('DOMContentLoaded', init);

function init() {
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(error => {
      console.warn('Kunde inte registrera service worker:', error);
    });
  }
  loadState();
  document.getElementById('dep-time').value = state.departureTime;
  document.getElementById('arr-time').value = state.arrivalTime;
  document.getElementById('airport-search').addEventListener('submit', handleSearch);
  document.getElementById('refresh-all').addEventListener('click', () => refreshAll());
  document.getElementById('create-group').addEventListener('click', createGroupFromSelection);
  document.getElementById('open-sidebar').addEventListener('click', () => setSidebar(!state.sidebarOpen));
  document.getElementById('close-sidebar').addEventListener('click', () => setSidebar(false));
  document.getElementById('sidebar-scrim').addEventListener('click', () => setSidebar(false));
  document.getElementById('add-suggested').addEventListener('click', () => addAirport('ESSA'));
  document.getElementById('dep-time').addEventListener('change', event => {
    state.departureTime = event.currentTarget.value;
    saveState();
    renderCards();
  });
  document.getElementById('arr-time').addEventListener('change', event => {
    state.arrivalTime = event.currentTarget.value;
    saveState();
    renderCards();
  });
  document.getElementById('airport-input').addEventListener('input', event => {
    const input = event.currentTarget;
    const pos = input.selectionStart;
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    input.setSelectionRange(pos, pos);
  });
  render();
  if (state.airports.length) refreshAll({ quiet: true });
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.airports = Array.isArray(saved.airports) ? saved.airports
      .filter(item => item && /^[A-Z]{4}$/.test(item.icao))
      .map(item => ({
        icao: item.icao,
        ...(isCachedReport(item.metar) ? { metar: item.metar } : {}),
        ...(isCachedReport(item.taf) ? { taf: item.taf } : {})
      })) : [];
    state.groups = Array.isArray(saved.groups) ? saved.groups.filter(group => group && typeof group.id === 'string' && typeof group.name === 'string') : [];
    state.groups.forEach(group => { group.airports = Array.isArray(group.airports) ? group.airports.filter(icao => state.airports.some(item => item.icao === icao)) : []; });
    state.activeGroup = saved.activeGroup || null;
    state.departureTime = typeof saved.departureTime === 'string' ? saved.departureTime : '';
    state.arrivalTime = typeof saved.arrivalTime === 'string' ? saved.arrivalTime : '';
    if (state.activeGroup && !state.groups.some(group => group.id === state.activeGroup)) state.activeGroup = null;
  } catch (error) {
    console.warn('Kunde inte läsa sparad briefing:', error);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
    airports: state.airports.map(({ icao, metar, taf }) => ({
      icao,
      ...(isCachedReport(metar) ? { metar: { raw: metar.raw, time: metar.time || '' } } : {}),
      ...(isCachedReport(taf) ? { taf: { raw: taf.raw, time: taf.time || '' } } : {})
    })),
    groups: state.groups,
    activeGroup: state.activeGroup,
    departureTime: state.departureTime,
    arrivalTime: state.arrivalTime
    }));
  } catch (error) {
    console.warn('Kunde inte spara briefingens vädercache:', error);
  }
  document.getElementById('dep-time').value = state.departureTime;
  document.getElementById('arr-time').value = state.arrivalTime;
}

function isCachedReport(report) {
  return report && typeof report.raw === 'string' && report.raw.trim().length > 0;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatWeatherMarkup(raw, product = 'metar') {
  let html = escapeHtml(raw);
  html = html.replace(/\b((?:\d{3}|VRB)\d{2,3})(G(\d{2,3}))KT\b/g, (match, base, gustPart, gustValue) => {
    return Number(gustValue) > 25
      ? `${base}<span style="color:#e6ca62;font-weight:700">${gustPart}</span>KT`
      : match;
  });
  const visibilityColor = value => product === 'metar'
    ? value < 400 ? '#ff55dc' : value <= 549 ? '#ff6969' : value <= 800 ? '#ffae5c' : value <= 1400 ? '#e6ca62' : '#70dfa3'
    : value < 550 ? '#ff55dc' : value < 1400 ? '#ff6969' : value < 2300 ? '#ffae5c' : '#70dfa3';
  html = html.replace(/R\d{2}[LCR]?\/[PM]?(\d{3,4})/g, (match, value) => `<span style="color:${visibilityColor(Number(value))};font-weight:700">${match}</span>`);
  html = html.replace(/\b(OVC|BKN)(\d{3})\b/g, (match, type, value) => {
    const hundredsOfFeet = Number(value);
    const color = product === 'metar'
      ? hundredsOfFeet < 2 ? '#ff6969'
        : hundredsOfFeet === 2 ? null
          : hundredsOfFeet <= 4 ? '#ffae5c'
            : hundredsOfFeet <= 30 ? '#e6ca62' : '#70dfa3'
      : hundredsOfFeet < 2 ? null
        : hundredsOfFeet <= 3 ? '#ff6969'
        : hundredsOfFeet <= 8 ? '#ffae5c'
          : hundredsOfFeet < 24 ? '#e6ca62' : '#70dfa3';
    if (!color) return match;
    return `<span style="color:${color};font-weight:700">${match}</span>`;
  });
  html = html.replace(/(^|\s)(\d{4})(?=\s|$)/g, (match, prefix, digits) => `<span style="color:${visibilityColor(Number(digits))};font-weight:700">${prefix}${digits}</span>`);
  const wordColors = { TCU: '#ffae5c', TS: '#e879e4', CB: '#ffae5c', FG: '#ffae5c', CAVOK: '#70dfa3' };
  html = html.replace(/\b(TCU|CAVOK|TS|CB|FG)\b/g, word => `<span style="color:${wordColors[word]};font-weight:700">${word}</span>`);
  return html;
}

function formatTafForFlightWindow(raw) {
  const info = getFlightWindow();
  const slices = getTafWindowSlices(raw, info);
  if (!slices.length) return formatWeatherMarkup(raw, 'taf');
  return slices.map(slice => {
    const html = formatWeatherMarkup(raw.slice(slice.start, slice.end), 'taf');
    return slice.highlight ? `<mark class="taf-flight-window" title="TAF-period som överlappar DEP–ARR">${html}</mark>` : html;
  }).join('');
}

function showStatus(message, isError = false) {
  const status = document.getElementById('status-message');
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.classList.add('visible');
  clearTimeout(showStatus.timeout);
  showStatus.timeout = setTimeout(() => status.classList.remove('visible'), 4500);
}

function handleSearch(event) {
  event.preventDefault();
  const input = document.getElementById('airport-input');
  const icao = input.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) {
    showStatus('Ange en giltig ICAO-kod med fyra bokstäver.', true);
    input.focus();
    return;
  }
  const added = addAirport(icao);
  if (added) input.value = '';
}

function addAirport(icao) {
  if (state.airports.some(item => item.icao === icao)) {
    showStatus(`${icao} finns redan i din briefing.`);
    return false;
  }
  state.airports.unshift({ icao });
  saveState();
  render();
  showStatus(`${icao} har lagts till.`);
  refreshAirport(icao);
  return true;
}

function removeAirport(icao) {
  state.airports = state.airports.filter(item => item.icao !== icao);
  state.groups.forEach(group => { group.airports = group.airports.filter(code => code !== icao); });
  state.selected.delete(icao);
  saveState();
  render();
}

function airportsInActiveGroup() {
  if (!state.activeGroup) return state.airports;
  const group = state.groups.find(item => item.id === state.activeGroup);
  return group ? state.airports.filter(item => group.airports.includes(item.icao)) : state.airports;
}

function render() {
  renderSidebar();
  renderCards();
  document.getElementById('group-count').textContent = String(state.groups.length);
  document.getElementById('selection-count').textContent = `${state.selected.size} kort markerade`;
}

function renderSidebar() {
  const list = document.getElementById('group-list');
  const allActive = !state.activeGroup;
  const all = `<button class="group-item ${allActive ? 'active' : ''}" data-group="all"><span class="group-item-name">Alla flygplatser</span><span class="group-item-count">${state.airports.length}</span></button>`;
  const groups = state.groups.map(group => `<div class="group-item ${state.activeGroup === group.id ? 'active' : ''}" data-group-row="${escapeHtml(group.id)}">
      <button class="group-item-name" data-group="${escapeHtml(group.id)}" title="Visa grupp">${escapeHtml(group.name)}</button>
      <span class="group-item-count">${group.airports.length}</span>
      <button class="icon-button group-delete" data-delete-group="${escapeHtml(group.id)}" aria-label="Ta bort gruppen ${escapeHtml(group.name)}" title="Ta bort grupp">×</button>
    </div>`).join('');
  list.innerHTML = state.groups.length ? all + groups : `${all}<div class="group-empty">Skapa en grupp för att samla flygplatser, till exempel för en rutt eller ett område.</div>`;
  list.querySelectorAll('[data-group]').forEach(button => button.addEventListener('click', () => {
    state.activeGroup = button.dataset.group === 'all' ? null : button.dataset.group;
    saveState();
    render();
    if (window.innerWidth < 1050) setSidebar(false);
  }));
  list.querySelectorAll('[data-delete-group]').forEach(button => button.addEventListener('click', () => deleteGroup(button.dataset.deleteGroup)));
}

function renderCards() {
  const grid = document.getElementById('airport-grid');
  const airports = airportsInActiveGroup();
  const empty = document.getElementById('empty-state');
  const selectedTime = state.arrivalTime || state.departureTime;
  document.getElementById('flight-time-note').textContent = getFlightWindow()
    ? `TAF-perioder som överlappar ${state.departureTime}–${state.arrivalTime} UTC markeras. Möjlig alternativflygplats bedöms inom fönstret.`
    : selectedTime
      ? `TAF analyseras för ${selectedTime} UTC${state.arrivalTime ? ' (ARR)' : ' (DEP)'}. Ange både DEP och ARR för att markera hela tidsfönstret.`
      : 'TAF analyseras för nuvarande tid UTC. Ange DEP och ARR för att markera flygfönstret.';
  const group = state.groups.find(item => item.id === state.activeGroup);
  document.getElementById('view-title').textContent = group ? group.name : 'Flygplatser';
  document.getElementById('view-eyebrow').textContent = group ? 'DIN GRUPP' : 'DIN ÖVERSIKT';
  document.getElementById('view-subtitle').textContent = group ? `${group.airports.length} flygplats${group.airports.length === 1 ? '' : 'er'} i gruppen.` : 'Väderläget på dina flygplatser, samlat på ett ställe.';
  grid.innerHTML = airports.map(airport => renderCard(airport)).join('');
  empty.classList.toggle('visible', airports.length === 0);
  grid.querySelectorAll('[data-select]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) state.selected.add(input.dataset.select);
    else state.selected.delete(input.dataset.select);
    document.getElementById('selection-count').textContent = `${state.selected.size} kort markerade`;
  }));
  grid.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => removeAirport(button.dataset.remove)));
  grid.querySelectorAll('[data-refresh]').forEach(button => button.addEventListener('click', () => refreshAirport(button.dataset.refresh)));
  grid.querySelectorAll('[data-assign]').forEach(select => select.addEventListener('change', () => assignAirport(select.dataset.assign, select.value)));
  grid.querySelectorAll('[data-wind-toggle]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.windToggle;
    if (state.expandedWind.has(key)) state.expandedWind.delete(key);
    else state.expandedWind.add(key);
    renderCards();
  }));
  grid.querySelectorAll('.drag-handle').forEach(handle => handle.addEventListener('dragstart', event => {
    const card = handle.closest('.airport-card');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.airport);
    card.classList.add('dragging');
  }));
  grid.querySelectorAll('.drag-handle').forEach(handle => handle.addEventListener('dragend', () => {
    grid.querySelectorAll('.airport-card').forEach(card => card.classList.remove('dragging', 'drag-over'));
  }));
  grid.querySelectorAll('.airport-card').forEach(card => {
    card.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      grid.querySelectorAll('.airport-card').forEach(other => other.classList.toggle('drag-over', other === card));
    });
    card.addEventListener('drop', event => {
      event.preventDefault();
      const sourceIcao = event.dataTransfer.getData('text/plain');
      reorderVisibleAirports(sourceIcao, card.dataset.airport);
    });
  });
}

function renderCard(airport) {
  const groups = state.groups.filter(group => group.airports.includes(airport.icao));
  const metar = airport.metar || {};
  const taf = airport.taf || {};
  const loading = state.busy.has(airport.icao);
  const metarText = metar.raw || (loading ? 'Hämtar aktuell observation…' : metar.error || 'Ingen METAR tillgänglig.');
  const tafText = taf.raw || (loading ? 'Hämtar prognos…' : taf.error || 'Ingen TAF tillgänglig.');
  const options = `<option value="">＋ Grupp</option>${state.groups.map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}`;
  return `<article class="airport-card" data-airport="${airport.icao}">
    <header class="card-head">
      <button class="drag-handle" type="button" draggable="true" aria-label="Dra för att flytta ${airport.icao}" title="Dra för att ändra ordning">⠿</button>
      <input class="card-select" type="checkbox" data-select="${airport.icao}" aria-label="Markera ${airport.icao}" ${state.selected.has(airport.icao) ? 'checked' : ''}>
      <div class="airport-ident"><h2 class="airport-code">${airport.icao}</h2><div class="airport-caption">ICAO · AVIATION WEATHER</div></div>
      <div class="card-actions">
        <select class="card-group-select" data-assign="${airport.icao}" aria-label="Lägg ${airport.icao} i grupp">${options}</select>
        <button class="icon-button" data-refresh="${airport.icao}" title="Uppdatera ${airport.icao}" aria-label="Uppdatera ${airport.icao}" ${loading ? 'disabled' : ''}>${loading ? '…' : '↻'}</button>
        <button class="icon-button" data-remove="${airport.icao}" title="Ta bort ${airport.icao}" aria-label="Ta bort ${airport.icao}">×</button>
      </div>
    </header>
    <section class="weather-block">
      ${renderWeatherToggle(airport.icao, 'metar', 'METAR', metar.time, metar.raw ? formatWeatherMarkup(metar.raw) : escapeHtml(metarText), metar.error ? 'error' : metar.raw ? '' : 'placeholder', metar.raw ? getWeatherConditionColors(metar.raw, 'metar') : null)}
      ${renderWeatherRunwayPanel(airport, 'metar')}
    </section>
    <section class="weather-block taf-block">
      ${renderWeatherToggle(airport.icao, 'taf', 'TAF', taf.time, taf.raw ? formatTafForFlightWindow(taf.raw) : escapeHtml(tafText), taf.error ? 'error' : taf.raw ? '' : 'placeholder', taf.raw ? getWeatherConditionColors(taf.raw, 'taf') : null)}
      ${renderWeatherRunwayPanel(airport, 'taf')}
      ${renderAlternateAssessment(airport)}
      ${groups.map(group => `<span class="group-chip">${escapeHtml(group.name)}</span>`).join(' ')}
    </section>
  </article>`;
}

function renderWeatherToggle(icao, product, label, time, report, reportClass, conditionColors) {
  const key = `${icao}:${product}`;
  const expanded = state.expandedWind.has(key);
  const indicator = conditionColors
    ? `<span class="weather-condition" style="--ceiling-color:${conditionColors.ceiling};--visibility-color:${conditionColors.visibility}" title="Övre halvan: takhöjd. Undre halvan: sikt." aria-label="Takhöjd ${conditionColors.ceilingLabel}; sikt ${conditionColors.visibilityLabel}"></span>`
    : '';
  return `<button class="weather-summary" type="button" data-wind-toggle="${key}" aria-expanded="${expanded}" aria-controls="wind-panel-${key.replace(':', '-')}" title="Visa eller dölj banvind för ${label}"><span class="weather-heading"><span class="weather-label">${indicator}${label}</span><span class="weather-toggle-right"><span class="weather-time">${escapeHtml(time || '—')}</span><span class="weather-wind-hint">${expanded ? 'Dölj banvind ▴' : 'Visa banvind ▾'}</span></span></span><span class="weather-text ${reportClass}">${report}</span></button>`;
}

function getWeatherConditionColors(raw, product) {
  const neutral = '#43515a';
  let relevantText = raw;
  if (product === 'taf') {
    const slices = getTafWindowSlices(raw, getFlightWindow());
    if (slices.length) {
      const selected = slices.filter(slice => slice.highlight);
      if (selected.length) relevantText = selected.map(slice => raw.slice(slice.start, slice.end)).join(' ');
    }
  }

  const severityColor = (value, ranges) => ranges.find(range => value >= range.min && value <= range.max) || null;
  const ceilingRanges = product === 'metar'
    ? [
      { min: 0, max: 199, color: '#ff6969', label: 'röd', severity: 4 },
      { min: 201, max: 400, color: '#ffae5c', label: 'orange', severity: 3 },
      { min: 401, max: 3000, color: '#e6ca62', label: 'gul', severity: 2 },
      { min: 3001, max: Infinity, color: '#70dfa3', label: 'grön', severity: 1 }
    ]
    : [
      { min: 200, max: 399, color: '#ff6969', label: 'röd', severity: 4 },
      { min: 400, max: 800, color: '#ffae5c', label: 'orange', severity: 3 },
      { min: 801, max: 2399, color: '#e6ca62', label: 'gul', severity: 2 },
      { min: 2400, max: Infinity, color: '#70dfa3', label: 'grön', severity: 1 }
    ];
  const visibilityRanges = product === 'metar'
    ? [
      { min: 0, max: 399, color: '#ff55dc', label: 'magenta', severity: 5 },
      { min: 400, max: 549, color: '#ff6969', label: 'röd', severity: 4 },
      { min: 550, max: 800, color: '#ffae5c', label: 'orange', severity: 3 },
      { min: 801, max: 1400, color: '#e6ca62', label: 'gul', severity: 2 },
      { min: 1401, max: Infinity, color: '#70dfa3', label: 'grön', severity: 1 }
    ]
    : [
      { min: 0, max: 549, color: '#ff55dc', label: 'magenta', severity: 5 },
      { min: 550, max: 1399, color: '#ff6969', label: 'röd', severity: 4 },
      { min: 1400, max: 2299, color: '#ffae5c', label: 'orange', severity: 3 },
      { min: 2300, max: Infinity, color: '#70dfa3', label: 'grön', severity: 1 }
    ];

  const ceilingValues = [...relevantText.matchAll(/\b(?:BKN|OVC|VV)(\d{3})\b/g)]
    .map(match => Number(match[1]) * 100)
    .map(value => severityColor(value, ceilingRanges))
    .filter(Boolean);
  const visibilityValues = product === 'metar'
    ? [...relevantText.matchAll(/\b(\d{4})\b|\bR\d{2}[LCR]?\/[PM]?(\d{3,4})\b/g)].map(match => Number(match[1] || match[2]))
    : [...relevantText.matchAll(/(?<!\/)\b(\d{4})\b(?!\/)/g)].map(match => Number(match[1]));
  if (/\bCAVOK\b/.test(relevantText)) visibilityValues.push(9999);
  const visibilityColors = visibilityValues.map(value => severityColor(value, visibilityRanges)).filter(Boolean);
  const worst = values => values.sort((a, b) => b.severity - a.severity)[0];
  const ceiling = worst(ceilingValues);
  const visibility = worst(visibilityColors);
  return {
    ceiling: ceiling?.color || (product === 'metar' ? '#70dfa3' : neutral),
    visibility: visibility?.color || neutral,
    ceilingLabel: ceiling?.label || (product === 'metar' ? 'ingen molnbas' : 'saknas'),
    visibilityLabel: visibility?.label || 'saknas'
  };
}

async function refreshAirport(icao) {
  if (state.busy.has(icao)) return;
  state.busy.add(icao);
  renderCards();
  try {
    const [metarResult, tafResult, runwayResult] = await Promise.allSettled([
      fetchWorkerWeather(icao, 'metar'),
      fetchWorkerWeather(icao, 'taf'),
      Promise.allSettled([fetchOurAirportsRunways(icao), fetchOurAirportsVariation(icao)])
    ]);
    const airport = state.airports.find(item => item.icao === icao);
    if (!airport) return;
    const updateReport = (product, result) => {
      const current = airport[product];
      if (result.status === 'fulfilled' && isCachedReport(result.value)) {
        airport[product] = result.value;
        return true;
      }
      if (!isCachedReport(current)) {
        airport[product] = result.status === 'rejected'
          ? { error: `Kunde inte hämta ${product.toUpperCase()}: ${result.reason?.message || 'okänt fel'}` }
          : { error: `Ingen ${product.toUpperCase()} tillgänglig.` };
      }
      return false;
    };
    const metarUpdated = updateReport('metar', metarResult);
    const tafUpdated = updateReport('taf', tafResult);
    if (metarUpdated || tafUpdated) saveState();
    const runwayData = runwayResult.status === 'fulfilled' ? runwayResult.value[0] : null;
    const variationData = runwayResult.status === 'fulfilled' ? runwayResult.value[1] : null;
    airport.runways = runwayData?.status === 'fulfilled' ? runwayData.value : [];
    airport.magneticVariation = variationData?.status === 'fulfilled' ? variationData.value : null;
    airport.runwayError = runwayData?.status === 'rejected' ? 'Banriktningar kunde inte hämtas från OurAirports.' : '';
    const failed = [metarResult, tafResult].some(result => result.status === 'rejected');
    if (failed) showStatus(`Väderdata för ${icao} kunde inte hämtas.`, true);
    document.getElementById('updated-label').textContent = `Senast uppdaterad ${new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
  } catch (error) {
    console.error(`Kunde inte hämta väder för ${icao}:`, error);
  } finally {
    state.busy.delete(icao);
    renderCards();
  }
}

function renderWeatherRunwayPanel(airport, product) {
  const key = `${airport.icao}:${product}`;
  if (!state.expandedWind.has(key)) return '';
  const isTaf = product === 'taf';
  const targetTime = isTaf ? getFlightTargetTime() : new Date();
  const runwayList = airport.runways || [];
  let rows;
  if (airport.runwayError) {
    rows = `<p class="runway-empty">${escapeHtml(airport.runwayError)}</p>`;
  } else if (!runwayList.length) {
    rows = `<p class="runway-empty">${state.busy.has(airport.icao) ? 'Hämtar banriktningar…' : 'Inga banor hittades i OurAirports för flygplatsen.'}</p>`;
  } else {
    const winds = extractWindForTime(isTaf ? airport.taf?.raw || '' : airport.metar?.raw || '', targetTime);
    rows = renderWindRunways(runwayList, winds);
  }
  return `<div class="wind-panel" id="wind-panel-${key.replace(':', '-')}">
    ${rows}
  </div>`;
}

function renderWindRunways(runways, winds) {
  if (!winds || winds.length === 0) return '<p class="runway-empty">Ingen aktiv vindgrupp kunde tolkas för den här tiden.</p>';
  const rows = [];
  runways.forEach(runway => {
    const heading = Number(runway.headingDegT);
    if (runway.headingDegT === null || runway.headingDegT === undefined || !Number.isFinite(heading)) return;
    const scenarios = [];
    winds.forEach(wind => {
      const angle = ((wind.direction - heading + 540) % 360) - 180;
      const headwind = wind.variable ? null : Math.round(wind.speed * Math.cos(angle * Math.PI / 180));
      const crosswind = wind.variable ? wind.speed : Math.abs(Math.round(wind.speed * Math.sin(angle * Math.PI / 180)));
      const gustCrosswind = wind.variable ? wind.gust : Math.abs(Math.round(wind.gust * Math.sin(angle * Math.PI / 180)));
      const hwLabel = headwind === null ? 'HW/TW —' : headwind >= 0 ? `HW ${headwind} kt` : `TW ${Math.abs(headwind)} kt`;
      const xwLabel = wind.variable
        ? `XW upp till ${crosswind} kt (VRB)${gustCrosswind > crosswind ? ` · by ${gustCrosswind} kt` : ''}`
        : `XW ${crosswind} kt${angle > 0 ? ' höger' : angle < 0 ? ' vänster' : ''}${gustCrosswind > crosswind ? ` · by ${gustCrosswind} kt` : ''}`;
      const variation = Number(runway.magneticVariation);
      const magneticHeading = Number.isFinite(variation) ? (heading - variation + 360) % 360 : null;
      const windDirection = wind.variable ? 'VRB' : `${String(wind.direction).padStart(3, '0')}°`;
      const windSpeed = `${wind.speed}${wind.gust > wind.speed ? `G${wind.gust}` : ''} kt`;
      scenarios.push({ ident: runway.ident, heading, magneticHeading, source: wind.source, windLabel: `${windDirection} ${windSpeed}`, headwind, crosswind, gustCrosswind, hwLabel, xwLabel });
    });
    scenarios.sort((a, b) => b.gustCrosswind - a.gustCrosswind || (a.headwind ?? -Infinity) - (b.headwind ?? -Infinity));
    if (scenarios.length) rows.push(scenarios[0]);
  });
  if (!rows.length) return '<p class="runway-empty">Saknar banor med sann riktning för att beräkna komponenter.</p>';
  rows.sort((a, b) => a.gustCrosswind - b.gustCrosswind || (b.headwind ?? -Infinity) - (a.headwind ?? -Infinity) || a.ident.localeCompare(b.ident));
  const best = rows[0];
  return rows.map(row => {
    const isBest = row === best;
    const heading = row.magneticHeading === null ? '' : ` · ${row.magneticHeading.toFixed(0)}°M`;
    return `<div class="runway-result ${isBest ? 'best' : ''}"><span>RWY ${escapeHtml(row.ident)}${heading}${isBest ? ' <b class="best-runway-badge">BÄST</b>' : ''}<small class="runway-wind-used">Vind beräknad på ${escapeHtml(row.windLabel)}${row.source && row.source !== 'METAR' ? ` · ${escapeHtml(row.source)}` : ''}</small></span><span>${escapeHtml(row.hwLabel)} · ${escapeHtml(row.xwLabel)}</span></div>`;
  }).join('');
}

function renderAlternateAssessment(airport) {
  const window = getFlightWindow();
  if (!window) return '';
  if (!airport.taf?.raw) return `<p class="alternate-assessment unavailable">Possible alternate: ingen TAF för bedömning inom DEP–ARR-fönstret.</p>`;
  const assessment = assessPossibleAlternate(airport.taf.raw, window);
  if (!assessment) return `<p class="alternate-assessment unavailable">Possible alternate: kunde inte bedömas inom DEP–ARR-fönstret.</p>`;
  const text = assessment.possible
    ? 'Possible alternate · dina planeringsminima uppfyllda i TAF-grupper som överlappar DEP–ARR'
    : `Planeringsminima ej uppfyllda · ${assessment.reasons.join(', ')}`;
  return `<p class="alternate-assessment ${assessment.possible ? 'possible' : 'not-possible'}">${escapeHtml(text)} <small>Bedömning mot dina inställda planeringsminima</small></p>`;
}

function getFlightWindow() {
  if (!state.departureTime || !state.arrivalTime) return null;
  const parse = value => {
    const match = value.match(/^(\d{2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const dep = parse(state.departureTime);
  const arr = parse(state.arrivalTime);
  if (dep === null || arr === null) return null;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMinutes(dep);
  const end = new Date(start);
  end.setUTCHours(Math.floor(arr / 60), arr % 60, 0, 0);
  if (arr <= dep) end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function getTafWindowSlices(raw, window) {
  if (!raw || !window) return [];
  const validity = raw.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (!validity) return [];
  const validityRange = resolveTafRange(new Date(window.start), validity.slice(1).map(Number), window);
  if (!validityRange) return [];
  const marker = /(?:^|\s)(FM\d{6}|BECMG\s+\d{4}\/\d{4}|TEMPO\s+\d{4}\/\d{4}|PROB\d{2}(?:\s+TEMPO)?\s+\d{4}\/\d{4})/g;
  const blocks = [...raw.matchAll(marker)].map(match => ({ start: match.index + match[0].length - match[1].length, text: match[1] }));
  const groups = [{ start: 0, end: blocks[0]?.start ?? raw.length, interval: validityRange, kind: 'BASE' }];
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    const fm = block.text.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    let interval;
    let kind;
    if (fm) {
      const start = resolveTafDayTime(new Date(window.start), Number(fm[1]), Number(fm[2]), Number(fm[3]), window);
      const nextFm = blocks.slice(index + 1).map(item => item.text.match(/^FM(\d{2})(\d{2})(\d{2})$/)).find(Boolean);
      const end = nextFm ? resolveTafDayTime(start, Number(nextFm[1]), Number(nextFm[2]), Number(nextFm[3]), window) : validityRange.end;
      interval = start && end ? { start, end } : null;
      kind = 'FM';
    } else {
      const range = block.text.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
      if (range) interval = resolveTafRange(new Date(window.start), range.slice(1).map(Number), window);
      kind = /^BECMG/.test(block.text) ? 'BECMG' : /^PROB/.test(block.text) ? 'PROB' : 'TEMPO';
    }
    if (interval) groups.push({ start: block.start, end: next?.start ?? raw.length, interval, kind });
  });
  groups.forEach((group, index) => {
    if (group.kind === 'BASE' || group.kind === 'FM') {
      const next = groups.slice(index + 1).find(item => item.kind === 'FM');
      if (next && group.interval.end > next.interval.start) group.interval.end = next.interval.start;
    }
  });
  const slices = [];
  let cursor = 0;
  for (const group of groups) {
    if (group.start > cursor) slices.push({ start: cursor, end: group.start, highlight: false });
    slices.push({ start: group.start, end: group.end, highlight: intervalsOverlap(group.interval, window) });
    cursor = group.end;
  }
  if (cursor < raw.length) slices.push({ start: cursor, end: raw.length, highlight: false });
  return slices;
}

function resolveTafRange(reference, parts, flightWindow) {
  const [startDay, startHour, endDay, endHour] = parts;
  for (let monthOffset = -1; monthOffset <= 1; monthOffset++) {
    const year = reference.getUTCFullYear();
    const month = reference.getUTCMonth() + monthOffset;
    const start = new Date(Date.UTC(year, month, startDay, startHour));
    if (start.getUTCDate() !== startDay) continue;
    const endDayCheck = new Date(Date.UTC(year, month, endDay));
    if (endDayCheck.getUTCDate() !== endDay) continue;
    let end = new Date(Date.UTC(year, month, endDay, endHour));
    if (end <= start) {
      end = endDay < startDay
        ? new Date(Date.UTC(year, month + 1, endDay, endHour))
        : new Date(Date.UTC(year, month, endDay + 1, endHour));
    }
    if (end > start && intervalsOverlap({ start, end }, flightWindow)) return { start, end };
  }
  return null;
}

function resolveTafDayTime(reference, day, hour, minute, flightWindow) {
  for (let monthOffset = -1; monthOffset <= 1; monthOffset++) {
    const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + monthOffset, day, hour, minute));
    if (date >= flightWindow.start - 86400000 && date <= flightWindow.end + 86400000) return date;
  }
  return null;
}

function intervalsOverlap(a, b) {
  return Boolean(a && b && a.start < b.end && b.start < a.end);
}

function assessPossibleAlternate(raw, window) {
  const groups = getTafWindowSlices(raw, window).filter(slice => slice.highlight);
  if (!groups.length) return null;
  const text = groups.map(group => raw.slice(group.start, group.end)).join(' ');
  const reasons = [];
  const validity = raw.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  const coverage = validity && resolveTafRange(new Date(window.start), validity.slice(1).map(Number), window);
  if (!coverage || coverage.start > window.start || coverage.end < window.end) reasons.push('TAF täcker inte hela DEP–ARR-fönstret');
  const rvr = [...text.matchAll(/R\d{2}[LCR]?\/([PM]?)(\d{3,4})/g)];
  if (rvr.some(match => Number(match[2]) <= 550 || match[1] === 'M')) reasons.push('RVR ≤ 550 m');
  const vis = [...text.matchAll(/(?:^|\s)(\d{4})(?=\s|$)/g)].map(match => Number(match[1]));
  if (vis.some(value => value < 1400)) reasons.push('sikt under 1 400 m');
  if ([...text.matchAll(/\b(?:BKN|OVC)(\d{3})/g)].some(match => Number(match[1]) <= 3)) reasons.push('molnbas BKN/OVC ≤ 300 ft');
  if (/\bTS\b/.test(text)) reasons.push('åska (TS)');
  return { possible: reasons.length === 0, reasons: reasons.length ? [...new Set(reasons)] : ['—'] };
}

function getFlightTargetTime() {
  const time = state.arrivalTime || state.departureTime;
  if (!time) return new Date();
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return new Date();
  const target = new Date();
  target.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
  return target;
}

async function fetchOurAirportsRunways(icao) {
  const cacheKey = `${RUNWAY_CACHE_PREFIX}${icao}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.expiresAt > Date.now() && Array.isArray(cached.runways)) return cached.runways;
  } catch (error) {
    console.warn(`Kunde inte läsa ban-cache för ${icao}:`, error);
  }

  if (!runwayCsvPromise) {
    runwayCsvPromise = fetch(OURAIRPORTS_RUNWAYS_URL)
      .then(response => {
        if (!response.ok) throw new Error(`OurAirports svarade HTTP ${response.status}`);
        return response.text();
      })
      .then(parseRunwayCsv)
      .catch(error => {
        runwayCsvPromise = null;
        throw error;
      });
  }

  const index = await runwayCsvPromise;
  const runways = index[icao] || [];
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + RUNWAY_CACHE_TTL_MS, runways }));
  } catch (error) {
    console.warn(`Kunde inte cacha banor för ${icao}:`, error);
  }
  return runways;
}

async function fetchOurAirportsVariation(icao) {
  const cacheKey = `${RUNWAY_CACHE_PREFIX}${icao}-variation`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.expiresAt > Date.now()) return cached.variation;
  } catch (error) {
    console.warn(`Kunde inte läsa variations-cache för ${icao}:`, error);
  }
  if (!navaidCsvPromise) {
    navaidCsvPromise = fetch(OURAIRPORTS_NAVAIDS_URL)
      .then(response => {
        if (!response.ok) throw new Error(`OurAirports svarade HTTP ${response.status}`);
        return response.text();
      })
      .then(parseNavaidVariations)
      .catch(error => { navaidCsvPromise = null; throw error; });
  }
  const index = await navaidCsvPromise;
  const variation = index[icao] ?? null;
  try { localStorage.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + RUNWAY_CACHE_TTL_MS, variation })); } catch (error) { console.warn(`Kunde inte cacha variation för ${icao}:`, error); }
  return variation;
}

function parseNavaidVariations(csvText) {
  const lines = csvText.split(/\r?\n/);
  if (!lines.length) return {};
  const headers = splitCsvLine(lines[0]);
  const airportIndex = headers.indexOf('associated_airport');
  const variationIndex = headers.indexOf('magnetic_variation_deg');
  const typeIndex = headers.indexOf('type');
  const latIndex = headers.indexOf('latitude_deg');
  const lonIndex = headers.indexOf('longitude_deg');
  if ([airportIndex, variationIndex].some(index => index < 0)) throw new Error('OurAirports NAVAID-CSV saknar variationskolumn.');
  const candidates = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitCsvLine(lines[i]);
    const airport = (cols[airportIndex] || '').trim().toUpperCase();
    const variation = Number.parseFloat(cols[variationIndex]);
    if (!airport || !Number.isFinite(variation)) continue;
    const type = cols[typeIndex] || '';
    const priority = /VOR|TACAN/.test(type) ? 0 : /NDB/.test(type) ? 1 : 2;
    const lat = Number.parseFloat(cols[latIndex]);
    const lon = Number.parseFloat(cols[lonIndex]);
    (candidates[airport] ||= []).push({ variation, priority, lat, lon });
  }
  const result = {};
  Object.entries(candidates).forEach(([icao, list]) => {
    list.sort((a, b) => a.priority - b.priority);
    result[icao] = list[0].variation;
  });
  return result;
}

function parseRunwayCsv(csvText) {
  const lines = csvText.split(/\r?\n/);
  if (!lines.length) return {};
  const headers = splitCsvLine(lines[0]);
  const airportIndex = headers.indexOf('airport_ident');
  const leIdentIndex = headers.indexOf('le_ident');
  const leHeadingIndex = headers.indexOf('le_heading_degT');
  const heIdentIndex = headers.indexOf('he_ident');
  const heHeadingIndex = headers.indexOf('he_heading_degT');
  const closedIndex = headers.indexOf('closed');
  if ([airportIndex, leIdentIndex, leHeadingIndex, heIdentIndex, heHeadingIndex].some(index => index < 0)) {
    throw new Error('OurAirports CSV saknar förväntade kolumner.');
  }

  const result = {};
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const columns = splitCsvLine(lines[index]);
    const airport = (columns[airportIndex] || '').trim().toUpperCase();
    const closed = closedIndex >= 0 && ['1', 'true'].includes((columns[closedIndex] || '').trim().toLowerCase());
    if (!airport || closed) continue;
    if (!result[airport]) result[airport] = [];
    for (const [identIndex, headingIndex] of [[leIdentIndex, leHeadingIndex], [heIdentIndex, heHeadingIndex]]) {
      const ident = (columns[identIndex] || '').trim();
      const heading = Number.parseFloat(columns[headingIndex]);
      if (ident) result[airport].push({ ident, headingDegT: Number.isFinite(heading) ? heading : null });
    }
  }
  return result;
}

function splitCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

async function fetchWorkerWeather(icao, product) {
  const url = new URL(WEATHER_WORKER_URL);
  url.searchParams.set('icao', icao);
  if (product !== 'metar') url.searchParams.set('product', product);
  const response = await fetch(url.toString());
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`Cloudflare Worker svarade HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  if (!body) return { raw: '', time: '' };

  const expected = product === 'taf' ? /\bTAF\b/ : /^(?:METAR|SPECI)\b/;
  if (!expected.test(body)) {
    if (/^(?:No data|Error fetching|Missing or invalid)\b/i.test(body)) throw new Error(body.slice(0, 160));
    const preview = body.replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`Worker returnerade inget ${product.toUpperCase()} för ${icao}${preview ? ` (svar: ${preview})` : ' (tomt svar)'}. Kontrollera att TAF-routen är driftsatt.`);
  }
  return { raw: body, time: product === 'metar' ? timestampFromMetar(body) : timestampFromTaf(body) };
}

function timestampFromMetar(raw) {
  const match = String(raw || '').match(/\b(\d{6}Z)\b/);
  return match ? match[1] : '';
}

function timestampFromTaf(raw) {
  const match = String(raw || '').match(/\bTAF\s+(?:(?:AMD|COR)\s+)?(?:[A-Z0-9]{4}\s+)?(\d{6}Z)\b/);
  return match ? match[1] : '';
}

function extractWindForTime(weatherText, targetTime) {
  if (!weatherText || typeof weatherText !== 'string') return [];
  const parseWind = text => {
    const match = text.match(/(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT(?=\s|$)/i);
    if (!match) return null;
    const speed = Number.parseInt(match[2], 10);
    const gust = match[3] ? Number.parseInt(match[3], 10) : speed;
    return {
      direction: match[1] === 'VRB' ? 0 : Number.parseInt(match[1], 10),
      variable: match[1] === 'VRB',
      speed,
      gust,
      raw: match[0].trim()
    };
  };

  if (!/\bTAF\b/.test(weatherText)) {
    const wind = parseWind(weatherText);
    return wind ? [{ ...wind, source: 'METAR' }] : [];
  }

  const validity = weatherText.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (!validity) return [];
  const refDate = targetTime instanceof Date && !Number.isNaN(targetTime.getTime()) ? targetTime : new Date();
  const validityWindow = makeUtcInterval(refDate, Number(validity[1]), Number(validity[2]), Number(validity[3]), Number(validity[4]));
  if (!validityWindow) return [];
  const { start, end } = validityWindow;
  const target = refDate.getTime();

  const trigger = /\b(FM\d{6}|BECMG\s+\d{4}\/\d{4}|TEMPO\s+\d{4}\/\d{4}|PROB\d{2}(?:\s+TEMPO)?\s+\d{4}\/\d{4})/g;
  const blocks = [...weatherText.matchAll(trigger)].map(match => ({ index: match.index, text: match[1] }));
  const baseEnd = blocks.length ? blocks[0].index : weatherText.length;
  const baseWind = parseWind(weatherText.slice(0, baseEnd));
  const baselineChanges = [];
  const activeChanges = [];

  blocks.forEach((block, index) => {
    const nextIndex = blocks[index + 1]?.index ?? weatherText.length;
    const blockText = weatherText.slice(block.index, nextIndex);
    let blockStart;
    let blockEnd;
    let source;
    const fm = block.text.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    const interval = block.text.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);

    if (fm) {
      blockStart = resolveUtcDateOnOrBefore(refDate, Number(fm[1]), Number(fm[2]), Number(fm[3]));
      const nextFm = blocks.slice(index + 1).find(candidate => /^FM/.test(candidate.text));
      blockEnd = nextFm
        ? resolveUtcDateAfter(blockStart, Number(nextFm.text.slice(2, 4)), Number(nextFm.text.slice(4, 6)), Number(nextFm.text.slice(6, 8)))
        : end;
      source = 'FM';
    } else if (interval) {
      const window = makeUtcIntervalNear(refDate, Number(interval[1]), Number(interval[2]), Number(interval[3]), Number(interval[4]));
      if (!window) return;
      blockStart = window.start;
      blockEnd = window.end;
      source = /^BECMG/.test(block.text) ? 'BECMG' : /^PROB/.test(block.text) ? 'PROB' : 'TEMPO';
    } else {
      return;
    }

    const wind = parseWind(blockText);
    if (!wind) return;
    if (source === 'FM') {
      if (target >= blockStart.getTime() && target < blockEnd.getTime()) {
        baselineChanges.push({ ...wind, source, effectiveTime: blockStart.getTime() });
      }
      return;
    }
    if (source === 'BECMG') {
      if (target >= blockStart.getTime() && target < blockEnd.getTime()) {
        activeChanges.push({ ...wind, source });
      } else if (target >= blockEnd.getTime()) {
        baselineChanges.push({ ...wind, source, effectiveTime: blockEnd.getTime() });
      }
      return;
    }
    if (target >= blockStart.getTime() && target < blockEnd.getTime()) activeChanges.push({ ...wind, source });
  });

  if (baseWind) baselineChanges.push({ ...baseWind, source: 'BASE', effectiveTime: start.getTime() });
  baselineChanges.sort((a, b) => b.effectiveTime - a.effectiveTime);
  const active = baselineChanges.length ? [baselineChanges[0]] : [];
  active.push(...activeChanges);
  return active;
}

function makeUtcInterval(reference, startDay, startHour, endDay, endHour, startMinute = 0, endMinute = 0) {
  const target = reference.getTime();
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const candidates = [];
  for (let startOffset = -1; startOffset <= 1; startOffset++) {
    const start = new Date(Date.UTC(year, month + startOffset, startDay, startHour, startMinute, 0));
    for (let endOffset = startOffset; endOffset <= startOffset + 1; endOffset++) {
      const end = new Date(Date.UTC(year, month + endOffset, endDay, endHour, endMinute, 0));
      if (end > start && target >= start.getTime() && target < end.getTime()) candidates.push({ start, end });
    }
  }
  candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return candidates[0] || null;
}

function makeUtcIntervalNear(reference, startDay, startHour, endDay, endHour) {
  const target = reference.getTime();
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();
  const intervals = [];
  for (let startOffset = -1; startOffset <= 1; startOffset++) {
    const start = new Date(Date.UTC(year, month + startOffset, startDay, startHour, 0, 0));
    for (let endOffset = startOffset; endOffset <= startOffset + 1; endOffset++) {
      const end = new Date(Date.UTC(year, month + endOffset, endDay, endHour, 0, 0));
      if (end > start) intervals.push({ start, end });
    }
  }
  const active = intervals.filter(interval => target >= interval.start.getTime() && target < interval.end.getTime());
  if (active.length) return active.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  const completed = intervals.filter(interval => interval.end.getTime() <= target);
  completed.sort((a, b) => b.end - a.end);
  return completed[0] || null;
}

function resolveUtcDateOnOrBefore(reference, day, hour, minute = 0) {
  const candidates = [];
  for (let offset = -1; offset <= 0; offset++) {
    const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + offset, day, hour, minute, 0));
    if (date <= reference) candidates.push(date);
  }
  candidates.sort((a, b) => b - a);
  return candidates[0] || new Date(NaN);
}

function resolveUtcDateAfter(reference, day, hour, minute = 0) {
  const candidates = [];
  for (let offset = 0; offset <= 1; offset++) {
    const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + offset, day, hour, minute, 0));
    if (date > reference) candidates.push(date);
  }
  candidates.sort((a, b) => a - b);
  return candidates[0] || new Date(NaN);
}

async function refreshAll(options = {}) {
  const airports = [...state.airports];
  if (!airports.length) {
    if (!options.quiet) showStatus('Lägg till en flygplats innan du uppdaterar vädret.');
    return;
  }
  if (!options.quiet) showStatus(`Uppdaterar METAR och TAF för ${airports.length} flygplats${airports.length === 1 ? '' : 'er'}…`);
  await Promise.all(airports.map(airport => refreshAirport(airport.icao)));
  if (!options.quiet) showStatus('Väderuppdateringen är klar.');
}

function assignAirport(icao, groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group) return;
  if (!group.airports.includes(icao)) group.airports.push(icao);
  state.selected.delete(icao);
  saveState();
  render();
  showStatus(`${icao} lades till i ${group.name}.`);
}

function reorderVisibleAirports(sourceIcao, targetIcao) {
  if (!sourceIcao || sourceIcao === targetIcao) return;
  const ordered = airportsInActiveGroup().slice();
  const visibleIds = new Set(ordered.map(airport => airport.icao));
  const from = ordered.findIndex(airport => airport.icao === sourceIcao);
  const to = ordered.findIndex(airport => airport.icao === targetIcao);
  if (from < 0 || to < 0) return;
  ordered.splice(to, 0, ordered.splice(from, 1)[0]);
  let visibleIndex = 0;
  state.airports = state.airports.map(airport => visibleIds.has(airport.icao) ? ordered[visibleIndex++] : airport);
  saveState();
  render();
}

function createGroupFromSelection() {
  if (!state.selected.size) {
    showStatus('Markera minst ett flygplatskort först.', true);
    return;
  }
  const name = window.prompt('Vad ska gruppen heta?');
  if (!name || !name.trim()) return;
  const group = { id: `group-${Date.now()}`, name: name.trim().slice(0, 48), airports: [...state.selected] };
  state.groups.push(group);
  state.selected.clear();
  state.activeGroup = group.id;
  saveState();
  render();
  showStatus(`Gruppen ${group.name} skapades.`);
}

function deleteGroup(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group) return;
  state.groups = state.groups.filter(item => item.id !== groupId);
  if (state.activeGroup === groupId) state.activeGroup = null;
  saveState();
  render();
  showStatus(`Gruppen ${group.name} togs bort.`);
}

function setSidebar(open) {
  state.sidebarOpen = open;
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('sidebar').setAttribute('aria-hidden', String(!open));
  document.getElementById('sidebar-scrim').classList.toggle('visible', open && window.innerWidth < 1050);
  document.getElementById('open-sidebar').setAttribute('aria-expanded', String(open));
}
