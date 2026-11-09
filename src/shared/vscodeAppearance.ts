/** Only supported appearance values cross into the renderer, never VS Code settings. */
export interface VSCodeAppearanceImport {
  name: string;
  source: string;
  colors: { accent?: string; background?: string; text?: string };
  warnings: string[];
}
