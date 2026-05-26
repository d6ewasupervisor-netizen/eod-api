/**
 * Fax-oriented PDF sheet for verified Checklane missing-tag batches.
 * Layout: 2 columns × 6 rows (12 UPCs per page) for email-to-fax delivery.
 */

const PDFDocument = require('pdfkit');

const PAGE_MARGIN = 36;
const COLUMN_GUTTER = 14;
const COLS = 2;
const ROWS = 6;
const ITEMS_PER_PAGE = COLS * ROWS;
const BARCODE_HEIGHT = 38;
const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;
const BLACK = '#000000';

function truncate(text, maxLen) {
  const s = String(text || '').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function drawHeader(doc, meta) {
  const y0 = PAGE_MARGIN;
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(13)
    .text('Checklane Tag Print Batch', PAGE_MARGIN, y0);
  doc.font('Helvetica').fontSize(9)
    .text(
      `Store: ${meta.store || 'unknown'}  ·  Visit: ${meta.visitId}  ·  ${meta.dateLabel}  ·  Items: ${meta.count}`,
      PAGE_MARGIN,
      y0 + 16,
      { width: LETTER_WIDTH - PAGE_MARGIN * 2 },
    );
  const ruleY = y0 + 32;
  doc.lineWidth(1).strokeColor(BLACK)
    .moveTo(PAGE_MARGIN, ruleY)
    .lineTo(LETTER_WIDTH - PAGE_MARGIN, ruleY)
    .stroke();
  return ruleY + 8;
}

function drawCellBorder(doc, x, y, cellWidth, cellHeight) {
  doc.lineWidth(0.75).strokeColor(BLACK)
    .rect(x, y, cellWidth, cellHeight)
    .stroke();
}

function drawInvalidCell(doc, item, x, y, cellWidth, cellHeight) {
  const pad = 6;
  const innerWidth = cellWidth - pad * 2;
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(8)
    .text('INVALID UPC', x + pad, y + 6, { width: innerWidth });
  doc.font('Helvetica-Bold').fontSize(8)
    .text(item.rawUpc || item.upc || '—', x + pad, y + 18, { width: innerWidth });
  if (item.reason) {
    doc.font('Helvetica').fontSize(7)
      .text(truncate(item.reason, 40), x + pad, y + 30, { width: innerWidth });
  }
  doc.font('Helvetica').fontSize(7)
    .text(truncate(item.description, 48) || '—', x + pad, y + 44, { width: innerWidth, height: 28 });
  doc.font('Helvetica-Bold').fontSize(8)
    .text(`Loc: ${truncate(item.location || item.dbkey || '—', 18)}`, x + pad, y + cellHeight - 16, {
      width: innerWidth,
    });
  drawCellBorder(doc, x, y, cellWidth, cellHeight);
}

function drawValidCell(doc, item, x, y, cellWidth, cellHeight) {
  const pad = 6;
  const innerWidth = cellWidth - pad * 2;
  let cursorY = y + 4;

  if (item.primary?.buffer) {
    doc.image(item.primary.buffer, x + pad, cursorY, {
      fit: [innerWidth, BARCODE_HEIGHT],
      align: 'left',
    });
    cursorY += BARCODE_HEIGHT + 3;
  }

  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9)
    .text(item.displayDigits || item.upc, x + pad, cursorY, { width: innerWidth });
  cursorY += 12;

  doc.font('Helvetica').fontSize(7.5)
    .text(truncate(item.description, 52) || '—', x + pad, cursorY, {
      width: innerWidth,
      height: 26,
      ellipsis: true,
    });
  cursorY += 24;

  doc.font('Helvetica-Bold').fontSize(8)
    .text(`Loc: ${truncate(item.location || item.dbkey || '—', 18)}`, x + pad, cursorY, {
      width: innerWidth,
    });

  drawCellBorder(doc, x, y, cellWidth, cellHeight);
}

function slotPosition(slotOnPage, contentTop, cellWidth, cellHeight) {
  const col = slotOnPage < ROWS ? 0 : 1;
  const row = slotOnPage < ROWS ? slotOnPage : slotOnPage - ROWS;
  const x = PAGE_MARGIN + col * (cellWidth + COLUMN_GUTTER);
  const y = contentTop + row * cellHeight;
  return { x, y };
}

/**
 * @param {{ store?: string|null, visitId: number, dateLabel: string, items: Array<object> }} params
 * @returns {Promise<Buffer>}
 */
function buildTagBatchPdf({ store, visitId, dateLabel, items }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: false });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const contentWidth = LETTER_WIDTH - PAGE_MARGIN * 2;
    const cellWidth = (contentWidth - COLUMN_GUTTER) / COLS;
    const meta = { store, visitId, dateLabel, count: items.length };

    if (!items.length) {
      doc.addPage();
      drawHeader(doc, meta);
      doc.end();
      return;
    }

    let pageContentTop = 0;
    let pageCellHeight = 0;

    for (let i = 0; i < items.length; i += 1) {
      const slotOnPage = i % ITEMS_PER_PAGE;

      if (slotOnPage === 0) {
        doc.addPage();
        pageContentTop = drawHeader(doc, meta);
        pageCellHeight = (LETTER_HEIGHT - PAGE_MARGIN - pageContentTop) / ROWS;
      }

      const { x, y } = slotPosition(slotOnPage, pageContentTop, cellWidth, pageCellHeight);
      const item = items[i];

      if (item.valid && item.primary) {
        drawValidCell(doc, item, x, y, cellWidth, pageCellHeight);
      } else {
        drawInvalidCell(doc, item, x, y, cellWidth, pageCellHeight);
      }
    }

    doc.end();
  });
}

module.exports = {
  buildTagBatchPdf,
  ITEMS_PER_PAGE,
};
