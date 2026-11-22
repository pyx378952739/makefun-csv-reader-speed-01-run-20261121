// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// reading of {text, header} as {columns, rows, errors}.
//
// Same policy, single left-to-right pass, but instead of building every field
// one character at a time it finds each field's end with one native regex scan
// (/[,\r\n]/) and takes the field with a slice; quoted fields find their
// closing quote with indexOf and take the content with a slice, only
// rebuilding (doubled quotes, CR/CRLF -> LF) when the content actually holds
// one of those. Stray CRs, unterminated quotes and quote junk are the rare
// paths and are handled exactly as the reference does.

const DELIM = /[,\r\n]/g;
const QUOTED_SPECIAL = /["\r\n]/;

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field starting at `start`, whose value so far is
  // `initial` ("" normally, the field's value so far for quote junk, or '"'
  // for an unterminated quote re-read). Returns {value, ended}.
  function readUnquoted(start, initial) {
    let parts = null; // segments, only when a stray CR is dropped mid-field
    let segStart = start;
    let p = start;
    for (;;) {
      DELIM.lastIndex = p;
      const m = DELIM.exec(text);
      if (m === null) {
        pos = n;
        if (parts === null) return { value: initial + text.slice(segStart), ended: END };
        parts.push(text.slice(segStart));
        return { value: parts.join(''), ended: END };
      }
      const idx = m.index;
      const c = m[0];
      if (c === ',') {
        pos = idx + 1;
        if (parts === null) return { value: initial + text.slice(segStart, idx), ended: COMMA };
        parts.push(text.slice(segStart, idx));
        return { value: parts.join(''), ended: COMMA };
      }
      if (c === '\n') {
        pos = idx + 1;
        line += 1;
        if (parts === null) return { value: initial + text.slice(segStart, idx), ended: LINE_BREAK };
        parts.push(text.slice(segStart, idx));
        return { value: parts.join(''), ended: LINE_BREAK };
      }
      // c === '\r'
      if (text.charCodeAt(idx + 1) === 10) {
        pos = idx + 2;
        line += 1;
        if (parts === null) return { value: initial + text.slice(segStart, idx), ended: LINE_BREAK };
        parts.push(text.slice(segStart, idx));
        return { value: parts.join(''), ended: LINE_BREAK };
      }
      // Lone CR outside quotes: dropped, error, keep reading.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [initial, text.slice(segStart, idx)];
      else parts.push(text.slice(segStart, idx));
      p = idx + 1;
      segStart = idx + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns {value, ended}.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // The closing quote is the first '"' not followed by another '"'.
    let q = text.indexOf('"', open + 1);
    while (q !== -1 && text.charCodeAt(q + 1) === 34) q = text.indexOf('"', q + 2);
    if (q === -1) {
      // Never closes: the quote is a literal character and the text after it
      // is read again as unquoted; line counting restarts at the open line.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      line = openLine;
      return readUnquoted(open + 1, '"');
    }
    const content = text.slice(open + 1, q);
    let value;
    if (!QUOTED_SPECIAL.test(content)) {
      value = content;
    } else {
      // Rebuild: "" -> ", CRLF and lone CR -> LF; count the line breaks.
      // Every '"' in content is the first of a "" pair (else it would have
      // been the closing quote), so the pairs never overlap ambiguously.
      let parts = null;
      let seg = 0;
      let breaks = 0;
      for (let i = 0; i < content.length; i++) {
        const cc = content.charCodeAt(i);
        if (cc === 34) {
          if (parts === null) parts = [content.slice(0, i)];
          else parts.push(content.slice(seg, i));
          parts.push('"');
          i += 1; // skip the second quote of the pair
          seg = i + 1;
        } else if (cc === 13) {
          breaks += 1;
          if (parts === null) parts = [content.slice(0, i)];
          else parts.push(content.slice(seg, i));
          parts.push('\n');
          if (content.charCodeAt(i + 1) === 10) i += 1; // CRLF is one break
          seg = i + 1;
        } else if (cc === 10) {
          breaks += 1; // LF stays as it is, inside the current segment
        }
      }
      if (parts !== null) {
        parts.push(content.slice(seg));
        value = parts.join('');
      } else {
        value = content;
      }
      line += breaks;
    }
    pos = q + 1;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break (quote_junk when anything was kept).
    const junk = readUnquoted(pos, value);
    if (junk.value.length > value.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted(pos, '');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
