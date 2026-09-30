// A printable page of table QR codes: one card per table, six per A4 sheet.
import QRCode from 'qrcode'

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export async function qrSheetHtml({ venue, base, tables }) {
  const cards = await Promise.all(tables.map(async (t) => {
    const url = `${base.replace(/\/$/, '')}/t/${encodeURIComponent(t.qrToken)}`
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#120f0d', light: '#ffffff' } })
    return `
      <section class="card">
        <p class="brand">Ronda</p>
        <h2>${escape(t.label)}</h2>
        <div class="qr">${svg}</div>
        <p class="hint">Escaneá para pedir y pagar tu parte</p>
        <p class="venue">${escape(venue)}</p>
        <p class="url">${escape(url)}</p>
      </section>`
  }))

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>QR · ${escape(venue)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #120f0d; }
  .sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
  .card { border: 1px dashed #b9aea4; border-radius: 4mm; padding: 6mm; text-align: center;
          height: 88mm; display: flex; flex-direction: column; align-items: center; break-inside: avoid; }
  .brand { margin: 0; font-weight: 800; color: #c9762c; letter-spacing: -.02em; }
  h2 { margin: 1mm 0 2mm; font-size: 20pt; letter-spacing: -.02em; }
  .qr { width: 44mm; height: 44mm; } .qr svg { width: 100%; height: 100%; }
  .hint { margin: 3mm 0 0; font-weight: 600; font-size: 10pt; }
  .venue { margin: 1mm 0 0; color: #6f645b; font-size: 9pt; }
  .url { margin: auto 0 0; color: #a3968b; font-size: 6pt; word-break: break-all; }
</style></head>
<body><main class="sheet">${cards.join('')}</main></body></html>`
}
