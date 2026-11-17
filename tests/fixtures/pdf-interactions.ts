function stream(content: string | Buffer): Buffer {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'ascii') : content;
  return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
}

function pdf(objects: Array<string | Buffer>): Buffer {
  const pieces: Buffer[] = [Buffer.from('%PDF-1.4\n%\x80\x81\x82\x83\n', 'latin1')];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pieces.reduce((size, piece) => size + piece.length, 0));
    pieces.push(Buffer.from(`${index + 1} 0 obj\n`), typeof object === 'string' ? Buffer.from(object, 'ascii') : object, Buffer.from('\nendobj\n'));
  }
  const start = pieces.reduce((size, piece) => size + piece.length, 0);
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`));
  return Buffer.concat(pieces);
}

const line = (text: string, y: number, size = 16) => `BT /F1 ${size} Tf 48 ${y} Td (${text}) Tj ET\n`;

/** Text, deliberately different link action types, and a final image-only page. */
export function interactionPdf(): Buffer {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(ChapterTwo) [5 0 R /Fit]] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R /F2 10 0 R >> >> /Contents 4 0 R /Annots [11 0 R 12 0 R 13 0 R 14 0 R 15 0 R 16 0 R] >>',
    stream('0.16 0.24 0.34 rg\n' + line('Searchable PDF', 744, 25) + line('Selectable copy text.', 696)
      + line('needle appears on page one.', 660)
      + 'BT /F1 16 Tf 48 624 Td (alpha ) Tj /F2 16 Tf (beta) Tj ET\n'
      + line('cross', 588) + line('line match', 566)
      + line('Open website', 500) + line('Jump to page two', 464) + line('Named chapter', 428)
      + line('Send email', 392) + line('Ignored script action', 356) + line('Ignored local file', 320)),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R /Annots [17 0 R 18 0 R] >>',
    stream('0.16 0.24 0.34 rg\n' + line('Chapter two', 744, 25) + line('needle appears on page two.', 696)
      + line('A destination inside the same document.', 660) + line('Return to first page', 600) + line('Go to image-only page', 564)),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Image 19 0 R >> >> /Contents 8 0 R >>',
    stream('q 516 0 0 640 48 76 cm /Image Do Q'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Annot /Subtype /Link /Rect [48 496 180 518] /Border [0 0 0] /A << /S /URI /URI (https://example.com/prism) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [48 460 220 482] /Border [0 0 0] /Dest [5 0 R /XYZ null 700 null] >>',
    '<< /Type /Annot /Subtype /Link /Rect [48 424 190 446] /Border [0 0 0] /A << /S /GoTo /D (ChapterTwo) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [48 388 180 410] /Border [0 0 0] /A << /S /URI /URI (mailto:reader@example.com) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [48 352 220 374] /Border [0 0 0] /A << /S /JavaScript /JS (app.alert\(123\)) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [48 316 220 338] /Border [0 0 0] /A << /S /URI /URI (file:///C:/Windows/notepad.exe) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [48 596 220 618] /Border [0 0 0] /A << /S /Named /N /FirstPage >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [48 560 250 582] /Border [0 0 0] /Dest [7 0 R /Fit] >>',
    Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n'),
      Buffer.from([48, 90, 110, 120, 175, 90, 190, 120, 60, 225, 220, 175]), Buffer.from('\nendstream')]),
  ]);
}

/** A real raster PDF with no hidden OCR text. */
export function imageOnlyPdf(): Buffer {
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Image 5 0 R >> >> /Contents 4 0 R >>',
    stream('q 516 0 0 640 48 76 cm /Image Do Q'),
    Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 12 >>\nstream\n'),
      Buffer.from([48, 90, 110, 120, 175, 90, 190, 120, 60, 225, 220, 175]), Buffer.from('\nendstream')]),
  ]);
}
