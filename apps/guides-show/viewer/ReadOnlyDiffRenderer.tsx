import React from 'react';
import { AllFilesCodeView } from '@plannotator/review-editor/components/AllFilesCodeView';
import { useConfigValue } from '@plannotator/ui/config';
import type { GuideDiffRendererProps } from '@plannotator/guide-viewer/host';

const EMPTY_ANNOTATIONS: never[] = [];
const noop = () => {};

/**
 * The portable viewer's diff renderer: Plannotator's own `AllFilesCodeView`
 * in `readOnly` mode. Same component the in-app guide uses, so the diff panes
 * are byte-identical; the read-only switch only removes surfaces that need the
 * review server or mutate review state (decision record D2, D4).
 *
 * Display settings come from configStore defaults (or whatever the host
 * seeded) — never cookies, since the viewer installs an in-memory backend.
 */
export const ReadOnlyDiffRenderer: React.FC<GuideDiffRendererProps> = (props) => {
  const diffStyle = useConfigValue('diffStyle');
  const diffOverflow = useConfigValue('diffOverflow');
  const diffIndicators = useConfigValue('diffIndicators');
  const lineDiffType = useConfigValue('diffLineDiffType');
  const showLineNumbers = useConfigValue('diffShowLineNumbers');
  const showBackground = useConfigValue('diffShowBackground');
  const expandUnchanged = useConfigValue('diffExpandUnchanged');
  const fontFamily = useConfigValue('diffFontFamily');
  const fontSize = useConfigValue('diffFontSize');

  return (
    <AllFilesCodeView
      {...props}
      readOnly
      diffStyle={diffStyle}
      diffOverflow={diffOverflow}
      diffIndicators={diffIndicators}
      lineDiffType={lineDiffType}
      disableLineNumbers={!showLineNumbers}
      disableBackground={!showBackground}
      expandUnchanged={expandUnchanged}
      fontFamily={fontFamily || undefined}
      fontSize={fontSize || undefined}
      annotations={EMPTY_ANNOTATIONS}
      selectedAnnotationId={null}
      scrollTargetAnnotation={null}
      pendingSelection={null}
      onLineSelection={noop}
      onAddAnnotationForFile={noop}
      onEditAnnotation={noop}
      onSelectAnnotation={noop}
      onDeleteAnnotation={noop}
    />
  );
};

/** The guide chain forwards no extra props to a read-only renderer. */
export const getReadOnlyDiffRendererProps = (): Record<string, never> => ({});
