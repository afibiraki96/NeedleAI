import { useState, useCallback, useRef } from "react";

const ALL_CATEGORIES = {
  "Pantry / Kitchen Equipment": ["Ice Machine", "Coffee Machine", "Beverage Cooler / Refrigerator", "Dishwasher", "Pantry / Kitchen Equipment"],
  "Admin / Badges": ["Badge / Access Card", "Administrative"],
  "Plumbing and Restroom": ["Water Leaks", "Water Quality", "Drain / Sewer", "Bathroom Appliances (Tap/Faucet, Dispensers, Hand Dryers)", "Boiler / Water Heater"],
  "HVAC / Mechanical": ["HVAC", "Airflow", "Temperature Reading", "Elevator", "Noise"],
  "Furniture": ["Desks", "Standing Desk / Height Adjustable Table", "Other Furniture", "Tables", "Chairs", "Furniture Request / Adjustment"],
  "Signage": ["Signage"],
  "Access Control / Security": ["Access Control", "Display / Monitor / Screen", "Internet / Wi-Fi"],
  "Inspection / Monitoring": ["Inspection"],
  "Power, Electrical and Lighting": ["Lighting", "Electrical", "Power Outlet / Outage"],
  "Safety / Compliance": ["Safety / Hazard"],
  "Cleaning / Janitorial": ["Cleaning", "Pest Control", "Odor / Smell"],
  "Vendor Access": ["Escort / Vendor Access"],
  "Wall / Ceiling / Floor / Window / Door": ["Wall Damage", "Ceiling Damage", "Floor / Carpet Damage", "Door Damage (Handle, Lock)"],
  "Meeting / Events": ["Event Setup"],
  "Project / Construction": ["Project Work"],
  "Fire Protection System": ["Fire Extinguisher", "Alarm"],
  "Outdoor / Courtyard": ["Grounds / Landscaping"],
  "Other": ["General Questions"],
};

const categoryList = Object.entries(ALL_CATEGORIES)
  .map(([sub, l2s]) => `- ${sub}: ${l2s.join(", ")}`)
  .join("\n");

const BATCH_SIZE = 15;

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  
  function parseLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = parseLine(lines[0]);
  const descIdx = headers.findIndex(h => h.toLowerCase().includes('description'));
  const ticketIdx = headers.findIndex(h => h.toLowerCase().includes('ticket'));
  const subIdx = headers.findIndex(h => h.toLowerCase().includes('suggested sub'));
  const l2Idx = headers.findIndex(h => h.toLowerCase().includes('suggested level'));

  if (descIdx === -1 || ticketIdx === -1) return [];

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = parseLine(lines[i]);
    records.push({
      "Ticket Number": fields[ticketIdx] || `ROW_${i}`,
      "Description": (fields[descIdx] || '').slice(0, 300),
      "Suggested Sub-Category": subIdx >= 0 ? fields[subIdx] || '' : '',
      "Suggested Level 2 Sub-Category": l2Idx >= 0 ? fields[l2Idx] || '' : '',
    });
  }
  return records;
}

function buildPrompt(tickets) {
  const ticketList = tickets.map((t, i) =>
    `${i+1}. [${t["Ticket Number"]}]\nDesc: ${t["Description"]}\nSub: ${t["Suggested Sub-Category"]}\nL2: ${t["Suggested Level 2 Sub-Category"]}`
  ).join("\n\n");

  return `You are a facilities management ticket classification expert. Review each ticket and check if Sub-Category and Level 2 Sub-Category are correct.

Valid categories:
${categoryList}

For each ticket return a JSON array. Each object must have exactly:
- "ticket": the ticket number in brackets
- "sub_correct": true or false
- "l2_correct": true or false
- "suggested_sub": correct Sub-Category (same as current if correct)
- "suggested_l2": correct Level 2 (same as current if correct)
- "reason": short explanation only if something is wrong, else ""

Tickets:
${ticketList}

Respond ONLY with the JSON array. No markdown fences. No extra text.`;
}

export default function App() {
  const [tickets, setTickets] = useState([]);
  const [results, setResults] = useState({});
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const pauseRef = useRef(false);
  const fileRef = useRef();

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseCSV(ev.target.result);
      setTickets(parsed);
      setResults({});
      setFilter("all");
      setError(parsed.length === 0 ? "Could not parse CSV — check column names." : null);
    };
    reader.readAsText(file);
  };

  const processTickets = useCallback(async () => {
    if (tickets.length === 0) return;
    setProcessing(true);
    setPaused(false);
    pauseRef.current = false;
    setError(null);

    const batches = [];
    for (let i = 0; i < tickets.length; i += BATCH_SIZE) {
      batches.push(tickets.slice(i, i + BATCH_SIZE));
    }

    const allResults = { ...results };

    for (let bi = 0; bi < batches.length; bi++) {
      if (pauseRef.current) {
        setPaused(true);
        setProcessing(false);
        setResults({ ...allResults });
        return;
      }

      const batch = batches[bi];
      const startIdx = bi * BATCH_SIZE;
      setProgressLabel(`Batch ${bi+1}/${batches.length} (tickets ${startIdx+1}–${startIdx+batch.length})`);

      try {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2000,
            messages: [{ role: "user", content: buildPrompt(batch) }],
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errText.slice(0,200)}`);
        }

        const data = await resp.json();
        const text = data.content?.map(c => c.text || "").join("") || "";
        const clean = text.replace(/```json|```/g, "").trim();

        let parsed = [];
        try {
          parsed = JSON.parse(clean);
        } catch {
          const match = clean.match(/\[[\s\S]*\]/);
          if (match) parsed = JSON.parse(match[0]);
        }

        parsed.forEach(r => {
          if (r.ticket) allResults[r.ticket] = r;
        });

      } catch (e) {
        setError(`Batch ${bi+1} error: ${e.message}. Continuing...`);
      }

      setProgress(Math.round(((bi + 1) / batches.length) * 100));
      setResults({ ...allResults });

      if (bi < batches.length - 1) await new Promise(r => setTimeout(r, 300));
    }

    setProcessing(false);
    setProgressLabel('');
  }, [tickets, results]);

  const handlePause = () => { pauseRef.current = true; };

  const checked = Object.keys(results).length;
  const incorrect = Object.values(results).filter(r => !r.sub_correct || !r.l2_correct).length;
  const correct = Object.values(results).filter(r => r.sub_correct && r.l2_correct).length;

  const filteredTickets = tickets.filter(t => {
    const r = results[t["Ticket Number"]];
    const matchFilter =
      filter === "all" ? true :
      filter === "incorrect" ? (r && (!r.sub_correct || !r.l2_correct)) :
      filter === "correct" ? (r && r.sub_correct && r.l2_correct) :
      !r;
    const matchSearch = !search || 
      t["Ticket Number"].toLowerCase().includes(search.toLowerCase()) ||
      t["Description"].toLowerCase().includes(search.toLowerCase());
    return matchFilter && matchSearch;
  });

  const downloadResults = () => {
    const rows = [["Ticket Number", "Description", "Current Sub-Category", "Current L2", "Sub Correct", "L2 Correct", "Suggested Sub", "Suggested L2", "Reason"]];
    tickets.forEach(t => {
      const r = results[t["Ticket Number"]];
      rows.push([
        t["Ticket Number"],
        `"${(t["Description"] || '').replace(/"/g, '""')}"`,
        t["Suggested Sub-Category"],
        t["Suggested Level 2 Sub-Category"],
        r ? (r.sub_correct ? "YES" : "NO") : "PENDING",
        r ? (r.l2_correct ? "YES" : "NO") : "PENDING",
        r ? r.suggested_sub : "",
        r ? r.suggested_l2 : "",
        r ? `"${(r.reason || '').replace(/"/g, '""')}"` : "",
      ]);
    });
    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ticket_verification_results.csv"; a.click();
  };

  return (
    <div style={{ fontFamily: "'IBM Plex Mono','Courier New',monospace", background: "#0d1117", minHeight: "100vh", color: "#e6edf3", padding: "24px" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#161b22}::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
        .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:.05em}
        .badge-green{background:#0d2e1a;color:#3fb950;border:1px solid #238636}
        .badge-red{background:#2d1216;color:#f85149;border:1px solid #da3633}
        .badge-yellow{background:#2d2000;color:#d29922;border:1px solid #9e6a03}
        .badge-gray{background:#161b22;color:#8b949e;border:1px solid #30363d}
        .ticket-row{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:14px 16px;margin-bottom:8px;transition:border-color .15s}
        .ticket-row:hover{border-color:#388bfd}
        .ticket-row.incorrect{border-left:3px solid #f85149}
        .ticket-row.correct{border-left:3px solid #3fb950}
        .ticket-row.pending{border-left:3px solid #30363d}
        .filter-btn{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:11px;font-family:'IBM Plex Mono',monospace;transition:all .15s}
        .filter-btn.active{background:#388bfd22;border-color:#388bfd;color:#58a6ff}
        .filter-btn:hover:not(.active){border-color:#8b949e;color:#e6edf3}
        .btn{border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;font-family:'IBM Plex Mono',monospace;padding:8px 18px;transition:all .15s}
        .btn-green{background:#238636;color:#fff}.btn-green:hover:not(:disabled){background:#2ea043}
        .btn-red{background:#8e1519;color:#fff}.btn-red:hover{background:#a61c1f}
        .btn-gray{background:#21262d;color:#8b949e;border:1px solid #30363d}.btn-gray:hover{color:#e6edf3;border-color:#8b949e}
        .btn:disabled{background:#21262d;color:#484f58;cursor:not-allowed}
        .stat-box{background:#161b22;border:1px solid #21262d;border-radius:8px;padding:14px 18px;text-align:center;min-width:90px}
        .correction{background:#1a1f2e;border:1px solid #21262d;border-radius:6px;padding:8px 12px;margin-top:8px;font-size:11px}
        .progress-bar{height:4px;background:#21262d;border-radius:2px;overflow:hidden}
        .progress-fill{height:100%;background:linear-gradient(90deg,#388bfd,#3fb950);transition:width .3s;border-radius:2px}
        .upload-zone{border:2px dashed #30363d;border-radius:10px;padding:40px;text-align:center;cursor:pointer;transition:all .2s}
        .upload-zone:hover{border-color:#388bfd;background:#161b22}
        input[type=search]{background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:6px 12px;font-size:12px;font-family:'IBM Plex Mono',monospace;width:220px;outline:none}
        input[type=search]:focus{border-color:#388bfd}
      `}</style>

      {/* Header */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ fontSize: "17px", fontWeight: "600", marginBottom: "4px" }}>Ticket Category Verifier</div>
        <div style={{ fontSize: "11px", color: "#8b949e" }}>Upload your CSV → AI verifies Sub-Category &amp; Level 2 Sub-Category against each ticket description</div>
      </div>

      {/* Upload zone */}
      {tickets.length === 0 ? (
        <div className="upload-zone" onClick={() => fileRef.current.click()}>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleFile} />
          <div style={{ fontSize: "32px", marginBottom: "12px" }}>📂</div>
          <div style={{ fontSize: "14px", fontWeight: "600", marginBottom: "6px" }}>Upload other_tickets_categorized.csv</div>
          <div style={{ fontSize: "11px", color: "#8b949e" }}>Needs columns: Ticket Number, Description, Suggested Sub-Category, Suggested Level 2 Sub-Category</div>
        </div>
      ) : (
        <>
          {/* Stats row */}
          <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "16px", flexWrap: "wrap" }}>
            {[
              { label: "TOTAL", val: tickets.length, color: "#e6edf3" },
              { label: "CHECKED", val: checked, color: "#58a6ff" },
              { label: "CORRECT", val: correct, color: "#3fb950" },
              { label: "INCORRECT", val: incorrect, color: "#f85149" },
              { label: "PENDING", val: tickets.length - checked, color: "#8b949e" },
            ].map(s => (
              <div key={s.label} className="stat-box">
                <div style={{ fontSize: "20px", fontWeight: "700", color: s.color }}>{s.val}</div>
                <div style={{ fontSize: "10px", color: "#484f58", marginTop: "2px" }}>{s.label}</div>
              </div>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
              {checked > 0 && (
                <button className="btn btn-gray" onClick={downloadResults}>⬇ Export CSV</button>
              )}
              {processing ? (
                <button className="btn btn-red" onClick={handlePause}>⏸ Pause</button>
              ) : (
                <button className="btn btn-green" onClick={processTickets} disabled={processing}>
                  {paused ? "▶ Resume" : checked > 0 ? "↺ Re-run" : "▶ Run Verification"}
                </button>
              )}
              <button className="btn btn-gray" onClick={() => { fileRef.current.click(); }}>
                ↑ New CSV
              </button>
              <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleFile} />
            </div>
          </div>

          {/* Progress */}
          {(processing || progress > 0) && (
            <div style={{ marginBottom: "14px" }}>
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
              <div style={{ fontSize: "10px", color: "#8b949e", marginTop: "4px" }}>
                {processing ? progressLabel : `Complete — ${checked} tickets verified`}
              </div>
            </div>
          )}

          {error && (
            <div style={{ background: "#2d1216", border: "1px solid #da3633", borderRadius: "6px", padding: "8px 12px", color: "#f85149", fontSize: "11px", marginBottom: "12px" }}>
              ⚠ {error}
            </div>
          )}

          {/* Filters + Search */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap", alignItems: "center" }}>
            {[
              { key: "all", label: `All (${tickets.length})` },
              { key: "incorrect", label: `Incorrect (${incorrect})` },
              { key: "correct", label: `Correct (${correct})` },
              { key: "pending", label: `Pending (${tickets.length - checked})` },
            ].map(f => (
              <button key={f.key} className={`filter-btn${filter === f.key ? " active" : ""}`} onClick={() => setFilter(f.key)}>{f.label}</button>
            ))}
            <input type="search" placeholder="Search ticket / description…" value={search} onChange={e => setSearch(e.target.value)} style={{ marginLeft: "auto" }} />
          </div>

          {/* Ticket list */}
          <div>
            {filteredTickets.length === 0 && (
              <div style={{ textAlign: "center", color: "#484f58", padding: "40px", fontSize: "12px" }}>
                {filter === "pending" && checked === 0 ? "Click ▶ Run Verification to start." : `No ${filter} tickets found.`}
              </div>
            )}
            {filteredTickets.map(t => {
              const r = results[t["Ticket Number"]];
              const rowClass = !r ? "pending" : (!r.sub_correct || !r.l2_correct) ? "incorrect" : "correct";
              return (
                <div key={t["Ticket Number"]} className={`ticket-row ${rowClass}`}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px" }}>
                        <span style={{ fontSize: "11px", fontWeight: "600", color: "#58a6ff" }}>{t["Ticket Number"]}</span>
                        {r
                          ? (r.sub_correct && r.l2_correct
                            ? <span className="badge badge-green">✓ CORRECT</span>
                            : <span className="badge badge-red">✗ INCORRECT</span>)
                          : <span className="badge badge-gray">PENDING</span>
                        }
                      </div>
                      <div style={{ fontSize: "11px", color: "#c9d1d9", lineHeight: "1.55", marginBottom: "8px" }}>
                        {t["Description"]}
                      </div>
                      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "10px" }}>
                          <span style={{ color: "#484f58" }}>Sub: </span>
                          <span style={{ color: r ? (r.sub_correct ? "#3fb950" : "#f85149") : "#d29922" }}>
                            {t["Suggested Sub-Category"] || "—"}
                          </span>
                        </span>
                        <span style={{ fontSize: "10px" }}>
                          <span style={{ color: "#484f58" }}>L2: </span>
                          <span style={{ color: r ? (r.l2_correct ? "#3fb950" : "#f85149") : "#d29922" }}>
                            {t["Suggested Level 2 Sub-Category"] || "—"}
                          </span>
                        </span>
                      </div>
                      {r && (!r.sub_correct || !r.l2_correct) && (
                        <div className="correction">
                          <span style={{ color: "#d29922", fontSize: "10px", fontWeight: "600" }}>CORRECTION: </span>
                          {!r.sub_correct && (
                            <span style={{ fontSize: "10px" }}>
                              Sub <span style={{ color: "#f85149" }}>{t["Suggested Sub-Category"]}</span>
                              <span style={{ color: "#388bfd", margin: "0 4px" }}>→</span>
                              <span style={{ color: "#3fb950" }}>{r.suggested_sub}</span>
                              {!r.l2_correct && " · "}
                            </span>
                          )}
                          {!r.l2_correct && (
                            <span style={{ fontSize: "10px" }}>
                              L2 <span style={{ color: "#f85149" }}>{t["Suggested Level 2 Sub-Category"]}</span>
                              <span style={{ color: "#388bfd", margin: "0 4px" }}>→</span>
                              <span style={{ color: "#3fb950" }}>{r.suggested_l2}</span>
                            </span>
                          )}
                          {r.reason && (
                            <div style={{ fontSize: "10px", color: "#8b949e", marginTop: "4px" }}>{r.reason}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {filteredTickets.length > 0 && (
            <div style={{ textAlign: "center", padding: "16px", fontSize: "11px", color: "#484f58" }}>
              Showing {filteredTickets.length} of {tickets.length} tickets
            </div>
          )}
        </>
      )}
    </div>
  );
}
