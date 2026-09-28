// =========================================================================
// PWA APP.JS - METAR, TAF, BANOR OCH VINDBERÄKNING
// =========================================================================

// Globala variabler för cachad data
let runwaysCache = {};
let stationCache = {};

document.addEventListener('DOMContentLoaded', () => {
  // Initiera appen när DOM har laddats
  initApp();
});

function initApp() {
  const fetchBtn = document.getElementById('fetch-weather-btn');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', loadWeatherData);
  }
}

// 1. Hämta och parsa väder (METAR & TAF)
async function loadWeatherData() {
  const stationInput = document.getElementById('station-input');
  if (!stationInput) return;
  
  const icao = stationInput.value.trim().toUpperCase();
  if (!icao) return;

  try {
    // Exempel på anrop till aviationweather.gov API för JSON-format
    const url = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`;
    const tafUrl = `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`;

    const [metarRes, tafRes] = await Promise.all([
      fetch(url),
      fetch(tafUrl)
    ]);

    const metarData = await metarRes.json();
    const tafData = await tafRes.json();

    const metarRaw = metarData.length > 0 ? metarData[0].rawOb : 'No METAR available';
    const tafRaw = tafData.length > 0 ? tafData[0].rawOb : 'No TAF available';

    // Rendera ut i DOM med vår avancerade formatering
    const targetTimeStr = document.getElementById('time-input') ? document.getElementById('time-input').value : 'NOW';

    document.getElementById('metar-output').innerHTML = formatRichWeather(metarRaw, false, targetTimeStr);
    document.getElementById('taf-output').innerHTML = formatRichWeather(tafRaw, true, targetTimeStr);

  } catch (error) {
    console.error('Kunde inte hämta väderdata:', error);
  }
}


// =========================================================================
// HJÄLPFUNKTIONER FÖR TIDER OCH ESCAPING
// =========================================================================
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseFlightTime(val) {
  if (!val) return null;
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  if (typeof val === "string" && val.toUpperCase() === "NOW") return new Date();
  
  if (typeof val === "string") {
    const match = val.match(/^(\d{1,2}):?(\d{2})(?::\d{2})?$/);
    if (match) {
      const hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));
    }
  }
  return new Date();
}

function makeUtcDate(refDate, day, hour, minute = 0) {
  const d = new Date(refDate);
  d.setUTCDate(day);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}


// =========================================================================
// TAF TIDSHANTERING & AKTIVA INTERVALL
// =========================================================================
function getActiveTafRanges(tafText, targetTime) {
  const refDate = (targetTime instanceof Date && !isNaN(targetTime.getTime())) ? targetTime : new Date();
  const refUtc = refDate.getTime();

  const headerValidityMatch = tafText.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
  if (!headerValidityMatch) return [];

  const headStartDay = parseInt(headerValidityMatch[1], 10);
  const headStartHour = parseInt(headerValidityMatch[2], 10);
  const headEndDay = parseInt(headerValidityMatch[3], 10);
  const headEndHour = parseInt(headerValidityMatch[4], 10);

  const baseStart = makeUtcDate(refDate, headStartDay, headStartHour);
  let baseEnd = makeUtcDate(refDate, headEndDay, headEndHour);
  if (baseEnd <= baseStart) baseEnd.setUTCDate(baseEnd.getUTCDate() + 1);

  const changeRegex = /(?:^|\s)(FM\d{6}|BECMG\s+\d{4}\/\d{4}|TEMPO\s+\d{4}\/\d{4}|PROB\d{2}\s+(?:TEMPO\s+)?\d{4}\/\d{4})/g;
  let blocks = [];
  let match;

  while ((match = changeRegex.exec(tafText)) !== null) {
    const matchStart = match.index + (match[0].length - match[1].length);
    blocks.push({
      startIdx: matchStart,
      text: match[1]
    });
  }

  if (blocks.length === 0) {
    if (refUtc >= baseStart.getTime() && refUtc < baseEnd.getTime()) {
      return [{ start: 0, end: tafText.length }];
    }
    return [];
  }

  let segments = [{
    startIdx: 0,
    endIdx: blocks[0].startIdx,
    startTime: baseStart,
    endTime: baseEnd,
    type: "BASE"
  }];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const startIdx = b.startIdx;
    const endIdx = (i < blocks.length - 1) ? blocks[i + 1].startIdx : tafText.length;
    let sTime = null;
    let eTime = null;
    let type = "CHANGE";

    if (/^PROB/.test(b.text)) type = "PROB";
    else if (/^TEMPO/.test(b.text)) type = "TEMPO";
    else if (/^FM/.test(b.text)) type = "FM";

    const fmMatch = b.text.match(/^FM(\d{2})(\d{2})(\d{2})/);
    if (fmMatch) {
      sTime = makeUtcDate(refDate, parseInt(fmMatch[1], 10), parseInt(fmMatch[2], 10), parseInt(fmMatch[3], 10));
      eTime = baseEnd;
    }

    const rangeMatch = b.text.match(/(\d{2})(\d{2})\/(\d{2})(\d{2})/);
    if (rangeMatch) {
      sTime = makeUtcDate(refDate, parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10));
      eTime = makeUtcDate(refDate, parseInt(rangeMatch[3], 10), parseInt(rangeMatch[4], 10));
      if (eTime <= sTime) eTime.setUTCDate(eTime.getUTCDate() + 1);
    }

    if (sTime && eTime) {
      segments.push({
        startIdx: startIdx,
        endIdx: endIdx,
        startTime: sTime,
        endTime: eTime,
        type: type
      });
    }
  }

  let activeSegments = [];
  for (let j = 0; j < segments.length; j++) {
    if (refUtc >= segments[j].startTime.getTime() && refUtc < segments[j].endTime.getTime()) {
      activeSegments.push({ start: segments[j].startIdx, end: segments[j].endIdx });
    }
  }

  return activeSegments;
}


// =========================================================================
// HUVUDFUNKTION: FORMATERINGSENGINE FÖR METAR & TAF
// =========================================================================
function formatRichWeather(cellValue, isTaf, targetTimeStr) {
  if (!cellValue) return '';

  let targetTime = parseFlightTime(targetTimeStr);
  let isExpired = false;

  // 1. Kolla om TAF har utgått (EXPIRED)
  if (isTaf) {
    const validityMatch = cellValue.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
    if (validityMatch) {
      const refDate = (targetTime instanceof Date && !isNaN(targetTime.getTime())) ? targetTime : new Date();
      const endDay = parseInt(validityMatch[3], 10);
      const endHour = parseInt(validityMatch[4], 10);
      
      const endUtc = makeUtcDate(refDate, endDay, endHour);
      if (refDate.getTime() >= endUtc.getTime()) {
        isExpired = true;
      }
    }
  }

  if (isExpired) {
    return escapeHtml(cellValue) + ' <span style="color:#ff0000; font-weight:bold; font-size:1.1em;">[EXPIRED]</span>';
  }

  let activeRanges = isTaf ? getActiveTafRanges(cellValue, targetTime) : [];
  let hasActivePeriod = isTaf && activeRanges && activeRanges.length > 0;
  let hasCriticalWeatherInActivePeriod = false;

  // Hjälpfunktion för att applicera färgregler på en textsnutt
  function applyWeatherStyling(textSnippet) {
    let html = escapeHtml(textSnippet);
    
    const wordColorMap = {
      "TCU": "#ff9900",  
      "TS": "#ff00ff",   // MAGENTA
      "CB": "#ff9900",   // ORANGE
      "FG": "#ff9900",   // ORANGE
      "CAVOK": "#00ff00" // GREEN
    };

    // RVR
    html = html.replace(/R\d{2}[LCR]?\/[PM]?(\d{3,4})/g, function(match, rvrStr) {
      const visibility = parseInt(rvrStr, 10);
      let color = null;
      if (visibility < 400) color = "#ff00ff";
      else if (visibility >= 400 && visibility <= 550) color = "#ff0000";
      else if (visibility >= 551 && visibility <= 800) color = "#ff9900";
      else if (visibility >= 801 && visibility <= 1400) color = "#EAB308";
      else if (visibility >= 1401) color = "#00ff00";

      if (color === "#ff0000" || color === "#ff00ff") hasCriticalWeatherInActivePeriod = true;
      return `<span style="color:${color}; font-weight:bold;">${match}</span>`;
    });

    // Molnhöjd (BKN / OVC)
    html = html.replace(/\b(OVC|BKN)(\d{3})\b/g, function(match, type, heightStr) {
      const height = parseInt(heightStr, 10);
      let color = null;
      if (height >= 1 && height <= 3) color = "#ff0000";
      else if (height >= 4 && height <= 8) color = "#ff9900";
      else if (height >= 9 && height <= 24) color = "#EAB308";
      else if (height >= 25) color = "#00ff00";

      if (color === "#ff0000") hasCriticalWeatherInActivePeriod = true;
      return `<span style="color:${color}; font-weight:bold;">${match}</span>`;
    });

    // Sikt i meter
    html = html.replace(/\b(\d{4})\b/g, function(match, visStr) {
      const visibility = parseInt(visStr, 10);
      let color = null;
      if (visibility < 550) color = "#ff00ff";
      else if (visibility >= 550 && visibility <= 1399) color = "#ff0000";
      else if (visibility >= 1400 && visibility <= 2300) color = "#ff9900";
      else if (visibility > 2300) color = "#00ff00";

      if (color === "#ff0000" || color === "#ff00ff") hasCriticalWeatherInActivePeriod = true;
      return `<span style="color:${color}; font-weight:bold;">${match}</span>`;
    });

    // Specifika ord
    Object.keys(wordColorMap).forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'g');
      const color = wordColorMap[word];
      if (color === "#ff0000" || color === "#ff00ff") hasCriticalWeatherInActivePeriod = true;
      html = html.replace(regex, `<span style="color:${color}; font-weight:bold;">${word}</span>`);
    });

    return html;
  }

  let finalHtml = "";

  // Om det är TAF och vi har aktiva intervall, applicera fetstil på den aktiva perioden
  if (isTaf && activeRanges.length > 0) {
    let assembled = "";
    let currentIndex = 0;
    
    activeRanges.sort((a, b) => a.start - b.start);

    activeRanges.forEach(range => {
      if (range.start > currentIndex) {
        assembled += applyWeatherStyling(cellValue.substring(currentIndex, range.start));
      }
      let activeTextStyled = applyWeatherStyling(cellValue.substring(range.start, range.end));
      assembled += `<strong style="font-weight: bold;">${activeTextStyled}</strong>`;
      currentIndex = range.end;
    });

    if (currentIndex < cellValue.length) {
      assembled += applyWeatherStyling(cellValue.substring(currentIndex));
    }
    
    finalHtml = assembled;
  } else {
    finalHtml = applyWeatherStyling(cellValue);
  }

  // Möjlig alternativflygplats (Possible Alternate)
  const isAlternate = hasActivePeriod && !hasCriticalWeatherInActivePeriod;
  if (isAlternate) {
    finalHtml += ' <span style="color:#0000ff; font-weight:bold;">[Possible Alternate]</span>';
  }

  if (isTaf) {
    finalHtml = finalHtml.replace(/\n/g, '<br>');
  }

  return finalHtml;
}
