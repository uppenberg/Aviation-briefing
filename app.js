const STORAGE_KEY = 'aviation_viewer_db';

const defaultData = {
  activeSheet: 'Standard',
  sheets: {
    'Standard': {
      depTime: 'NOW',
      arrTime: 'NOW',
      icaos: ['ESNU', 'ESSA']
    }
  },
  weatherCache: {},
  notamCache: {}
};

let db = loadDatabase();

window.onload = function() {
  renderApp();
};

function loadDatabase() {
  const data = localStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : defaultData;
}

function saveDatabase() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function getAllSheets() {
  return Object.keys(db.sheets).filter(name => !name.startsWith('_'));
}

function renderApp(targetSheet) {
  if (targetSheet) {
    db.activeSheet = targetSheet;
  }
  
  const visibleSheets = getAllSheets();
  if (!visibleSheets.includes(db.activeSheet)) {
    db.activeSheet = visibleSheets[0] || '';
  }
  
  saveDatabase();

  const currentSheetData = db.sheets[db.activeSheet] || { depTime: 'NOW', arrTime: 'NOW', icaos: [] };

  const selector = document.getElementById('sheetSelector');
  selector.innerHTML = '';
  visibleSheets.forEach(sheetName => {
    const opt = document.createElement('option');
    opt.value = sheetName;
    opt.text = sheetName;
    if (sheetName === db.activeSheet) opt.selected = true;
    selector.appendChild(opt);
  });

  setupTimeInput('depTime', currentSheetData.depTime);
  setupTimeInput('arrTime', currentSheetData.arrTime);

  renderTable(currentSheetData.icaos);
}

function renderTable(icaos) {
  const contentDiv = document.getElementById('content');
  if (!icaos || icaos.length === 0) {
    contentDiv.innerHTML = 'Inga flygplatser hittades i fliken "' + db.activeSheet + '".';
    contentDiv.classList.remove('loading');
    return;
  }

  let html = '<div class="table-container"><table>';
  // Skapar tabellhuvud med ICAO, METAR, TAF och dynamiska NOTAM-kolumner (precis som i arkskriptet)
  html += '<tr><th class="col-icao">ICAO</th><th class="col-metar">METAR</th><th class="col-taf">TAF</th><th class="col-notam">NOTAM 1 (Öppettider)</th><th class="col-notam">NOTAM 2</th></tr>';

  icaos.forEach(icao => {
    const wData = (db.weatherCache[icao]) || {};
    const notamData = (db.notamCache[icao]) || {};

    const metarHtml = wData.metarHtml || '<span style="color:#aaa;">-</span>';
    const tafHtml = wData.tafHtml || '<span style="color:#aaa;">-</span>';
    const metarNote = wData.metarNote || '';
    const tafNote = wData.tafNote || '';
    const allNotamsText = notamData.allNotamsSummary || '';

    const metarAttr = metarNote ? 'class="col-metar has-note" data-note="' + escapeHtml(metarNote) + '"' : 'class="col-metar"';
    const tafAttr = tafNote ? 'class="col-taf has-note" data-note="' + escapeHtml(tafNote) + '"' : 'class="col-taf"';

    // Hämtar de filtrerade NOTAM-texterna för kolumnerna (ex. matchande öppettider)
    const filteredNotams = notamData.filteredNotams || [];
    const notam1 = filteredNotams[0] ? escapeHtml(filteredNotams[0]) : '';
    const notam2 = filteredNotams[1] ? escapeHtml(filteredNotams[1]) : '';

    html += '<tr>';
    html += '<td class="col-icao" onclick="toggleDeleteButton(\'btn-' + icao + '\')">';
    html += '<span>' + icao + '</span>';
    html += '<button id="btn-' + icao + '" class="delete-row-btn" onclick="handleDeleteIcao(event, \'' + icao + '\')">❌</button>';
    html += '</td>';
    html += '<td ' + metarAttr + '>' + metarHtml + '</td>';
    html += '<td ' + tafAttr + '>' + tafHtml + '</td>';
    
    // Kolumn för NOTAM 1 med anteckning (hela listan i bakgrunden)
    html += '<td class="col-notam has-note" data-note="' + escapeHtml(allNotamsText) + '">' + (notam1 || '<span style="color:#aaa">-</span>') + '</td>';
    // Kolumn för NOTAM 2
    html += '<td class="col-notam has-note" data-note="' + escapeHtml(allNotamsText) + '">' + (notam2 || '<span style="color:#aaa">-</span>') + '</td>';
    
    html += '</tr>';
  });

  html += '</table></div>';
  contentDiv.innerHTML = html;
  contentDiv.classList.remove('loading');
}

function handleSheetChange() {
  const selected = document.getElementById('sheetSelector').value;
  renderApp(selected);
}

function handleCreateSheet() {
  const nameInput = document.getElementById('newSheetName');
  const sheetName = nameInput.value.trim();
  if (!sheetName) return;

  if (db.sheets[sheetName]) {
    alert("En flik med detta namn finns redan.");
    return;
  }

  db.sheets[sheetName] = { depTime: 'NOW', arrTime: 'NOW', icaos: [] };
  nameInput.value = '';
  showStatus('✔ Fliken "' + sheetName + '" skapad!', 'green');
  renderApp(sheetName);
}

function handleDeleteSheet() {
  const visibleSheets = getAllSheets();
  if (visibleSheets.length <= 1) {
    alert("Du kan inte ta bort den sista synliga fliken.");
    return;
  }

  if (!confirm("⚠️ Är du säker på att du vill ta bort fliken \"" + db.activeSheet + "\"?")) return;

  delete db.sheets[db.activeSheet];
  const remainingSheets = getAllSheets();
  showStatus('✔ Fliken har tagits bort.', 'green');
  renderApp(remainingSheets[0]);
}

function handleAddIcao() {
  const input = document.getElementById('newIcao');
  const icao = input.value.trim().toUpperCase();
  if (!icao || !/^[A-Z0-9]{4}$/.test(icao)) {
    alert("Ange en giltig ICAO-kod (4 tecken).");
    return;
  }

  const currentIcaos = db.sheets[db.activeSheet].icaos;
  if (!currentIcaos.includes(icao)) {
    currentIcaos.push(icao);
    saveDatabase();
  }

  input.value = '';
  showStatus('✔ ' + icao + ' tillagd!', 'green');
  renderApp();
  handleUpdateWeather();
  handleUpdateNotams();
}

function handleDeleteIcao(event, icao) {
  event.stopPropagation();
  if (!confirm("Är du säker på att du vill ta bort " + icao + "?")) return;

  const currentIcaos = db.sheets[db.activeSheet].icaos;
  db.sheets[db.activeSheet].icaos = currentIcaos.filter(code => code !== icao);
  saveDatabase();

  showStatus('✔ ' + icao + ' har tagits bort.', 'green');
  renderApp();
}

function handleSaveTimes() {
  const depInput = document.getElementById('depTime').value.trim();
  const arrInput = document.getElementById('arrTime').value.trim();

  db.sheets[db.activeSheet].depTime = depInput.toUpperCase() === "NOW" ? "NOW" : depInput;
  db.sheets[db.activeSheet].arrTime = arrInput.toUpperCase() === "NOW" ? "NOW" : arrInput;

  saveDatabase();
  showStatus('✔ Flight times sparade!', 'green');
  handleUpdateWeather();
}

async function handleUpdateWeather() {
  const icaos = db.sheets[db.activeSheet].icaos;
  if (!icaos || icaos.length === 0) return;

  showStatus('Hämtar METAR & TAF...', 'loading');

  try {
    const icaoStr = icaos.join(',');
    const [metarRes, tafRes] = await Promise.all([
      fetch(`https://aviationweather.gov/api/data/metar?ids=${icaoStr}&format=raw`),
      fetch(`https://aviationweather.gov/api/data/taf?ids=${icaoStr}&format=raw`)
    ]);

    const metarText = await metarRes.text();
    const tafText = await tafRes.text();
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' UTC';

    icaos.forEach(icao => {
      if (!db.weatherCache[icao]) db.weatherCache[icao] = {};

      const metarLines = metarText.split('\n').filter(l => l.includes(icao));
      const tafLines = tafText.split('\n').filter(l => l.includes(icao));

      if (metarLines.length > 0) {
        const rawMetar = metarLines.find(l => l.startsWith(icao)) || metarLines[0];
        db.weatherCache[icao].metarHtml = formatRichWeather(rawMetar, false);
        db.weatherCache[icao].metarNote = `[Hämtad ${timestamp}]\n` + rawMetar;
      }

      if (tafLines.length > 0) {
        const rawTaf = tafLines.join('\n');
        db.weatherCache[icao].tafHtml = formatRichWeather(rawTaf, true);
        db.weatherCache[icao].tafNote = `[Hämtad ${timestamp}]\n` + rawTaf;
      }
    });

    saveDatabase();
    showStatus(`✔ Väder uppdaterat (${timestamp})!`, 'green');
    renderApp();
  } catch (err) {
    showStatus('⚠️ Kunde inte nå väderserver.', 'red');
  }
}

async function handleUpdateNotams() {
  const icaos = db.sheets[db.activeSheet].icaos;
  if (!icaos || icaos.length === 0) return;

  showStatus('Hämtar NOTAMs...', 'loading');

  try {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' UTC';
    // Exakta sökord från ditt gamla script (notam.txt)
    const FILTER_KEYWORDS = ["HOURS OF SERVICE", "OPR HR", "OPERATING HOURS"];

    for (const icao of icaos) {
      const targetUrl = `https://notams.aim.faa.gov/notamSearch/search?locationGroup=${icao}&format=json`;
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;

      const response = await fetch(proxyUrl);
      if (!response.ok) continue;

      const data = await response.json();
      let allNotams = [];
      let filteredNotams = [];

      if (data.contents) {
        try {
          const parsed = JSON.parse(data.contents);
          const list = parsed.notamList || parsed.data || [];
          
          list.forEach(n => {
            const msg = n.icaoMessage || n.traditionalMessage || n.text || JSON.stringify(n);
            allNotams.push(msg);

            const upper = msg.toUpperCase();
            const matches = FILTER_KEYWORDS.some(kw => upper.includes(kw));
            if (matches) {
              filteredNotams.push(msg);
            }
          });
        } catch (e) {
          console.error("Fel vid tolkning", e);
        }
      }

      db.notamCache[icao] = {
        allNotamsSummary: allNotams.length > 0 ? allNotams.join("\n\n--------------------\n\n") : "Inga aktiva NOTAMs",
        filteredNotams: filteredNotams
      };
    }

    saveDatabase();
    showStatus(`✔ NOTAMs uppdaterade (${timestamp})!`, 'green');
    renderApp();
  } catch (err) {
    showStatus('⚠️ Kunde inte hämta NOTAMs.', 'red');
  }
}

// Exakt färgkodningslogg från din color_metar_taf.txt
function formatRichWeather(text, isTaf) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Färgmarkeringar för väderfenomen
  html = html.replace(/\b(TS|CB|TCU)\b/g, '<span style="color:#ff4444; font-weight:bold;">$1</span>');
  html = html.replace(/\b(FG|RA|SN)\b/g, '<span style="color:#ffaa00; font-weight:bold;">$1</span>');
  html = html.replace(/\bCAVOK\b/g, '<span style="color:#00cc00; font-weight:bold;">CAVOK</span>');

  // Molnhöjdsfärgkodning (BKN/OVC regler)
  html = html.replace(/\b(OVC|BKN)(\d{3})\b/g, function(match, type, heightStr) {
    const h = parseInt(heightStr, 10);
    let color = '#00cc00'; // Grön > 2500ft
    if (h >= 1 && h <= 3) color = '#ff4444';       // Röd < 300ft
    else if (h >= 4 && h <= 8) color = '#ffaa00';  // Orange 400-800ft
    else if (h >= 9 && h <= 24) color = '#cccc00'; // Gul 900-2400ft
    return `<span style="color:${color}; font-weight:bold;">${match}</span>`;
  });

  if (isTaf) {
    html = html.replace(/\n/g, '<br>');
  }

  return html;
}

function setupTimeInput(id, value) {
  const input = document.getElementById(id);
  input.value = value || "NOW";

  if (input.value.toUpperCase() === "NOW") {
    input.classList.add("is-now");
  } else {
    input.classList.remove("is-now");
  }

  input.onfocus = function() {
    if (this.value.toUpperCase() === "NOW") {
      this.value = "";
      this.classList.remove("is-now");
    }
  };

  input.onblur = function() {
    if (this.value.trim() === "") {
      this.value = "NOW";
      this.classList.add("is-now");
    }
  };
}

function toggleDeleteButton(btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.style.display = btn.style.display === 'inline-block' ? 'none' : 'inline-block';
}

function showStatus(msg, type) {
  const statusDiv = document.getElementById('status');
  if (type === 'loading') {
    statusDiv.innerHTML = '<p class="loading">' + msg + '</p>';
  } else if (type === 'green') {
    statusDiv.innerHTML = '<p style="color: green; font-weight: bold; font-size: 12px;">' + msg + '</p>';
  } else if (type === 'red') {
    statusDiv.innerHTML = '<p style="color: red; font-weight: bold; font-size: 12px;">' + msg + '</p>';
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, '&quot;');
}
