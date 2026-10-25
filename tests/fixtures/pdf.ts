import { createHash } from 'node:crypto';

const passwordPadding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (value: Uint8Array) => createHash('md5').update(value).digest();
function paddedPassword(value: string) { return Buffer.concat([Buffer.from(value, 'latin1'), passwordPadding]).subarray(0, 32); }
function rc4(key: Uint8Array, value: Uint8Array) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  const output = Buffer.alloc(value.length);
  let i = 0; j = 0;
  for (let offset = 0; offset < value.length; offset++) {
    i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]];
    output[offset] = value[offset] ^ state[(state[i] + state[j]) & 255];
  }
  return output;
}

// A complete, reproducible two-page PDF, with a standard revision-2 encrypted
// variant. Tests exercise the actual parser/worker/canvas, never a mocked reader.
export function fixturePdf(password?: string): Buffer {
  const fileId = md5(Buffer.from(`prism-pdf-desktop-fixture-${password ?? 'plain'}`));
  const owner = password ? rc4(md5(paddedPassword('owner-secret')).subarray(0, 5), paddedPassword(password)) : null;
  const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const key = password && owner ? md5(Buffer.concat([paddedPassword(password), owner, permissions, fileId])).subarray(0, 5) : null;
  const stream = (object: number, content: string) => {
    let bytes = Buffer.from(content, 'ascii');
    if (key) {
      const objectId = Buffer.alloc(5); objectId.writeUIntLE(object, 0, 3);
      bytes = rc4(md5(Buffer.concat([key, objectId])).subarray(0, 10), bytes);
    }
    return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
  };
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>'),
    stream(4, '0.9 0.42 0.25 rg 48 520 516 180 re f\n0.13 0.18 0.15 rg BT /F1 30 Tf 48 460 Td (Prism PDF field notes) Tj ET\nBT /F1 16 Tf 48 420 Td (A real local document, page one.) Tj ET\n'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>'),
    stream(6, '0.25 0.48 0.4 rg 48 520 516 180 re f\n0.13 0.18 0.15 rg BT /F1 30 Tf 48 460 Td (The next chapter) Tj ET\nBT /F1 16 Tf 48 420 Td (Your reading position is remembered.) Tj ET\n'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  if (key && owner) objects.push(Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${rc4(key, passwordPadding).toString('hex')}> /P -4 >>`));
  const pieces: Buffer[] = [Buffer.from('%PDF-1.4\n%\x80\x81\x82\x83\n', 'latin1')];
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(pieces.reduce((sum, piece) => sum + piece.length, 0));
    pieces.push(Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from('\nendobj\n'));
  }
  const startXref = pieces.reduce((sum, piece) => sum + piece.length, 0);
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${key ? ` /Encrypt 8 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]` : ''} >>\nstartxref\n${startXref}\n%%EOF\n`));
  return Buffer.concat(pieces);
}
