import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompactPlanNavigatorTrigger } from './AppHeader';

describe('compact Plan navigator trigger', () => {
  test('is a touch-safe disclosure with a stable focus-restoration target', () => {
    const html = renderToStaticMarkup(
      <CompactPlanNavigatorTrigger open={false} onToggle={() => {}} />,
    );

    expect(html).toContain('id="pn-compact-plan-navigator-trigger"');
    expect(html).toContain('data-pn-touch-target="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="pn-compact-plan-navigator"');
    expect(html).toContain('Open plan navigator');
    expect(html).toContain('>Plan<');
  });

  test('announces the open state without changing the control footprint', () => {
    const closed = renderToStaticMarkup(
      <CompactPlanNavigatorTrigger open={false} onToggle={() => {}} />,
    );
    const open = renderToStaticMarkup(
      <CompactPlanNavigatorTrigger open onToggle={() => {}} />,
    );

    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('Close plan navigator');
    expect(open).toContain('h-11 min-w-11');
    expect(closed).toContain('h-11 min-w-11');
  });
});
