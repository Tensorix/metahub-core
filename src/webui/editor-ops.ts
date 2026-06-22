import { type Block, type BlockDraft, type BlockType, applyBlockDraft, blocksToText, genId, isListType } from "./blocks.ts";

export interface FoundBlock {
  block: Block;
  parent: Block[];
  index: number;
  parentBlock: Block | null;
}

export interface BlockEntry extends FoundBlock {
  depth: number;
}

export function findBlock(blocks: Block[], id: string, parentBlock: Block | null = null): FoundBlock | null {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.id === id) return { block, parent: blocks, index: i, parentBlock };
    const found = block.children ? findBlock(block.children, id, block) : null;
    if (found) return found;
  }
  return null;
}

export function countBlocks(blocks: readonly Block[]): number {
  let count = 0;
  for (const block of blocks) count += 1 + countBlocks(block.children ?? []);
  return count;
}

export function cloneBlock(block: Block): Block {
  return {
    ...block,
    id: genId(),
    children: block.children?.map(cloneBlock),
  };
}

export function containsBlock(blocks: readonly Block[] | undefined, id: string): boolean {
  for (const block of blocks ?? []) {
    if (block.id === id || containsBlock(block.children, id)) return true;
  }
  return false;
}

/** A list item that is really just a code block — empty text, code as its first
 *  child. It renders no line of its own (the child code block stands in), so it
 *  is transparent for vertical caret navigation. */
export function isCompactCodeHost(block: Block): boolean {
  return (
    isListType(block.type) &&
    block.content.trim() === "" &&
    block.children?.[0]?.type === "code"
  );
}

export function flattenBlocks(blocks: readonly Block[], out: Block[] = []): Block[] {
  for (const block of blocks) {
    out.push(block);
    if (block.children) flattenBlocks(block.children, out);
  }
  return out;
}

export function flattenBlockEntries(
  blocks: Block[],
  out: BlockEntry[] = [],
  parentBlock: Block | null = null,
  depth = 0,
): BlockEntry[] {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    out.push({ block, parent: blocks, index: i, parentBlock, depth });
    if (block.children) flattenBlockEntries(block.children, out, block, depth + 1);
  }
  return out;
}

export function previousBlock(blocks: readonly Block[], id: string): Block | null {
  let previous: Block | null = null;
  let found: Block | null = null;
  const visit = (items: readonly Block[]) => {
    for (const block of items) {
      if (block.id === id) {
        found = previous;
        return;
      }
      previous = block;
      if (block.children) visit(block.children);
      if (found) return;
    }
  };
  visit(blocks);
  return found;
}

export function nextBlock(blocks: readonly Block[], id: string): Block | null {
  const flat = flattenBlocks(blocks);
  const i = flat.findIndex((b) => b.id === id);
  return i >= 0 && i + 1 < flat.length ? flat[i + 1]! : null;
}

export function removeBlockById(blocks: Block[], id: string): Block | null {
  const found = findBlock(blocks, id);
  if (!found) return null;
  const [removed] = found.parent.splice(found.index, 1);
  if (found.parent.length === 0 && found.parentBlock) delete found.parentBlock.children;
  return removed ?? null;
}

export function moveBlock(blocks: Block[], srcId: string, targetId: string, where: "before" | "after"): boolean {
  if (srcId === targetId) return false;
  const source = findBlock(blocks, srcId);
  const target = findBlock(blocks, targetId);
  if (!source || !target || containsBlock(source.block.children, targetId)) return false;

  const moved = source.parent.splice(source.index, 1)[0]!;
  const freshTarget = findBlock(blocks, targetId);
  if (!freshTarget) {
    source.parent.splice(source.index, 0, moved);
    return false;
  }
  if (source.parent.length === 0 && source.parentBlock) delete source.parentBlock.children;
  freshTarget.parent.splice(freshTarget.index + (where === "after" ? 1 : 0), 0, moved);
  return true;
}

export function indentBlock(blocks: Block[], id: string): boolean {
  const found = findBlock(blocks, id);
  if (!found || found.index === 0) return false;
  const previous = found.parent[found.index - 1]!;
  if (!isListType(previous.type)) return false;
  const moved = found.parent.splice(found.index, 1)[0]!;
  previous.children ??= [];
  previous.children.push(moved);
  return true;
}

export function outdentBlock(blocks: Block[], id: string): boolean {
  const found = findBlock(blocks, id);
  if (!found?.parentBlock) return false;
  const parentFound = findBlock(blocks, found.parentBlock.id);
  if (!parentFound) return false;

  const lifted = found.parent.splice(found.index);
  if (!lifted.length) return false;
  if (found.parent.length === 0) delete found.parentBlock.children;
  parentFound.parent.splice(parentFound.index + 1, 0, ...lifted);
  return true;
}

export function topmostBlockIds(blocks: readonly Block[], ids: readonly string[]): string[] {
  const selected = new Set(ids);
  const out: string[] = [];
  const visit = (items: readonly Block[], hasSelectedAncestor: boolean) => {
    for (const block of items) {
      const isSelected = selected.has(block.id);
      if (isSelected && !hasSelectedAncestor) out.push(block.id);
      if (block.children) visit(block.children, hasSelectedAncestor || isSelected);
    }
  };
  visit(blocks, false);
  return out;
}

/** Convert a single block to a target type in place, mirroring the editor's
 *  single-block rules: a list→list change keeps the children, any other target
 *  drops them. Returns false if the id isn't found. Shared by the editor's
 *  single-block `convert` and the multi-select `convertSelected`. */
export function convertBlockType(
  blocks: Block[],
  id: string,
  type: BlockType,
  draft: Partial<BlockDraft> = {},
): boolean {
  const found = findBlock(blocks, id);
  const b = found?.block;
  if (!b) return false;
  const children = isListType(type) ? b.children : undefined;
  applyBlockDraft(b, type, draft);
  if (children?.length) b.children = children;
  else delete b.children;
  return true;
}

/** Flatten-ordered ids spanning anchor..focus inclusive (continuous range). */
export function blockRangeIds(blocks: readonly Block[], anchorId: string, focusId: string): string[] {
  const flat = flattenBlocks(blocks);
  const a = flat.findIndex((b) => b.id === anchorId);
  const b = flat.findIndex((b) => b.id === focusId);
  if (a < 0 || b < 0) return [];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return flat.slice(from, to + 1).map((blk) => blk.id);
}

/**
 * Remove every selected block (children come along with a selected parent) and
 * return the id of the block to focus afterwards — the nearest surviving block
 * before the selection, else after it, else the first remaining block.
 */
export function deleteBlocks(blocks: Block[], ids: readonly string[]): string | null {
  if (!ids.length) return null;
  const idSet = new Set(ids);
  const flat = flattenBlocks(blocks);
  const firstSel = flat.findIndex((b) => idSet.has(b.id));
  if (firstSel < 0) return null;

  let focusId: string | null = null;
  for (let i = firstSel - 1; i >= 0; i--) if (!idSet.has(flat[i]!.id)) { focusId = flat[i]!.id; break; }
  if (!focusId) for (let i = firstSel + 1; i < flat.length; i++) if (!idSet.has(flat[i]!.id)) { focusId = flat[i]!.id; break; }

  for (const id of topmostBlockIds(blocks, ids)) removeBlockById(blocks, id);
  if (focusId && !findBlock(blocks, focusId)) focusId = null;
  return focusId ?? flattenBlocks(blocks)[0]?.id ?? null;
}

/** Duplicate the topmost selected blocks, inserting the copies as a group right
 *  after the last selected block. Returns the ids of the new clones. */
export function duplicateBlocks(blocks: Block[], ids: readonly string[]): string[] {
  const tops = topmostBlockIds(blocks, ids);
  if (!tops.length) return [];
  const clones: Block[] = [];
  for (const id of tops) {
    const found = findBlock(blocks, id);
    if (found) clones.push(cloneBlock(found.block));
  }
  const last = findBlock(blocks, tops[tops.length - 1]!);
  if (!last || !clones.length) return [];
  last.parent.splice(last.index + 1, 0, ...clones);
  return clones.map((b) => b.id);
}

/** Move the topmost selected blocks as a group before/after the target block. */
export function moveBlocks(
  blocks: Block[],
  ids: readonly string[],
  targetId: string,
  where: "before" | "after",
): boolean {
  const tops = topmostBlockIds(blocks, ids);
  if (!tops.length || tops.includes(targetId)) return false;
  for (const id of tops) {
    const found = findBlock(blocks, id);
    if (found && containsBlock(found.block.children, targetId)) return false;
  }
  const moved: Block[] = [];
  for (const id of tops) {
    const removed = removeBlockById(blocks, id);
    if (removed) moved.push(removed);
  }
  const target = findBlock(blocks, targetId);
  if (!target) {
    blocks.push(...moved); // target vanished (shouldn't happen) — keep blocks alive
    return false;
  }
  target.parent.splice(target.index + (where === "after" ? 1 : 0), 0, ...moved);
  return true;
}

/** Serialize the topmost selected blocks (with children) to Markdown. */
export function serializeBlocks(blocks: Block[], ids: readonly string[]): string {
  const selection = topmostBlockIds(blocks, ids)
    .map((id) => findBlock(blocks, id)?.block)
    .filter((b): b is Block => !!b);
  return blocksToText(selection);
}

export function indentBlocks(blocks: Block[], ids: readonly string[]): string[] {
  const changed: string[] = [];
  for (const id of topmostBlockIds(blocks, ids)) {
    if (indentBlock(blocks, id)) changed.push(id);
  }
  return changed;
}

export function outdentBlocks(blocks: Block[], ids: readonly string[]): string[] {
  const changed: string[] = [];
  for (const id of topmostBlockIds(blocks, ids)) {
    if (outdentBlock(blocks, id)) changed.push(id);
  }
  return changed;
}
