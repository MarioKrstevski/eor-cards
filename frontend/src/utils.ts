import type { CurriculumNode } from './types';

export function flattenTree(nodes: CurriculumNode[]): CurriculumNode[] {
  const result: CurriculumNode[] = [];
  function walk(list: CurriculumNode[]) {
    for (const node of list) {
      result.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  }
  walk(nodes);
  return result;
}

/** Returns the set of IDs for a node and all its descendants. */
export function subtreeIds(node: CurriculumNode): Set<number> {
  const ids = new Set<number>();
  function walk(n: CurriculumNode) {
    ids.add(n.id);
    for (const child of n.children) walk(child);
  }
  walk(node);
  return ids;
}

/** Builds a Record<nodeId, aggregatedCardCount> for the full tree. */
export function buildAggregatedCounts(
  tree: CurriculumNode[],
  directCounts: Record<string, number>
): Record<string, number> {
  const result: Record<string, number> = {};
  function walkOnce(node: CurriculumNode): number {
    const direct = directCounts[String(node.id)] ?? 0;
    const childSum = node.children.reduce((sum, c) => sum + walkOnce(c), 0);
    result[String(node.id)] = direct + childSum;
    return result[String(node.id)];
  }
  tree.forEach((root) => walkOnce(root));
  return result;
}
