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

/**
 * Parses a single CSV line respecting quoted fields (handles commas,
 * escaped quotes, and embedded content inside double quotes).
 * Does NOT rely on a naive .split(',').
 */
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
        i++; // skip escaped quote
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

/**
 * Re-serializes a row array back into a proper CSV line,
 * quoting any field that contains a comma, quote, or newline.
 */
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

/**
 * Validates and normalizes the raw CSV string.
 *
 * @param {string} rawCsv - the raw CSV text returned by the model
 * @param {object} [options]
 * @param {boolean} [options.padShortRows=true] - pad rows with fewer
 *   than EXPECTED_COLUMNS fields with trailing empty strings, rather
 *   than rejecting them outright.
 * @returns {{
 *   valid: boolean,
 *   rows: string[][],
 *   cleanedCsv: string,
 *   errors: string[],
 *   flaggedRows: { lineNumber: number, original: string, fieldCount: number }[]
 * }}
 */
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

  const normalize = (arr) => arr.map((f) => f.trim().toLowerCase());
  const headerNormalized = normalize(HEADER);

  let sawHeader = false;

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;

    // Strip stray markdown fences the model sometimes emits despite instructions
    if (/^```/.test(line.trim())) {
      return;
    }

    // Strip stray markdown emphasis characters (**bold**, __underline__)
    // that the model occasionally wraps around a repeated header row.
    const cleanedLine = line.replace(/\*\*/g, '').replace(/__/g, '');

    const fields = parseCsvLine(cleanedLine);

    // Detect header rows (first one is kept implicitly via HEADER constant;
    // any repeat, anywhere in the output, is dropped rather than treated as data)
    if (fields.length === EXPECTED_COLUMNS && JSON.stringify(normalize(fields)) === JSON.stringify(headerNormalized)) {
      if (!sawHeader) {
        sawHeader = true;
      }
      return; // never push header rows into `rows`
    }

    if (fields.length === EXPECTED_COLUMNS) {
      rows.push(fields);
      return;
    }

    // Row is short or long — flag it regardless of what we do next.
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
      // Too many fields — likely an unescaped comma inside a field
      // (e.g. an address like "Philadelphia, PA" that wasn't quoted).
      errors.push(
        `Line ${lineNumber}: expected ${EXPECTED_COLUMNS} fields, got ${fields.length} (likely an unescaped comma in a field, e.g. an address).`
      );
      // Don't guess how to merge fields back together — surface for manual review.
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
