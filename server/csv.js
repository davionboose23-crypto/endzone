// Streaming CSV parser: quoted fields, escaped quotes, multiline fields, CRLF.
// Feed text chunks with push(); rows are emitted through onRow(arrayOfStrings).
export class CsvStream {
  constructor(onRow) {
    this.onRow = onRow; this.field = ''; this.row = []; this.inQuotes = false; this.pendingQuote = false; this.rows = 0;
  }
  push(chunk) {
    let field = this.field, row = this.row, inQ = this.inQuotes, pq = this.pendingQuote;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inQ) {
        if (pq) {
          pq = false;
          if (c === '"') { field += '"'; continue; }
          inQ = false; // closing quote; fall through to handle c unquoted
        } else if (c === '"') { pq = true; continue; }
        else { field += c; continue; }
      }
      if (c === '"' && field === '') { inQ = true; continue; }
      if (c === ',') { row.push(field); field = ''; continue; }
      if (c === '\n') { row.push(field); field = ''; this._emit(row); row = []; continue; }
      if (c === '\r') continue;
      field += c;
    }
    this.field = field; this.row = row; this.inQuotes = inQ; this.pendingQuote = pq;
  }
  end() {
    if (this.pendingQuote) { this.inQuotes = false; this.pendingQuote = false; }
    if (this.field !== '' || this.row.length) { this.row.push(this.field); this._emit(this.row); }
    this.field = ''; this.row = [];
  }
  _emit(row) { if (row.length === 1 && row[0] === '') return; this.rows++; this.onRow(row); }
}
export function parseCsv(text) {
  const out = []; let header = null;
  const s = new CsvStream(r => { if (!header) header = r; else { const o = {}; header.forEach((h, i) => { o[h] = r[i] ?? ''; }); out.push(o); } });
  s.push(text); s.end(); return out;
}
