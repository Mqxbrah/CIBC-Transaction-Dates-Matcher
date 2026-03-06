import { useState } from "react";

const DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s+\d{4}$/;
const SKIP_RE = [
  /^4[0-9]{3}\*+[0-9]+$/,
  /^REDEEM(ED)? WITH POINTS$/i,
];

function shouldSkip(line) {
  return SKIP_RE.some(re => re.test(line.trim()));
}

function parseUIRows(text) {
  const lines = text
    .split(/[\n\t]/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !shouldSkip(l));

  const rows = [];
  let current = null;
  for (const line of lines) {
    if (DATE_RE.test(line)) {
      if (current) rows.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) rows.push(current);
  return rows;
}

function parseTSV(text) {
  return text.split("\n")
    .filter(l => l.trim())
    .map(line => line.split("\t").map(c => c.trim()));
}

function parseTSVData(text) {
  const allRows = parseTSV(text);
  return allRows.length > 0 && !parseDate(allRows[0][0]) ? allRows.slice(1) : allRows;
}

function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  // "Mar 5, 2026"
  const m1 = str.match(/^(\w{3})\s+(\d+),\s+(\d{4})$/);
  if (m1) {
    const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    return new Date(+m1[3], months[m1[1]], +m1[2]);
  }
  // YYYY-MM-DD
  const m2 = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return new Date(+m2[1], +m2[2]-1, +m2[3]);
  // MM/DD/YYYY
  const m3 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m3) return new Date(+m3[3], +m3[1]-1, +m3[2]);
  // DD/MM/YYYY
  const m4 = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m4) return new Date(+m4[3], +m4[1]-1, +m4[2]);
  return null;
}

function datesWithin14Days(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return true; // if we can't parse, don't disqualify
  return Math.abs(da - db) <= 14 * 24 * 60 * 60 * 1000;
}

function daysBetween(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return null;
  return Math.round(Math.abs(da - db) / (24 * 60 * 60 * 1000));
}

function normalizeAmount(val) {
  return String(val).replace(/[$,\s−]/g, "").replace("−", "").trim();
}

function amountsEqual(a, b) {
  const fa = parseFloat(a), fb = parseFloat(b);
  return !isNaN(fa) && !isNaN(fb) && fa === fb;
}

function matchRows(uiRows, csvRows) {
  const csvData = csvRows.filter(r => r.length >= 3);

  // Build all candidate matches first
  const candidates = [];
  uiRows.forEach((uiRow, uiIdx) => {
    const field1 = uiRow[1] || "";
    const field2 = uiRow[2] || "";
    const uiAmount = normalizeAmount(field2);
    const uiDate = parseDate(uiRow[0]);

    csvData.forEach((csvRow, csvIdx) => {
      const csvDesc     = (csvRow[0] || "").trim();
      const csvWith     = normalizeAmount(csvRow[1] || "");
      const csvDep      = normalizeAmount(csvRow[2] || "");
      const csvPostDate = (csvRow[3] || "").trim();
      const csvDate     = parseDate(csvPostDate);

      // Skip if transaction date is more than 1 day after post date
      if (uiDate && csvDate) {
        const diffDays = (uiDate - csvDate) / (24 * 60 * 60 * 1000);
        if (diffDays > 1) return;
      }

      const descMatch = csvDesc.length > 0 && field1.includes(csvDesc);
      const amtMatch  = uiAmount.length > 0 && (
        (csvWith.length > 0 && amountsEqual(uiAmount, csvWith)) ||
        (csvDep.length > 0  && amountsEqual(uiAmount, csvDep))
      );
      const score = (descMatch ? 1 : 0) + (amtMatch ? 1 : 0);
      if (score === 0) return;

      const days = daysBetween(uiRow[0], csvPostDate) ?? Infinity;
      candidates.push({ uiIdx, csvIdx, score, days, csvPostDate, csvDesc, csvWith, csvDep, descMatch, amtMatch });
    });
  });

  // Sort: best score first, then closest date
  candidates.sort((a, b) => b.score - a.score || a.days - b.days);

  // Greedy one-to-one assignment
  const usedUi  = new Set();
  const usedCsv = new Set();
  const results = new Array(uiRows.length).fill(null).map((_, i) => ({
    uiRow: uiRows[i],
    score: 0,
    match: null,
    field1: uiRows[i][1] || "",
    field2: uiRows[i][2] || "",
    uiAmount: normalizeAmount(uiRows[i][2] || ""),
  }));

  for (const c of candidates) {
    if (usedUi.has(c.uiIdx) || usedCsv.has(c.csvIdx)) continue;
    usedUi.add(c.uiIdx);
    usedCsv.add(c.csvIdx);
    results[c.uiIdx] = {
      ...results[c.uiIdx],
      score: c.score,
      match: {
        csvPostDate: c.csvPostDate,
        csvDesc:     c.csvDesc,
        csvWith:     c.csvWith,
        csvDep:      c.csvDep,
        descMatch:   c.descMatch,
        amtMatch:    c.amtMatch,
        dateOk:      true,
      },
    };
  }

  return results;
}

function toCSVExport(matched) {
  if (!matched.length) return "";
  const maxCols = Math.max(...matched.map(m => m.uiRow.length));
  const headers = [
    ...Array.from({ length: maxCols }, (_, i) => i === 0 ? "Transaction Date" : `Field ${i}`),
    "Post Date", "Match Score",
  ];
  const escape = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [headers.map(escape).join(",")];
  for (const { uiRow, score, match } of matched) {
    const padded = [...uiRow, ...Array(maxCols - uiRow.length).fill("")];
    lines.push([...padded, match?.csvPostDate || "", `${score}/2`].map(escape).join(","));
  }
  return lines.join("\n");
}

const SCORE_STYLE = {
  2: { bg: "#14532d", color: "#4ade80" },
  1: { bg: "#713f12", color: "#fbbf24" },
  0: { bg: "#3b1f1f", color: "#f87171" },
};

function DebugRow({ item, maxCols }) {
  const { field1, field2, uiAmount, match } = item;
  const cell = (label, uiVal, csvVal, matched) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: "#555", marginBottom: 4, letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 10, color: "#4f8ef7", marginBottom: 2 }}>UI VALUE</div>
          <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 3, padding: "5px 8px", fontSize: 12, color: "#cbd5e1", wordBreak: "break-all" }}>
            {uiVal || <span style={{ color: "#444" }}>(empty)</span>}
          </div>
        </div>
        <div style={{ paddingTop: 18, color: matched ? "#4ade80" : "#f87171", fontSize: 16 }}>
          {matched ? "=" : "≠"}
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 10, color: "#888", marginBottom: 2 }}>CSV VALUE</div>
          <div style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 3, padding: "5px 8px", fontSize: 12, color: "#cbd5e1", wordBreak: "break-all" }}>
            {csvVal || <span style={{ color: "#444" }}>(empty)</span>}
          </div>
        </div>
      </div>
      {!matched && uiVal && csvVal && (
        <div style={{ marginTop: 4, fontSize: 11, color: "#f87171" }}>
          {label === "Description (Field 1 contains CSV?)" 
            ? `"${csvVal}" not found inside "${uiVal}"`
            : `"${uiAmount}" ≠ "${csvVal}"`
          }
        </div>
      )}
    </div>
  );

  return (
    <tr>
      <td colSpan={maxCols + 2} style={{ padding: "12px 16px", background: "#0d1117", borderBottom: "2px solid #222" }}>
        <div style={{ fontSize: 11, color: "#555", marginBottom: 10, letterSpacing: "0.08em" }}>MATCH DEBUG</div>
        {match ? (
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 280 }}>
              {cell("Date within 14 days?", item.uiRow[0], match.csvPostDate, match.dateOk)}
            </div>
            <div style={{ flex: 1, minWidth: 280 }}>
              {cell("Description (Field 1 contains CSV?)", field1, match.csvDesc, match.descMatch)}
            </div>
            <div style={{ flex: 1, minWidth: 280 }}>
              {cell("Amount (UI vs CSV Withdrawal / Deposit)", `${uiAmount} (from "${field2}")`, match.csvWith ? `${match.csvWith}` + (match.csvDep ? `  |  deposit: ${match.csvDep}` : "") : `${match.csvDep}`, match.amtMatch)}
            </div>
          </div>
        ) : (
          <div style={{ color: "#f87171", fontSize: 12 }}>No CSV row found to compare against.</div>
        )}
      </td>
    </tr>
  );
}

export default function CIBCParser() {
  const [step, setStep] = useState("ui");
  const [uiText, setUiText] = useState("");
  const [csvText, setCsvText] = useState("");
  const [verifyText, setVerifyText] = useState("");
  const [uiRows, setUiRows] = useState(null);
  const [matched, setMatched] = useState(null);
  const [verifyResults, setVerifyResults] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [copied, setCopied] = useState(false);

  const toggleExpand = (i) => setExpanded(prev => ({ ...prev, [i]: !prev[i] }));

  const handleParseUI = () => { setUiRows(parseUIRows(uiText)); setStep("csv"); };

  const handleMatch = () => {
    const all = matchRows(uiRows, parseTSVData(csvText));
    all.sort((a, b) => {
      const da = parseDate(a.uiRow[0]), db = parseDate(b.uiRow[0]);
      if (!da || !db) return 0;
      return db - da;
    });
    setMatched(all);
    setStep("results");
  };

  const handleCopy = () => {
    const sorted = [...visibleRows].sort((a, b) => {
      const da = parseDate(a.match?.csvPostDate), db = parseDate(b.match?.csvPostDate);
      if (!da || !db) return 0;
      return db - da;
    });
    const tsv = sorted.map(m => m.uiRow[0] || "").join("\n");
    navigator.clipboard.writeText(tsv);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const handleVerifyText = (text) => {
    setVerifyText(text);
    if (!text.trim()) {
      setVerifyResults(null);
      return;
    }
    const sheetsRows = parseTSVData(text);
    const sortedVisible = [...visibleRows].sort((a, b) => {
      const da = parseDate(a.match?.csvPostDate), db = parseDate(b.match?.csvPostDate);
      if (!da || !db) return 0;
      return db - da;
    });
    const results = sortedVisible.map((m, i) => {
      const txDate = m.uiRow[0] || "";
      const sheetsRow = sheetsRows[i];
      const sheetsTxDate = sheetsRow ? (sheetsRow[0] || "").trim() : null;
      const uiDateParsed = parseDate(txDate);
      const sheetsTxDateParsed = parseDate(sheetsTxDate);
      const dateMatch = uiDateParsed && sheetsTxDateParsed
        ? uiDateParsed.getTime() === sheetsTxDateParsed.getTime()
        : sheetsTxDate === txDate;
      return { ...m, sheetsTxDate, sheetsRow: !!sheetsRow, dateMatch };
    });
    setVerifyResults(results);
  };

  const handleReset = () => {
    setStep("ui"); setUiText(""); setCsvText(""); setVerifyText("");
    setUiRows(null); setMatched(null); setVerifyResults(null); setExpanded({});
  };

  const maxCols = matched ? Math.max(...matched.map(m => m.uiRow.length)) : 0;
  const visibleRows = matched ? matched.filter(m => m.score > 0) : [];

  return (
    <div style={{ fontFamily: "monospace", background: "#111", minHeight: "100vh", color: "#eee", padding: 24 }}>
      <style>{`
        * { box-sizing: border-box; }
        textarea:focus { outline: 2px solid #4f8ef7; }
        button { cursor: pointer; font-family: monospace; font-size: 13px; padding: 8px 16px; border-radius: 4px; border: none; }
        table { border-collapse: collapse; font-size: 12px; width: 100%; }
        th { background: #1a1a1a; color: #888; text-align: left; padding: 8px 12px; border-bottom: 1px solid #333; white-space: nowrap; }
        td { padding: 6px 12px; border-bottom: 1px solid #1a1a1a; color: #ccc; vertical-align: top; white-space: nowrap; }
        .clickable-row { cursor: pointer; }
        .clickable-row:hover td { background: #181818 !important; }
        .tag { display:inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight:600; }
        .step { display:inline-block; padding: 4px 12px; border-radius: 4px; font-size: 11px; margin-right: 8px; }
        .step-active { background:#4f8ef7; color:#fff; }
        .step-done { background:#1e3a1e; color:#4ade80; }
        .step-idle { background:#1a1a1a; color:#555; }
      `}</style>

      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>CIBC Transaction Dates Matcher</h2>

      <div style={{ margin: "10px 0 24px", display: "flex", gap: 4, alignItems: "center" }}>
        {[["ui","1. Paste UI Data"],["csv","2. Paste Posted Data"],["results","3. Results"],["verify","4. Verify"]].map(([s, label]) => {
          const order = ["ui","csv","results","verify"];
          const currentIdx = order.indexOf(step);
          const stepIdx = order.indexOf(s);
          const cls = step === s ? "step-active" : stepIdx < currentIdx ? "step-done" : "step-idle";
          return <span key={s} className={`step ${cls}`}>{label}</span>;
        })}
      </div>

      {step === "ui" && (
        <div>
          <div style={{ fontSize: 11, color: "#555", marginBottom: 8 }}>PASTE FROM CIBC WEBSITE</div>
          <textarea value={uiText} onChange={e => setUiText(e.target.value)}
            placeholder="Paste CIBC transactions here..."
            style={{ width:"100%", height:260, background:"#1a1a1a", border:"1px solid #333", borderRadius:4, color:"#ccc", fontSize:12, padding:12, resize:"vertical" }} />
          <div style={{ marginTop: 10 }}>
            <button onClick={handleParseUI} disabled={!uiText.trim()} style={{ background:"#4f8ef7", color:"#fff" }}>Next</button>
          </div>
        </div>
      )}

      {step === "csv" && (
        <div>
          <div style={{ color:"#4ade80", fontSize:12, marginBottom:16 }}>✓ Parsed {uiRows.length} transactions from UI</div>
          <div style={{ fontSize:11, color:"#555", marginBottom:8 }}>PASTE CIBC POSTED DATA FROM GOOGLE SHEETS</div>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)}
            placeholder="Select all & copy from Google Sheets, then paste here..."
            style={{ width:"100%", height:200, background:"#1a1a1a", border:"1px solid #333", borderRadius:4, color:"#ccc", fontSize:12, padding:12, resize:"vertical" }} />
          {csvText && <div style={{ marginTop:6, color:"#4ade80", fontSize:12 }}>✓ {parseTSVData(csvText).length} rows detected</div>}
          <div style={{ marginTop:12, display:"flex", gap:8 }}>
            <button onClick={() => setStep("ui")} style={{ background:"#222", color:"#aaa", border:"1px solid #333" }}>← Back</button>
            <button onClick={handleMatch} disabled={!csvText.trim()} style={{ background:"#4f8ef7", color:"#fff" }}>Next</button>
          </div>
        </div>
      )}

      {step === "results" && matched && (
        <div>
          <div style={{ display:"flex", gap:8, marginBottom:14, alignItems:"center", flexWrap:"wrap" }}>
            <span style={{ color:"#4ade80", fontSize:12 }}>✓ {visibleRows.filter(m=>m.score===2).length} full</span>
            <span style={{ color:"#fbbf24", fontSize:12 }}>⚠ {visibleRows.filter(m=>m.score===1).length} partial</span>
            <span style={{ color:"#f87171", fontSize:12 }}>✗ {visibleRows.filter(m=>m.score===0).length} unmatched</span>
            <span style={{ color:"#555", fontSize:11 }}>— click any row to debug</span>
            <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
              <button onClick={() => setStep("csv")} style={{ background:"#222", color:"#aaa", border:"1px solid #333" }}>← Back</button>
              <button onClick={handleCopy} style={{ background:"#222", color:"#aaa", border:"1px solid #333" }}>{copied ? "✓ Copied" : "Copy TSV"}</button>
              <button onClick={() => setStep("verify")} style={{ background:"#4f8ef7", color:"#fff" }}>Next</button>
            </div>
          </div>

          <div style={{ overflowX:"auto", border:"1px solid #222", borderRadius:4 }}>
            <table>
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Transaction Date</th>
                  <th>Post Date</th>
                  <th>Days Apart</th>
                  {Array.from({ length: maxCols - 1 }, (_, i) => (
                    <th key={i}>{`Field ${i + 1}`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((item, ri) => {
                  const { uiRow, score, match } = item;
                  const sc = SCORE_STYLE[score];
                  const isOpen = !!expanded[ri];
                  return [
                    <tr key={`row-${ri}`} className="clickable-row" onClick={() => toggleExpand(ri)}>
                      <td>
                        <span className="tag" style={{ background: sc.bg, color: sc.color }}>{score}/2</span>
                        <span style={{ marginLeft: 6, color: "#444", fontSize: 11 }}>{isOpen ? "▲" : "▼"}</span>
                      </td>
                      <td style={{ color: "#cbd5e1" }}>{uiRow[0] || ""}</td>
                      <td style={{ color: score===2?"#4ade80":score===1?"#fbbf24":"#f87171" }}>
                        {match?.csvPostDate || "—"}
                      </td>
                      <td style={{ color: (() => { const d = match ? daysBetween(uiRow[0], match.csvPostDate) : null; return d === null ? "#555" : d > 7 ? "#f87171" : "#4ade80"; })() }}>
                        {match ? (() => { const d = daysBetween(uiRow[0], match.csvPostDate); return d === null ? "—" : `${d}d`; })() : "—"}
                      </td>
                      {Array.from({ length: maxCols - 1 }, (_, ci) => (
                        <td key={ci}>{uiRow[ci + 1] || ""}</td>
                      ))}
                    </tr>,
                    isOpen && <DebugRow key={`debug-${ri}`} item={item} maxCols={maxCols + 2} />
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {step === "verify" && (
        <div>
          <div style={{ color:"#4ade80", fontSize:12, marginBottom:16 }}>✓ Copy TSV copied — paste transaction dates into Sheets, then paste the updated Sheets data below to verify</div>
          <div style={{ fontSize:11, color:"#555", marginBottom:8 }}>PASTE UPDATED SHEETS TSV</div>
          <textarea value={verifyText} onChange={e => handleVerifyText(e.target.value)}
            placeholder="Paste updated Sheets data here (with header row)..."
            style={{ width:"100%", height:200, background:"#1a1a1a", border:"1px solid #333", borderRadius:4, color:"#ccc", fontSize:12, padding:12, resize:"vertical" }} />
          {verifyText && <div style={{ marginTop:6, color:"#4ade80", fontSize:12 }}>✓ {parseTSVData(verifyText).length} rows detected</div>}
          <div style={{ marginTop:12 }}>
            <button onClick={() => setStep("results")} style={{ background:"#222", color:"#aaa", border:"1px solid #333" }}>← Back</button>
          </div>
          {verifyResults && (
            <div style={{ marginTop:20 }}>
              <div style={{ display:"flex", gap:8, marginBottom:12, alignItems:"center" }}>
                <span style={{ color:"#4ade80", fontSize:12 }}>✓ {verifyResults.filter(r=>r.dateMatch).length} matching</span>
                <span style={{ color:"#fbbf24", fontSize:12 }}>⚠ {verifyResults.filter(r=>r.sheetsRow && !r.dateMatch).length} date differs</span>
                <span style={{ color:"#f87171", fontSize:12 }}>✗ {verifyResults.filter(r=>!r.sheetsRow).length} not found</span>
              </div>
              <div style={{ overflowX:"auto", border:"1px solid #222", borderRadius:4 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Post Date</th>
                      <th>UI Tx Date</th>
                      <th>Sheets Tx Date</th>
                      <th>Amount</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verifyResults.map((r, i) => (
                      <tr key={i}>
                        <td><span className="tag" style={{ background: r.dateMatch ? "#14532d" : r.sheetsRow ? "#713f12" : "#3b1f1f", color: r.dateMatch ? "#4ade80" : r.sheetsRow ? "#fbbf24" : "#f87171" }}>
                          {r.dateMatch ? "✓ match" : r.sheetsRow ? "date diff" : "not found"}
                        </span></td>
                        <td style={{ color:"#94a3b8" }}>{r.match?.csvPostDate || "—"}</td>
                        <td style={{ color: r.dateMatch ? "#4ade80" : "#f87171" }}>{r.uiRow[0] || "—"}</td>
                        <td style={{ color: r.dateMatch ? "#4ade80" : "#fbbf24" }}>{r.sheetsTxDate || "—"}</td>
                        <td style={{ color:"#94a3b8" }}>{r.field2 || "—"}</td>
                        <td style={{ color:"#64748b" }}>{r.field1 || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
