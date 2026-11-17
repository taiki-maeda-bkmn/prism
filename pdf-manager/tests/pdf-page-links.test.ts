import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationLinkTarget, parsePDFDestination, resolvePDFDestinationPage, safePDFExternalURL } from '../src/renderer/pdfPageLayers';

test('PDF links allow ordinary web/email URLs and reject executable or local targets', () => {
  assert.equal(safePDFExternalURL('https://example.com/a?q=PDF#part'), 'https://example.com/a?q=PDF#part');
  assert.equal(safePDFExternalURL('http://example.com'), 'http://example.com/');
  assert.equal(safePDFExternalURL('mailto:reader@example.com?subject=Paper'), 'mailto:reader@example.com?subject=Paper');
  for (const value of [null, '', 'javascript:alert(1)', 'data:text/html,hello', 'file:///C:/notes.txt', 'blob:https://example.com/a',
    'ftp://example.com/file', 'custom:launch', '//example.com/file', 'C:\\paper.pdf', ' https://example.com',
    'https://user:password@example.com', 'https://example.com/\nattack', 'mailto:', 'mailto://example.com', 'https://example.com/' + 'x'.repeat(4096)]) {
    assert.equal(safePDFExternalURL(value), null, String(value));
  }
});

test('PDF annotation filtering never turns forms, scripts, remote files or print actions into controls', () => {
  assert.deepEqual(annotationLinkTarget({ annotationType: 2, url: 'https://example.com' }), { kind: 'external', url: 'https://example.com/' });
  assert.deepEqual(annotationLinkTarget({ subtype: 'Link', dest: '章 2' }), { kind: 'destination', destination: '章 2' });
  assert.deepEqual(annotationLinkTarget({ annotationType: 2, action: 'NextPage' }), { kind: 'action', action: 'NextPage' });
  for (const annotation of [
    { annotationType: 20, url: 'https://example.com' },
    { annotationType: 2, action: 'Print' },
    { annotationType: 2, action: 'Launch' },
    { annotationType: 2, url: 'file:///tmp/file.pdf', dest: [0, { name: 'Fit' }] },
    { annotationType: 2, url: 'javascript:alert(1)', dest: 'start' },
    { annotationType: 2, actions: { 'Mouse Up': ['alert(1)'] } },
    { annotationType: 2, resetForm: { fields: [] } },
    { annotationType: 2, attachment: { filename: 'launch.exe' } },
    null, 1, 'https://example.com',
  ]) assert.equal(annotationLinkTarget(annotation), null);
});

test('PDF destinations retain supported coordinates while rejecting malformed references and nonfinite values', () => {
  const input = [{ num: 5, gen: 0 }, { name: 'XYZ' }, null, 500, 1.5];
  assert.deepEqual(parsePDFDestination(input), input);
  assert.notEqual(parsePDFDestination(input), input);
  assert.deepEqual(parsePDFDestination([0, { name: 'Fit' }]), [0, { name: 'Fit' }]);
  assert.deepEqual(parsePDFDestination([1, { name: 'FitH' }, null]), [1, { name: 'FitH' }, null]);
  assert.deepEqual(parsePDFDestination([0, { name: 'FitR' }, 1, 2, 3, 4]), [0, { name: 'FitR' }, 1, 2, 3, 4]);
  for (const value of ['', null, 'x'.repeat(4097), '\0start', [-1, { name: 'Fit' }], [0.5, { name: 'Fit' }],
    [{ num: 0, gen: 0 }, { name: 'Fit' }], [{ num: 1, gen: -1 }, { name: 'Fit' }],
    [0, { name: 'Launch' }], [0, { name: 'Fit' }, 1], [0, { name: 'XYZ' }],
    [0, { name: 'XYZ' }, Infinity, null], [0, { name: 'FitH' }, NaN], [0, { name: 'FitR' }, null, 1, 2, 3]]) {
    assert.equal(parsePDFDestination(value), null);
  }
});

test('named, indexed and object destinations resolve to bounded pages without trusting PDF failures', async () => {
  const pdf = {
    numPages: 4,
    getDestination: async (name: string) => name === 'chapter' ? [{ num: 8, gen: 0 }, { name: 'Fit' }] : null,
    getPageIndex: async (reference: { num: number; gen: number }) => {
      if (reference.num !== 8) throw new Error('Missing reference');
      return 2;
    },
  };
  assert.equal(await resolvePDFDestinationPage(pdf, 'chapter'), 3);
  assert.equal(await resolvePDFDestinationPage(pdf, [0, { name: 'Fit' }]), 1);
  assert.equal(await resolvePDFDestinationPage(pdf, [3, { name: 'XYZ' }, null, null]), 4);
  assert.equal(await resolvePDFDestinationPage(pdf, [4, { name: 'Fit' }]), null);
  assert.equal(await resolvePDFDestinationPage(pdf, 'missing'), null);
  assert.equal(await resolvePDFDestinationPage(pdf, [{ num: 7, gen: 0 }, { name: 'Fit' }]), null);
});

test('cancelled destination resolution cannot return a stale navigation target', async () => {
  const controller = new AbortController();
  const pdf = {
    numPages: 4,
    getDestination: async () => { controller.abort(); return [0, { name: 'Fit' }]; },
    getPageIndex: async () => 0,
  };
  await assert.rejects(resolvePDFDestinationPage(pdf, 'chapter', controller.signal), { name: 'AbortError' });
  await assert.rejects(resolvePDFDestinationPage(pdf, [0, { name: 'Fit' }], controller.signal), { name: 'AbortError' });
});
