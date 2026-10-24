import { LibraryWorkspace } from './App';

export default function PDFWorkspace({ active, onAppearance }: { active: boolean; onAppearance: () => void }) {
  return <LibraryWorkspace workspaceActive={active} onAppearance={onAppearance} />;
}
