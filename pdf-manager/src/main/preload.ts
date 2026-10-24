import { contextBridge } from 'electron';
import { createPDFAPI } from './pdf-api';

contextBridge.exposeInMainWorld('prismPdf', Object.freeze(createPDFAPI('prism-pdf:window')));
