import { describe, expect, test } from 'bun:test';
import type { CallFlowNode } from '@plannotator/shared/call-flow-types';
import {
  annotationSelectionForCallFlowNode,
  selectionForCallFlowNode,
} from './CallFlowTreeView';

function node(overrides: Partial<CallFlowNode>): CallFlowNode {
  return {
    key: 'checkout -> authorize',
    label: 'authorize()',
    status: 'added',
    kind: 'call',
    file: 'src/checkout.ts',
    line: 41,
    children: [],
    ...overrides,
  };
}

describe('Call Flow source selections', () => {
  test('maps added and removed nodes to the native diff sides', () => {
    expect(selectionForCallFlowNode(node({ status: 'added', line: 41, endLine: 43 }))).toEqual({
      start: 41,
      end: 43,
      side: 'additions',
    });
    expect(selectionForCallFlowNode(node({ status: 'removed', line: 17 }))).toEqual({
      start: 17,
      end: 17,
      side: 'deletions',
    });
  });

  test('offers native annotation only for changed, located call sites', () => {
    expect(annotationSelectionForCallFlowNode(node({ status: 'same' }))).toBeNull();
    expect(annotationSelectionForCallFlowNode(node({ line: undefined }))).toBeNull();
    expect(annotationSelectionForCallFlowNode(node({ status: 'added' }))).toEqual({
      start: 41,
      end: 41,
      side: 'additions',
    });
  });
});
