import { deflateSync } from 'node:zlib';

/** Synthetic documents for repeatable profiling; no downloaded or user PDFs. */
export type PerformancePDFKind = 'vector' | 'scan';

function stream(content: Buffer, dictionary = ''): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${content.length} >>\nstream\n`),
    content,
    Buffer.from('\nendstream'),
  ]);
}

function assemble(objects: Buffer[]): Buffer {
  const pieces: Buffer[] = [Buffer.from('%PDF-1.4\n%\x80\x81\x82\x83\n', 'latin1')];
  const offsets: number[] = [];
  let length = pieces[0].length;
  objects.forEach((object, index) => {
    const prefix = Buffer.from(`${index + 1} 0 obj\n`);
    const suffix = Buffer.from('\nendobj\n');
    offsets.push(length);
    pieces.push(prefix, object, suffix);
    length += prefix.length + object.length + suffix.length;
  });
  const rows = offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(pieces);
}

function vectorPDF(): Buffer {
  const pageCount = 8;
  const pageIds = Array.from({ length: pageCount }, (_, index) => 4 + index * 2);
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  for (let page = 0; page < pageCount; page++) {
    const commands = [`0.1 0.15 0.2 rg BT /F1 20 Tf 30 752 Td (Dense vector page ${page + 1}) Tj ET`];
    for (let index = 0; index < 4000; index++) {
      const x = 26 + (index % 80) * 7;
      const y = 70 + Math.floor(index / 80) * 13;
      const red = ((index * 17 + page * 13) % 101 / 100).toFixed(2);
      const green = ((index * 31 + page * 7) % 101 / 100).toFixed(2);
      const blue = ((index * 47 + page * 19) % 101 / 100).toFixed(2);
      commands.push(`${red} ${green} ${blue} rg ${x} ${y} 6 11 re f`);
      if (index % 4 === 0) {
        commands.push(`0.1 g BT /F1 5 Tf ${x} ${y + 3} Td (${(index + page * 7) % 1000}) Tj ET`);
      }
    }
    objects.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[page] + 1} 0 R >>`),
      stream(Buffer.from(commands.join('\n') + '\n')),
    );
  }
  return assemble(objects);
}

function scanPDF(): Buffer {
  const pageCount = 6, width = 3000, height = 4000;
  const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index * 3);
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`),
  ];
  // Reuse one 12 MB grayscale buffer. Only compressed streams are retained;
  // each page has distinct image data and its own PDF image resource.
  const pixels = Buffer.allocUnsafe(width * height);
  for (let page = 0; page < pageCount; page++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const line = Math.floor((y - 300) / 64);
        const inText = x >= 160 && x < 2840 && y >= 300 && y < 3000
          && (y - 300) % 64 < 22 && (x + line * 7 + page * 19) % 97 < 73;
        const inChart = y >= 3150 && y < 3780 && x >= 200 && x < 2800;
        const chartBar = inChart && y > 3740 - ((Math.floor(x / 130) * 67 + page * 83) % 520)
          && x % 130 < 90;
        const noise = (x * 31 ^ y * 17 ^ page * 13) & 7;
        pixels[y * width + x] = inText ? 20 + noise : chartBar ? 70 + noise : 248 + noise;
      }
    }
    const image = deflateSync(pixels);
    const id = pageIds[page];
    objects.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Scan ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`),
      stream(Buffer.from('q 600 0 0 800 0 0 cm /Scan Do Q\n')),
      stream(image, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`),
    );
  }
  return assemble(objects);
}

/** Eight dense vector pages or six 12-megapixel scanned pages. */
export function performancePdf(kind: PerformancePDFKind): Buffer {
  return kind === 'vector' ? vectorPDF() : scanPDF();
}
