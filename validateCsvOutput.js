/**
 * validateCsvOutput.js
 *
 * Validates the raw CSV string returned by the OpenAI extraction call
 * before it gets written to Supabase / converted to XLSX.
 *
 * Catches the "column drift" bug: when a model drops a comma for a
 * blank field instead of leaving an empty string between two commas,
 * every value after that point shifts one column to the left.
 *
 * Usage:
 *   const { validateCsv } = require('./validateCsvOutput');
 *   const result = validateCsv(rawCsvString);
 *   if (!result.valid) {
 *     console.error(result.errors);
 *   }
 *   // result.rows -> array of parsed, padded row arrays (safe to write out)
 */

const EXPECTED_COLUMNS = 13;

const HEADER = [
  'Document Type',
  'Provider/Issuer Name',
  'Document/Account ID',
  'Transaction Date',
  'Line Item Description',
  'Quantity',
  'CPT/Procedure Code',
  'Gross Amount',
  'Adjustments/Discounts/Tax',
  'Net Responsibility',
  'Currency',
  'Issuer Contact Phone',
  'Issuer Mailing Address',
];

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}

function toCsvLine(fields) {
  return fields
    .map((field) => {
      const str = field == null ? '' : String(field);
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    })
    .join(',');
}

function validateCsv(rawCsv, options = {}) {
  const { padShortRows = true } = options;

  const errors = [];
  const flaggedRows = [];
  const rows = [];

  const lines = rawCsv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return {
      valid: false,
      rows: [],
      cleanedCsv: '',
      errors: ['No content returned from extraction.'],
      flaggedRows: [],
    };
  }

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    const fields = parseCsvLine(line);

    if (fields.length === EXPECTED_COLUMNS) {
      rows.push(fields);
      return;
    }

    flaggedRows.push({
      lineNumber,
      original: line,
      fieldCount: fields.length,
    });

    if (fields.length < EXPECTED_COLUMNS) {
      errors.push(
        `Line ${lineNumber}: expected ${EXPECTED_COLUMNS} fields, got ${fields.length} (likely a dropped blank field — column drift risk).`
      );
      if (padShortRows) {
        const padded = [...fields];
        while (padded.length < EXPECTED_COLUMNS) padded.push('');
        rows.push(padded);
      }
    } else {
      errors.push(
        `Line ${lineNumber}: expected ${EXPECTED_COLUMNS} fields, got ${fields.length} (likely an unescaped comma in a field, e.g. an address).`
      );
    }
  });

  const cleanedCsv = [HEADER, ...rows.filter((r) => r !== HEADER)]
    .map(toCsvLine)
    .join('\n');

  return {
    valid: errors.length === 0,
    rows,
    cleanedCsv,
    errors,
    flaggedRows,
  };
}

module.exports = { validateCsv, parseCsvLine, toCsvLine, EXPECTED_COLUMNS, HEADER };
