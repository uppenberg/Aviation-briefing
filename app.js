const STORAGE_KEY = 'aviation_viewer_db';

const defaultData = {
  activeSheet: 'Standard',
  sheets: {
    'Standard': {
      depTime: 'NOW',
      arrTime: 'NOW',
      icaos: ['ESNU', 'ESSA']
    },
    '_DoldFlik': {
      depTime: 'NOW',
      arrTime: 'NOW',
      icaos: ['ESGG']
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
  html += '<tr><th class="col-icao">ICAO</th><th class="col-metar">METAR</th><th class="col-taf">TAF</th><th class="col-notam">NOTAM (Öppettider m.m.)</th></tr>';

  icaos.forEach(icao => {
    const wData = (db.weatherCache[icao]) || {};
    const notamData = (db.notamCache[icao]) || {};

    const metarHtml = wData.metarHtml || '<span style="color:#aaa;">-</span>';
    const tafHtml = wData.tafHtml || '<span style="color:#aaa;">-</span>';
    const metarNote = wData.metarNote || '';
    const tafNote = wData.tafNote || '';

    const metarClass = 'col-metar ' + (metarNote ? 'has-note' : '');
    const metarAttr = metarNote ? 'data-note="' + escapeHtml(metarNote) + '"' : '';

    const tafClass = 'col-taf ' + (tafNote ? 'has-note' : '');
    const tafAttr = tafNote ? 'data-note="' + escapeHtml(tafNote) + '"' : '';

    // NOTAM-hantering med filtrering och kolumnvisning
    const filteredNotams = notamData.filteredNotams || [];
    const allNotamsText = notamData.allNotamsSummary || 'Inga aktiva NOTAMs';

    let notamCellHtml = "";
    if (filteredNotams.length > 0) {
      filteredNotams.forEach((notamText, n) => {
        notamCellHtml += '<div class="has-note notam-badge" data-note="' + escapeHtml(notamText) + '">📌 ' + (n + 1) + ' (Filt)</div>';
      });
    } else {
      notamCellHtml = '<span style="color: #aaa;" class="has-note" data-note="' + escapeHtml(allNotamsText) + '">Inga matchande (Visa alla)</span>';
    }

    html += '<tr>';
    html += '<td class="col-icao" onclick="toggleDeleteButton(\'btn-' + icao + '\')">';
    html += '<span>' + icao + '</span>';
    html += '<button id="btn-' + icao + '" class="delete-row-btn" onclick="handleDeleteIcao(event, \'' + icao + '\')">❌</button>';
    html += '</td>';
    html += '<td class="' + metarClass + '" ' + metarAttr + '>' + metarHtml + '</td>';
    html += '<td class="' + tafClass + '" ' + tafAttr + '>' + tafHtml + '</td>';
    html += '<td class="col-notam" data-note="' + escapeHtml(allNotamsText) + '"><div class="has-note" style="display:inline-block; width:100%;">' + notamCellHtml + '</div></td>';
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

  if (!confirm("⚠️ VARNING: Är du säker på att du vill ta bort fliken \"" + db.activeSheet + "\"?")) return;

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

  showStatus('Hämtar avancerad METAR & TAF...', 'loading');

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

  showStatus('Hämtar och filtrerar NOTAMs...', 'loading');

  try {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' UTC';
    const FILTER_KEYWORDS = ["HOURS OF SERVICE", "OPR HR", "OPERATING HOURS", "PPR", "AD CLSD"];

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
            const simplified = `[Hämtad ${timestamp}]\n` + msg;
            allNotams.push(simplified);

            const upper = msg.toUpperCase();
            const matches = FILTER_KEYWORDS.some(kw => upper.includes(kw));
            if (matches) {
              filteredNotams.push(simplified);
            }
          });
        } catch (e) {
          console.error("Fel vid tolkning av NOTAM för " + icao, e);
        }
      }

      db.notamCache[icao] = {
        allNotamsSummary: allNotams.length > 0 ? "--- ALLA AKTIVA NOTAM FÖR " + icao + " ---\n\n" + allNotams.join("\n\n--------------------\n\n") : "Inga aktiva NOTAMs för " + icao,
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

// Avancerad färgkodning för METAR/TAF (Sikt, Moln, TS, CB, FG, RVR)
function formatRichWeather(text, isTaf) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Markera TS, CB, FG, CAVOK med färger
  html = html.replace(/\b(TS|CB|TCU)\b/g, '<span style="color:#ff9900; font-weight:bold;">$1</span>');
  html = html.replace(/\bFG\b/g, '<span style="color:#ff9900; font-weight:bold;">FG</span>');
  html = html.replace(/\bCAVOK\b/g, '<span style="color:#00ff00; font-weight:bold;">CAVOK</span>');

  // Molnhöjdsfärgkodning (BKN/OVC 001-003 röd, 004-008 orange, 009-024 gul, 025+ grön)
  html = html.replace(/\b(OVC|BKN)(\d{3})\b/g, function(match, type, heightStr) {
    const h = parseInt(heightStr, 10);
    let color = '#00ff00';
    if (h >= 1 && h <= 3) color = '#ff0000';
    else if (h >= 4 && h <= 8) color = '#ff9900';
    else if (h >= 9 && h <= 24) color = '#EAB308';
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
