/**
 * Printable PDF sheet for verified Checklane missing-tag batch (spa gun scanning).
 */

const PDFDocument = require('pdfkit');
const { groupTagsByAisle } = require('./tag-location');

const ROW_HEIGHT = 210;
const PAGE_MARGIN = 48;
const BARCODE_WIDTH = 220;
const BARCODE_HEIGHT = 72;
const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;

function truncate(text, maxLen) {
  const s = String(text || '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function drawHeader(doc, meta) {
  doc.font('Helvetica-Bold').fontSize(16).text('Checklane Tag Print Batch', PAGE_MARGIN, PAGE_MARGIN);
  doc.font('Helvetica').fontSize(11);
  doc.text(`Store: ${meta.store || 'unknown'}`, PAGE_MARGIN, doc.y + 6);
  doc.text(`Visit: ${meta.visitId}`, PAGE_MARGIN, doc.y + 2);
  doc.text(`Date: ${meta.dateLabel}`, PAGE_MARGIN, doc.y + 2);
  doc.text(`Items: ${meta.count}`, PAGE_MARGIN, doc.y + 2);
  doc.moveDown(0.6);
  doc.strokeColor('#cccccc').moveTo(PAGE_MARGIN, doc.y).lineTo(LETTER_WIDTH - PAGE_MARGIN, doc.y).stroke();
  doc.moveDown(0.8);
}

function drawInvalidRow(doc, item, y, contentWidth) {
  const x = PAGE_MARGIN;
  doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(12)
    .text('INVALID UPC — verify', x, y);
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(11)
    .text(`Raw value: ${item.rawUpc || item.upc || '—'}`, x, y + 18);
  if (item.reason) {
    doc.font('Helvetica').fontSize(9).fillColor('#6b7280')
      .text(item.reason, x, y + 34);
  }
  doc.fillColor('#111827').font('Helvetica').fontSize(10)
    .text(truncate(item.description, 80) || '—', x, y + 50, { width: contentWidth });
  doc.font('Helvetica-Bold').fontSize(10)
    .text(`Location: ${item.location || item.dbkey || '—'}`, x, y + 68);
}

function drawValidRow(doc, item, y, contentWidth) {
  const x = PAGE_MARGIN;
  let cursorY = y;

  if (item.primary?.buffer) {
    doc.image(item.primary.buffer, x, cursorY, {
      fit: [BARCODE_WIDTH, BARCODE_HEIGHT],
      align: 'left',
    });
    cursorY += BARCODE_HEIGHT + 4;
  }

  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(12)
    .text(item.displayDigits || item.upc, x, cursorY);
  cursorY += 16;

  doc.font('Helvetica').fontSize(10)
    .text(truncate(item.description, 90) || '—', x, cursorY, { width: contentWidth });
  cursorY += 28;

  doc.font('Helvetica-Bold').fontSize(10)
    .text(`Location: ${item.location || item.dbkey || '—'}`, x, cursorY);
  cursorY += 14;

  if (item.fallback?.buffer) {
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
      .text('EAN-13 fallback (leading 0):', x, cursorY);
    cursorY += 10;
    doc.image(item.fallback.buffer, x, cursorY, {
      fit: [BARCODE_WIDTH, BARCODE_HEIGHT - 8],
      align: 'left',
    });
  }
}

/**
 * @param {{ store?: string|null, visitId: number, dateLabel: string, items: Array<object> }} params
 * @returns {Promise<Buffer>}
 */
function drawAisleHeader(doc, aisleLabel, y) {
  const x = PAGE_MARGIN;
  doc.fillColor('#374151').font('Helvetica-Bold').fontSize(11)
    .text(aisleLabel, x, y);
  return y + 18;
}

function buildTagBatchPdf({ store, visitId, dateLabel, items }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: PAGE_MARGIN, autoFirstPage: false });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const contentTop = PAGE_MARGIN + 90;
    const contentBottom = LETTER_HEIGHT - PAGE_MARGIN;
    const contentWidth = LETTER_WIDTH - PAGE_MARGIN * 2;
    const rowsPerPage = Math.max(1, Math.floor((contentBottom - contentTop) / ROW_HEIGHT));

    doc.addPage();
    drawHeader(doc, { store, visitId, dateLabel, count: items.length });

    let rowIndex = 0;
    let y = contentTop;
    const aisleGroups = groupTagsByAisle(items);

    for (const group of aisleGroups) {
      if (rowIndex > 0 && y + 30 > contentBottom) {
        doc.addPage();
        drawHeader(doc, { store, visitId, dateLabel, count: items.length });
        y = contentTop;
      }
      y = drawAisleHeader(doc, group.aisleLabel, y);

      for (const item of group.tags) {
        if (rowIndex > 0 && rowIndex % rowsPerPage === 0) {
          doc.addPage();
          drawHeader(doc, { store, visitId, dateLabel, count: items.length });
          y = contentTop;
          y = drawAisleHeader(doc, group.aisleLabel, y);
        }

        if (rowIndex > 0 && rowIndex % rowsPerPage !== 0) {
          doc.strokeColor('#e5e7eb')
            .moveTo(PAGE_MARGIN, y - 8)
            .lineTo(LETTER_WIDTH - PAGE_MARGIN, y - 8)
            .stroke();
        }

        if (item.valid && item.primary) {
          drawValidRow(doc, item, y, contentWidth);
        } else {
          drawInvalidRow(doc, item, y, contentWidth);
        }

        y += ROW_HEIGHT;
        rowIndex += 1;
      }
    }

    doc.end();
  });
}

module.exports = {
  buildTagBatchPdf,
};
