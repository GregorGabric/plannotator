import { HtmlSurfaceControls } from '@plannotator/ui/components/HtmlSurfaceControls';

interface HtmlSurfaceActionsProps {
  canRefresh: boolean;
  isRefreshing: boolean;
  toolsHidden: boolean;
  onRefresh: () => void;
  onToggleTools: () => void;
}

/** Plannotator's refresh strings for the published control: the document
 * is a file on disk, so the refresh says so. Shared with AppHeader. */
export const PLANNOTATOR_HTML_REFRESH_LABELS = {
  refreshTitle: 'Refresh HTML from disk',
  refreshingTitle: 'Refreshing HTML from disk',
} as const;

/** Eye + refresh, without the pen: the published HtmlSurfaceControls with
 * Plannotator's refresh strings. Kept as the local name the header used. */
export function HtmlSurfaceActions({
  canRefresh,
  isRefreshing,
  toolsHidden,
  onRefresh,
  onToggleTools,
}: HtmlSurfaceActionsProps) {
  return (
    <HtmlSurfaceControls
      armed={false}
      toolsHidden={toolsHidden}
      onToggleTools={onToggleTools}
      canRefresh={canRefresh}
      onRefresh={onRefresh}
      isRefreshing={isRefreshing}
      labels={PLANNOTATOR_HTML_REFRESH_LABELS}
    />
  );
}
