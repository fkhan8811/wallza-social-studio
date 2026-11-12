import { CreativeStudioEditorComponent } from '@gitroom/frontend/components/creative-studio/creative-studio-editor.component';

export default function CreativeStudioEditorPage({ params }: { params: { id: string } }) {
  return <CreativeStudioEditorComponent projectId={params.id} />;
}
