import assert from 'node:assert/strict';
import test from 'node:test';
import { fileToCsv, normalizeDelimited, textToCsv } from './spreadsheet-file.js';

function zipStored(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const end = new DataView(eocd.buffer);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + eocd.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  out.set(eocd, cursor);
  return out;
}

function asFile(name, bytes) {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => new TextDecoder().decode(bytes),
  };
}

test('semicolon and tab spreadsheets become comma CSV', () => {
  assert.equal(normalizeDelimited('name;quantity\nAbra;2\n'), 'name,quantity\nAbra,2\n');
  assert.equal(normalizeDelimited('name\tquantity\nAbra\t2'), 'name,quantity\nAbra,2\n');
  assert.equal(normalizeDelimited('name,quantity\n"A, B",1\n'), 'name,quantity\n"A, B",1\n');
});

test('xlsx first sheet becomes CSV, including shared strings', async () => {
  const bytes = zipStored([
    ['xl/sharedStrings.xml', '<sst><si><t>blueprint_id</t></si><si><t>name</t></si><si><t>Pikachu</t></si></sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="A2"><v>123</v></c><c r="C2" t="s"><v>2</v></c></worksheet>'],
  ]);
  assert.equal(
    await fileToCsv(asFile('stock.xlsx', bytes)),
    'blueprint_id,name,\n123,,Pikachu\n',
  );
});

test('ods and spreadsheet XML become CSV', async () => {
  const ods = zipStored([
    ['content.xml', '<office:document><table:table-row><table:table-cell><text:p>name</text:p></table:table-cell><table:table-cell><text:p>qty</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>Abra</text:p></table:table-cell><table:table-cell office:value="2"><text:p>2</text:p></table:table-cell></table:table-row></office:document>'],
  ]);
  assert.equal(await fileToCsv(asFile('stock.ods', ods)), 'name,qty\nAbra,2\n');
  const xml = '<Worksheet><Row><Cell><Data ss:Type="String">name</Data></Cell></Row><Row><Cell ss:Index="1"><Data ss:Type="String">Mew</Data></Cell></Row></Worksheet>';
  assert.equal(await textToCsv(xml, 'stock.xml'), 'name\nMew\n');
});

test('.xls asks for xlsx or csv', async () => {
  await assert.rejects(
    () => fileToCsv(asFile('stock.xls', new TextEncoder().encode('nope'))),
    /xlsx or \.csv/,
  );
});
