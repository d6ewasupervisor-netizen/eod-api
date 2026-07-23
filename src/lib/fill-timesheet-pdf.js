'use strict';

const { PDFDocument, StandardFonts } = require('pdf-lib');

const SCHEMAS = {
  instawork: {
    storeField: 'Insta_Store_Number',
    leadField: 'Insta_Lead',
    dateField: 'Insta_Date',
    employeeFields: Array.from({ length: 10 }, (_, i) => `Instawork_${i + 1}`),
  },
  kompass: {
    storeField: 'Store_Number',
    leadField: 'Lead',
    dateField: 'Date',
    employeeFields: Array.from({ length: 10 }, (_, i) => `Employee_${i + 1}`),
  },
};

function chunkNames(names, size) {
  const list = Array.isArray(names) ? names.map((n) => String(n || '').trim()).filter(Boolean) : [];
  if (list.length === 0) return [[]];
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

function setTextField(form, name, value) {
  try {
    const field = form.getTextField(name);
    field.setText(String(value ?? ''));
  } catch (_) {
    // Field missing on an older template — skip.
  }
}

/**
 * Fill one or more timesheet pages from a fillable template.
 * When there are more employees than slots, starts a new sheet with the same
 * store/lead/date and the next batch of names.
 *
 * @returns {Promise<{ bytes: Uint8Array, pageCount: number, employeeCount: number }>}
 */
async function fillTimesheetPdf({
  templateBytes,
  sheetKey,
  storeNumber,
  leadName,
  date,
  employeeNames,
}) {
  const schema = SCHEMAS[sheetKey];
  if (!schema) throw new Error(`Unknown timesheet sheet: ${sheetKey}`);

  const slots = schema.employeeFields.length;
  const chunks = chunkNames(employeeNames, slots);
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);

  for (const chunk of chunks) {
    const doc = await PDFDocument.load(templateBytes);
    const form = doc.getForm();
    setTextField(form, schema.storeField, storeNumber);
    setTextField(form, schema.leadField, leadName);
    setTextField(form, schema.dateField, date);
    schema.employeeFields.forEach((fieldName, idx) => {
      setTextField(form, fieldName, chunk[idx] || '');
    });
    try {
      form.updateFieldAppearances(font);
    } catch (_) {
      // Some AcroForm fonts reject Helvetica; filled values still flatten.
    }
    try {
      form.flatten();
    } catch (_) {
      // Leave interactive if flatten fails — values are still present.
    }
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((page) => out.addPage(page));
  }

  const bytes = await out.save();
  const employeeCount = Array.isArray(employeeNames)
    ? employeeNames.map((n) => String(n || '').trim()).filter(Boolean).length
    : 0;
  return {
    bytes,
    pageCount: chunks.length,
    employeeCount,
  };
}

module.exports = {
  SCHEMAS,
  fillTimesheetPdf,
  chunkNames,
};
