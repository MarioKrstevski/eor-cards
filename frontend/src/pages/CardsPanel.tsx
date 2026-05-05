import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { ColumnSizingState, PaginationState, VisibilityState } from '@tanstack/react-table';
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import {
  estimateCost,
  startGeneration,
  getGenerationJob,
  getCards,
  getRuleSets,
  updateCard,
  rejectCard,
  deleteCard,
  regenerateCard,
  exportCardsUrl,
  bulkMarkReviewed,
  bulkDeleteCards,
  estimateSupplemental,
  startSupplemental,
} from '../api';
import type { Card, CostEstimate, CardStatus, SupplementalEstimate } from '../types';
import ConfirmModal from '../components/ConfirmModal';
import AlertModal from '../components/AlertModal';
import AnkifyModal from '../components/AnkifyModal';
import { useSettings } from '../context/SettingsContext';

interface CardsPanelProps {
  documentId: number | null;
  chunkId?: number | null;
  topicPath?: string | null;
  refreshKey?: number;
  refreshUsage?: () => void;
  onReviewChange?: () => void;
  onGoToChunk?: (documentId: number, chunkId: number) => void;
}

const columnHelper = createColumnHelper<Card>();

// ── Cloze rendering utility ────────────────────────────────────────────────────
function renderClozeHtml(html: string): string {
  // Strip wrapped span variants first
  let result = html.replace(
    /(?:<b>)?<span[^>]*>\{\{c\d+::([^}]+)\}\}<\/span>(?:<\/b>)?/g,
    '<span style="color:#1d4ed8;font-weight:700">$1</span>'
  );
  // Bare cloze
  result = result.replace(
    /\{\{c\d+::([^}]+)\}\}/g,
    '<span style="color:#1d4ed8;font-weight:700">$1</span>'
  );
  return result;
}

function stripHtmlKeepCloze(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ── Excel-style editable cell ──────────────────────────────────────────────────
// Self-contained: manages its own edit state. Selection (box-shadow on <td>)
// is handled by the parent via DOM refs — no React state change on click.
interface EditableCellProps {
  value: string;
  cellId: string; // "rowIndex:colId" — used to find the cell in the DOM
  onSelect: (cellId: string) => void;
  onSave: (val: string) => void;
  onNavigate: (dir: 'up' | 'down' | 'left' | 'right') => void;
  multiline?: boolean;
  renderDisplay?: (val: string) => React.ReactNode;
  clampLines?: number; // max lines to show in display mode (0 = no clamp)
}

function EditableCell({ value, cellId, onSelect, onSave, onNavigate, multiline, renderDisplay, clampLines }: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value);
  const divRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep local value in sync when saved value changes externally
  useEffect(() => {
    if (!isEditing) setLocalVal(value);
  }, [value, isEditing]);

  // Auto-resize textarea to fit content
  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  useEffect(() => {
    if (isEditing && textareaRef.current) autoResize(textareaRef.current);
  }, [isEditing, localVal]);

  function startEdit() {
    setLocalVal(value);
    setIsEditing(true);
  }

  function save() {
    setIsEditing(false);
    if (localVal !== value) onSave(localVal);
  }

  function cancel() {
    setIsEditing(false);
    setLocalVal(value);
  }

  if (isEditing) {
    const keyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Tab') { e.preventDefault(); save(); }
    };
    return (
      <div className="w-full h-full">
        {multiline ? (
          <textarea
            ref={textareaRef}
            value={localVal}
            onChange={(e) => { setLocalVal(e.target.value); if (!clampLines) autoResize(e.target); }}
            onBlur={save}
            onKeyDown={keyDown}
            autoFocus
            className={`w-full text-sm bg-white border-0 outline-none p-0 leading-relaxed resize-none ${clampLines ? 'overflow-auto' : 'overflow-hidden'}`}
            style={{ minHeight: '2rem', ...(clampLines ? { height: '20em' } : {}) }}
          />
        ) : (
          <input
            type="text"
            value={localVal}
            onChange={(e) => setLocalVal(e.target.value)}
            onBlur={save}
            onKeyDown={keyDown}
            autoFocus
            className="w-full text-sm bg-white border-0 outline-none p-0 leading-relaxed"
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={divRef}
      data-cell-id={cellId}
      tabIndex={0}
      onClick={() => onSelect(cellId)}
      onDoubleClick={startEdit}
      onFocus={() => onSelect(cellId)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up'); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down'); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); onNavigate('left'); }
        if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('right'); }
        if (e.key === 'Enter') { e.preventDefault(); startEdit(); }
      }}
      className="cursor-default outline-none w-full h-full"
      style={{
        minHeight: '2rem',
        ...(clampLines ? { maxHeight: `${clampLines * 1.6}em`, overflow: 'hidden' } : {}),
      }}
    >
      {renderDisplay ? renderDisplay(value) : <span className="text-sm text-gray-800">{value}</span>}
    </div>
  );
}

// ── CardTile component ─────────────────────────────────────────────────────────
interface CardTileProps {
  card: Card;
  cardIndex: number;
  onEdit: (card: Card) => void;
  onReject: (id: number) => void;
  onRestore: (id: number) => void;
  onDelete: (id: number) => void;
  onChunkInfo: (card: Card) => void;
  editingId: number | null;
  editFrontHtml: string;
  setEditFrontHtml: (v: string) => void;
  editTags: string;
  setEditTags: (v: string) => void;
  onSave: (id: number) => void;
  onCancel: () => void;
  regenLoading: boolean;
  onRegen: (id: number, prompt: string) => void;
  selected: boolean;
  onToggleSelect: (id: number) => void;
}

function CardTile({
  card,
  cardIndex,
  onEdit,
  onReject,
  onRestore,
  onDelete,
  onChunkInfo,
  editingId,
  editFrontHtml,
  setEditFrontHtml,
  editTags,
  setEditTags,
  onSave,
  onCancel,
  regenLoading,
  onRegen,
  selected,
  onToggleSelect,
}: CardTileProps) {
  const isEditing = editingId === card.id;
  const isRejected = card.status === 'rejected';

  type PopoverKind = 'tags' | 'actions' | 'regen';
  const [popover, setPopover] = useState<{ kind: PopoverKind; x: number; y: number } | null>(null);
  const [regenPrompt, setRegenPrompt] = useState('');

  function openPopover(kind: PopoverKind, e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopover(prev => prev?.kind === kind ? null : { kind, x: rect.left, y: rect.bottom + 4 });
    if (kind === 'regen') setRegenPrompt('');
  }

  function closePopover() { setPopover(null); }

  return (
    <div
      className={`relative bg-white rounded-xl border transition-all duration-200 flex flex-col ${
        selected ? 'border-blue-400 shadow-md ring-1 ring-blue-300' : 'border-gray-200 shadow-md hover:shadow-lg'
      }${isRejected ? ' opacity-60 bg-gray-50' : ''}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(card.id)}
        className="absolute top-3 left-3 z-10 rounded border-gray-300 text-blue-700 focus:ring-blue-500"
      />

      <div className="pt-3 pl-8 pr-5 pb-4 flex-1" style={{ minHeight: '100px' }}>
        {isEditing ? (
          <div className="flex flex-col gap-2.5">
            <textarea
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-y min-h-[80px] focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
              value={editFrontHtml}
              onChange={(e) => setEditFrontHtml(e.target.value)}
            />
            <input
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder="tag1, tag2"
            />
            <div className="flex items-center gap-1.5">
              <button onClick={() => onSave(card.id)} className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150">Save</button>
              <button onClick={onCancel} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="text-sm leading-relaxed text-gray-800" dangerouslySetInnerHTML={{ __html: renderClozeHtml(card.front_html) }} />
        )}
      </div>

      <div className="border-t border-gray-100 px-3 py-2 bg-gray-50/30 rounded-b-xl flex items-center gap-1.5">
        <div className="flex flex-col items-center shrink-0 gap-0.5">
          <span className={`text-xs tabular-nums ${!card.is_reviewed ? 'font-bold text-gray-900' : 'font-normal text-gray-400'}`}>#{cardIndex}</span>
          <button onClick={() => onChunkInfo(card)} title="View source chunk" className="text-gray-300 hover:text-blue-500 transition-colors duration-150">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
          {card.tags.length === 0 ? (
            <span className="text-gray-300 text-xs">—</span>
          ) : (
            <button
              onClick={(e) => openPopover('tags', e)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border transition-colors duration-150 ${
                popover?.kind === 'tags' ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100 hover:border-blue-300'
              }`}
            >
              <span className="truncate max-w-[80px]">{card.tags[0]}</span>
              {card.tags.length > 1 && <span className="bg-blue-200 text-blue-700 rounded px-1 text-[10px] font-semibold">+{card.tags.length - 1}</span>}
            </button>
          )}
        </div>

        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${isRejected ? 'bg-red-400' : card.is_reviewed ? 'bg-gray-300' : 'bg-amber-400'}`}
          title={isRejected ? 'Rejected' : card.is_reviewed ? 'Reviewed' : 'Not reviewed'}
        />

        <button
          onClick={(e) => openPopover('actions', e)}
          className={`p-1 rounded-lg transition-colors duration-150 ${popover?.kind === 'actions' ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'}`}
          title="Actions"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
          </svg>
        </button>
      </div>

      {popover && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={closePopover} />
          {popover.kind === 'tags' && (
            <div className="fixed z-50 bg-white border border-gray-200 rounded-xl shadow-xl p-2.5 min-w-[160px] max-w-[240px]"
                 style={{ top: popover.y, left: popover.x }}>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5 px-1">Tags</p>
              <div className="flex flex-wrap gap-1">
                {card.tags.map(tag => (
                  <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium">{tag}</span>
                ))}
              </div>
            </div>
          )}
          {popover.kind === 'actions' && (
            <div className="fixed z-50 bg-white border border-gray-200 rounded-xl shadow-xl py-1 min-w-[160px]"
                 style={{ top: popover.y, left: Math.max(8, popover.x - 120) }}>
              <button onClick={() => { closePopover(); onEdit(card); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 transition-colors duration-150">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" /></svg>
                Edit
              </button>
              <button onClick={(e) => { openPopover('regen', e); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 transition-colors duration-150">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                Regenerate
              </button>
              {isRejected ? (
                <button onClick={() => { closePopover(); onRestore(card.id); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-green-700 hover:bg-green-50 transition-colors duration-150">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 11l3 3L22 4M3 12a9 9 0 1018 0 9 9 0 00-18 0z" /></svg>
                  Restore
                </button>
              ) : (
                <button onClick={() => { closePopover(); onReject(card.id); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-red-600 hover:bg-red-50 transition-colors duration-150">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  Reject
                </button>
              )}
              <div className="my-1 border-t border-gray-100" />
              <button onClick={() => { closePopover(); onDelete(card.id); }} className="flex items-center gap-2 w-full px-3 py-2 text-xs text-red-700 hover:bg-red-50 transition-colors duration-150">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" /></svg>
                Delete
              </button>
            </div>
          )}
          {popover.kind === 'regen' && (
            <div className="fixed z-50 bg-white border border-amber-200 rounded-xl shadow-xl p-3 w-52"
                 style={{ top: popover.y, left: Math.max(8, popover.x - 180) }}>
              <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide mb-2">Regenerate card</p>
              <input
                className="w-full text-xs border border-amber-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-amber-50/40 mb-2"
                placeholder="Optional guidance..."
                value={regenPrompt}
                onChange={(e) => setRegenPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { closePopover(); onRegen(card.id, regenPrompt); } if (e.key === 'Escape') closePopover(); }}
                autoFocus
              />
              <div className="flex gap-1.5">
                <button
                  onClick={() => { closePopover(); onRegen(card.id, regenPrompt); }}
                  disabled={regenLoading}
                  className="flex-1 px-2.5 py-1.5 text-xs font-medium text-white bg-amber-500 rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors duration-150"
                >
                  {regenLoading ? 'Working...' : 'Regenerate'}
                </button>
                <button onClick={closePopover} className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-50">Cancel</button>
              </div>
            </div>
          )}
        </>,
        document.body
      )}
    </div>
  );
}

// ── Tags cell with pill edit UI ───────────────────────────────────────────────
interface TagsCellProps {
  tags: string[];
  cellId: string;
  onSelect: (cellId: string) => void;
  onSave: (tags: string[]) => void;
  onNavigate: (dir: 'up' | 'down' | 'left' | 'right') => void;
}

function TagsCell({ tags, cellId, onSelect, onSave, onNavigate }: TagsCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localTags, setLocalTags] = useState<string[]>(tags);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingVal, setEditingVal] = useState('');
  const [addingNew, setAddingNew] = useState(false);
  const [newTagVal, setNewTagVal] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!isEditing) setLocalTags(tags); }, [tags, isEditing]);

  function startEditing() {
    setLocalTags([...tags]);
    setIsEditing(true);
    requestAnimationFrame(() => containerRef.current?.focus());
  }

  function doSave(final: string[]) {
    setIsEditing(false); setEditingIdx(null); setAddingNew(false);
    setEditingVal(''); setNewTagVal('');
    if (JSON.stringify(final) !== JSON.stringify(tags)) onSave(final);
  }

  function handleContainerBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    let final = [...localTags];
    if (editingIdx !== null) {
      const t = editingVal.trim();
      final = t ? final.map((v, i) => i === editingIdx ? t : v) : final.filter((_, i) => i !== editingIdx);
    }
    if (addingNew && newTagVal.trim()) final = [...final, newTagVal.trim()];
    doSave(final);
  }

  function commitTagEdit(idx: number, val: string) {
    const t = val.trim();
    setLocalTags(t ? localTags.map((v, i) => i === idx ? t : v) : localTags.filter((_, i) => i !== idx));
    setEditingIdx(null); setEditingVal('');
  }

  function commitNewTag(val: string) {
    if (val.trim()) setLocalTags(prev => [...prev, val.trim()]);
    setAddingNew(false); setNewTagVal('');
  }

  if (!isEditing) {
    return (
      <div
        ref={displayRef}
        data-cell-id={cellId}
        tabIndex={0}
        onClick={() => onSelect(cellId)}
        onDoubleClick={startEditing}
        onFocus={() => onSelect(cellId)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up'); }
          if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down'); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); onNavigate('left'); }
          if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('right'); }
          if (e.key === 'Enter') { e.preventDefault(); startEditing(); }
        }}
        className="cursor-default outline-none w-full h-full"
        style={{ minHeight: '2rem' }}
      >
        {tags.length === 0
          ? <span className="text-gray-300 text-xs">—</span>
          : <div className="flex flex-wrap gap-1">
              {tags.map(tag => (
                <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium">{tag}</span>
              ))}
            </div>
        }
      </div>
    );
  }

  return (
    <div ref={containerRef} tabIndex={0} className="w-full outline-none" style={{ minHeight: '2rem' }} onBlur={handleContainerBlur}>
      <div className="flex flex-wrap gap-1 items-center">
        {localTags.map((tag, idx) =>
          editingIdx === idx ? (
            <input
              key={idx}
              autoFocus
              value={editingVal}
              onChange={(e) => setEditingVal(e.target.value)}
              onBlur={(e) => {
                if (containerRef.current?.contains(e.relatedTarget as Node | null)) commitTagEdit(idx, editingVal);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitTagEdit(idx, editingVal); }
                if (e.key === 'Escape') { setEditingIdx(null); setEditingVal(''); }
                if (e.key === 'Tab') { e.preventDefault(); commitTagEdit(idx, editingVal); setAddingNew(true); }
              }}
              className="px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-400 outline-none font-medium"
              style={{ width: Math.max(60, editingVal.length * 7 + 20) + 'px' }}
            />
          ) : (
            <span key={idx} className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium group/tag">
              <span>{tag}</span>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setEditingIdx(idx); setEditingVal(tag); }}
                className="ml-0.5 text-blue-400 hover:text-blue-600 opacity-40 group-hover/tag:opacity-100 transition-opacity"
                tabIndex={-1}
                title="Edit tag"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
                </svg>
              </button>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setLocalTags(prev => prev.filter((_, i) => i !== idx)); }}
                className="ml-0 text-blue-400 hover:text-red-500 opacity-40 group-hover/tag:opacity-100 transition-opacity"
                tabIndex={-1}
                title="Remove tag"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          )
        )}
        {addingNew ? (
          <input
            autoFocus
            value={newTagVal}
            onChange={(e) => setNewTagVal(e.target.value)}
            onBlur={(e) => {
              if (containerRef.current?.contains(e.relatedTarget as Node | null)) commitNewTag(newTagVal);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitNewTag(newTagVal); }
              if (e.key === 'Escape') { setAddingNew(false); setNewTagVal(''); }
            }}
            placeholder="new tag..."
            className="px-2 py-0.5 rounded text-[11px] bg-white text-gray-700 border border-gray-300 outline-none"
            style={{ width: '80px' }}
          />
        ) : (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); setAddingNew(true); }}
            className="inline-flex items-center justify-center h-5 px-1.5 rounded text-[11px] text-gray-400 border border-dashed border-gray-300 hover:text-blue-500 hover:border-blue-400 transition-colors"
            tabIndex={-1}
            title="Add tag"
          >
            +
          </button>
        )}
      </div>
    </div>
  );
}

// ── Column definitions for visibility toggle ───────────────────────────────────
const OPTIONAL_COLUMNS = [
  { id: 'extra', label: 'Extra / Additional Context' },
  { id: 'ref_img', label: 'Ref Image' },
  { id: 'vignette', label: 'Vignette' },
  { id: 'teaching_case', label: 'Teaching Case' },
] as const;

const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  extra: false,
  ref_img: false,
  vignette: false,
  teaching_case: false,
};

export default function CardsPanel({
  documentId,
  chunkId,
  topicPath,
  refreshKey,
  refreshUsage,
  onReviewChange,
  onGoToChunk,
}: CardsPanelProps) {
  const { selectedModel, selectedRuleSetId, vignetteModel, vignetteRuleSetId } = useSettings();

  // ── Generation controls state ──────────────────────────────────────────────
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [jobRunning, setJobRunning] = useState(false);
  const [jobProgress, setJobProgress] = useState<{ processed: number; total: number } | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobAlertError, setJobAlertError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const documentIdRef = useRef(documentId);
  useEffect(() => { documentIdRef.current = documentId; }, [documentId]);

  // ── Card list state ────────────────────────────────────────────────────────
  const [cards, setCards] = useState<Card[]>([]);
  const [cardsLoading, setCardsLoading] = useState(false);
  const allDocCardsRef = useRef<{ docId: number; cards: Card[] } | null>(null);

  // Invalidate the document cache when cards are mutated so the next chunk switch refetches
  const invalidateDocCache = useCallback(() => {
    allDocCardsRef.current = null;
  }, []);
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [statusFilter, setStatusFilter] = useState<'all' | CardStatus>('all');
  const [searchQ, setSearchQ] = useState('');

  // ── Tile-view inline editing state ────────────────────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFrontHtml, setEditFrontHtml] = useState('');
  const [editTags, setEditTags] = useState('');

  // ── Table-view selection: DOM-only, no React state (avoids full re-render) ─
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const selectedTdRef = useRef<HTMLElement | null>(null);

  // ── Row heights for resizable rows ────────────────────────────────────────
  const [rowHeights, setRowHeights] = useState<Record<number, number>>({});

  // ── Per-card regenerate state ─────────────────────────────────────────────
  const [regenId, setRegenId] = useState<number | null>(null);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);

  // ── Delete confirmation ───────────────────────────────────────────────────
  const [confirmDeleteCardId, setConfirmDeleteCardId] = useState<number | null>(null);

  // ── Chunk info modal ──────────────────────────────────────────────────────
  const [chunkInfoCard, setChunkInfoCard] = useState<Card | null>(null);

  // ── Action error state ────────────────────────────────────────────────────
  const [actionError, setActionError] = useState<string | null>(null);

  // ── View mode state ────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');

  // ── Ankify modal ───────────────────────────────────────────────────────────
  const [ankifyOpen, setAnkifyOpen] = useState(false);

  // ── Generate confirm modal ─────────────────────────────────────────────────
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false);

  // ── Supplemental generation (vignettes / teaching cases) ──────────────────
  const [supplementalJobId, setSupplementalJobId] = useState<number | null>(null);
  const [supplementalPending, setSupplementalPending] = useState<{
    replaceExisting: boolean;
    cardIds: number[];
    estimate: SupplementalEstimate | null;
  } | null>(null);
  const [supplementalEstimating, setSupplementalEstimating] = useState(false);

  // ── Anki/plain toggle ─────────────────────────────────────────────────────
  const [showAnkiFormat, setShowAnkiFormat] = useState(false);

  // ── Column sizing (persisted) ─────────────────────────────────────────────
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    try {
      const stored = localStorage.getItem('cards_column_sizing');
      const parsed = stored ? JSON.parse(stored) : {};
      // select column has fixed size — never let a stale stored value override it
      delete parsed['select'];
      return parsed;
    } catch { return {}; }
  });

  // ── Column visibility (persisted) ─────────────────────────────────────────
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    try {
      const stored = localStorage.getItem('cards_column_visibility');
      return stored ? JSON.parse(stored) : DEFAULT_COLUMN_VISIBILITY;
    } catch { return DEFAULT_COLUMN_VISIBILITY; }
  });

  const [colVisPopover, setColVisPopover] = useState(false);

  // ── Fetch cards ────────────────────────────────────────────────────────────
  const fetchCards = useCallback(
    async (docId: number | null, topicPathFilter?: string | null, chunk?: number | null, silent?: boolean) => {
      if (!silent) setCardsLoading(true);
      try {
        let rawCards: Card[];
        if (docId != null) {
          // If we already have all cards for this document, filter client-side
          if (chunk != null && allDocCardsRef.current?.docId === docId && allDocCardsRef.current.cards.length > 0) {
            rawCards = allDocCardsRef.current.cards.filter(c => c.chunk_id === chunk);
            setCards(rawCards);
            if (!silent) setCardsLoading(false);
            return;
          }
          rawCards = await getCards({ document_id: docId });
          // Cache the full doc set
          allDocCardsRef.current = { docId, cards: rawCards };
          if (chunk != null) {
            rawCards = rawCards.filter(c => c.chunk_id === chunk);
          }
        } else if (topicPathFilter) {
          rawCards = await getCards();
          rawCards = rawCards.filter(c => c.topic_path && c.topic_path.startsWith(topicPathFilter));
        } else {
          rawCards = [];
        }
        setCards(rawCards);
      } catch {
        // silently fail
      } finally {
        if (!silent) setCardsLoading(false);
      }
    },
    []
  );

  // ── Reset state when props change ─────────────────────────────────────────
  const prevDocIdRef = useRef(documentId);
  useEffect(() => {
    const docChanged = documentId !== prevDocIdRef.current;
    prevDocIdRef.current = documentId;

    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setEstimate(null);
    setEstimateError(null);
    setJobRunning(false);
    setJobProgress(null);
    setJobError(null);
    setEditingId(null);
    if (selectedTdRef.current) { selectedTdRef.current.style.boxShadow = ''; selectedTdRef.current = null; }
    setSelectedIds(new Set());
    setActionError(null);

    if (docChanged || !documentId) {
      // Full reset when switching documents or going to topic view
      setCards([]);
      setUnreviewedOnly(false);
      setStatusFilter('all');
      setSearchQ('');
      setViewMode('table');
      if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
      else if (topicPath) fetchCards(null, topicPath);
    } else {
      // Same document, chunk changed — filter client-side if cached
      fetchCards(documentId, null, chunkId ?? null);
    }
  }, [documentId, chunkId, topicPath, fetchCards]);

  // ── Re-fetch on external refresh trigger ──────────────────────────────────
  useEffect(() => {
    if (!refreshKey) return;
    if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
    else if (topicPath) fetchCards(null, topicPath);
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clean up interval on unmount ──────────────────────────────────────────
  useEffect(() => { return () => { if (intervalRef.current) clearInterval(intervalRef.current); }; }, []);

  // ── Clear DOM selection on page change (td refs become stale) ─────────────
  useEffect(() => { selectedTdRef.current = null; }, [pagination.pageIndex]);

  // ── Estimate cost ──────────────────────────────────────────────────────────
  async function handleEstimate() {
    if (documentId == null || !selectedModel) return;
    setEstimating(true);
    setEstimateError(null);
    try {
      const rules = await getRuleSets();
      const ruleId =
        rules.find(r => r.id === selectedRuleSetId)?.id ??
        rules.find(r => r.is_default)?.id ??
        rules[0]?.id;
      if (!ruleId) { setEstimateError('No rule set available'); setEstimating(false); return; }
      const result = await estimateCost({ document_id: documentId, rule_set_id: ruleId, model: selectedModel });
      setEstimate(result);
    } catch (err) {
      setEstimateError(err instanceof Error ? err.message : 'Estimate failed');
      setEstimate(null);
    } finally { setEstimating(false); }
  }

  // ── Start generation ───────────────────────────────────────────────────────
  async function handleGenerate() {
    if (documentId == null || !selectedModel) return;
    setEstimate(null); setJobError(null); setJobRunning(true); setJobProgress(null);
    try {
      const rules = await getRuleSets();
      const ruleId =
        rules.find(r => r.id === selectedRuleSetId)?.id ??
        rules.find(r => r.is_default)?.id ??
        rules[0]?.id;
      if (!ruleId) { setJobRunning(false); setJobError('No rule set available'); return; }
      const resp = await startGeneration({ document_id: documentId, rule_set_id: ruleId, model: selectedModel });
      const jobId = resp.job_id;
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(jobId);
          setJobProgress({ processed: job.processed_chunks, total: job.total_chunks });
          if (job.status === 'done') {
            clearInterval(intervalRef.current!); intervalRef.current = null;
            setJobRunning(false);
            invalidateDocCache();
            fetchCards(documentIdRef.current!, null, null, true);
            refreshUsage?.();
          } else if (job.status === 'failed') {
            clearInterval(intervalRef.current!); intervalRef.current = null;
            setJobRunning(false);
            const errMsg = job.error_message ?? 'Generation failed';
            setJobError(errMsg); setJobAlertError(errMsg);
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (err) {
      setJobRunning(false);
      setJobError(err instanceof Error ? err.message : 'Failed to start generation');
    }
  }

  // ── Card action handlers ───────────────────────────────────────────────────
  const handleReject = useCallback(async (id: number) => {
    setActionError(null);
    try {
      const updated = await rejectCard(id);
      setCards(prev => prev.map(c => c.id === id ? { ...c, ...updated } : c));
      invalidateDocCache();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to reject card'); }
  }, [invalidateDocCache]);

  const handleRestore = useCallback(async (id: number) => {
    setActionError(null);
    try {
      const updated = await updateCard(id, { status: 'active' });
      setCards(prev => prev.map(c => c.id === id ? { ...c, ...updated } : c));
      invalidateDocCache();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to restore card'); }
  }, [invalidateDocCache]);

  const handleDelete = useCallback(async (id: number) => {
    setActionError(null);
    try {
      await deleteCard(id);
      setCards(prev => prev.filter(c => c.id !== id));
      invalidateDocCache();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to delete card'); }
  }, [invalidateDocCache]);

  // ── Tile-view edit handlers ────────────────────────────────────────────────
  const startEdit = useCallback((card: Card) => {
    setEditingId(card.id);
    setEditFrontHtml(card.front_html);
    setEditTags(card.tags.join(', '));
  }, []);

  const cancelEdit = useCallback(() => { setEditingId(null); }, []);

  const saveEdit = useCallback(async (id: number) => {
    setActionError(null);
    try {
      await updateCard(id, {
        front_html: editFrontHtml,
        tags: editTags.split(',').map(t => t.trim()).filter(Boolean),
      });
      setEditingId(null);
      if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
      else if (topicPath) fetchCards(null, topicPath);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save card'); }
  }, [documentId, chunkId, topicPath, editFrontHtml, editTags, fetchCards]);

  // ── Table-view inline save handlers — update local state, no refetch ────────
  const saveFrontInline = useCallback(async (id: number, val: string) => {
    setActionError(null);
    try {
      const updated = await updateCard(id, { front_html: val });
      setCards(prev => prev.map(c => c.id === id ? { ...c, front_html: updated.front_html, front_text: updated.front_text } : c));
      invalidateDocCache();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save'); }
  }, [invalidateDocCache]);

  const saveTagsInline = useCallback(async (id: number, tags: string[]) => {
    setActionError(null);
    try {
      const updated = await updateCard(id, { tags });
      setCards(prev => prev.map(c => c.id === id ? { ...c, tags: updated.tags } : c));
      invalidateDocCache();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save tags'); }
  }, [invalidateDocCache]);

  const saveFieldInline = useCallback(async (id: number, field: 'extra' | 'vignette' | 'teaching_case', val: string) => {
    setActionError(null);
    try {
      const updated = await updateCard(id, { [field]: val });
      setCards(prev => prev.map(c => c.id === id ? { ...c, [field]: updated[field as keyof typeof updated] } : c));
      invalidateDocCache();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save'); }
  }, [invalidateDocCache]);

  // ── Cell selection: apply box-shadow to <td> directly, no React state ────
  const handleCellSelect = useCallback((cellId: string) => {
    if (selectedTdRef.current) {
      selectedTdRef.current.style.boxShadow = '';
      selectedTdRef.current.style.position = '';
    }
    const [rowIdx, colId] = cellId.split(':');
    const td = tableContainerRef.current?.querySelector(
      `td[data-row="${rowIdx}"][data-col="${colId}"]`
    ) as HTMLElement | null;
    if (td) {
      td.style.boxShadow = 'inset 0 0 0 2px #3b82f6';
      td.style.position = 'relative';
      selectedTdRef.current = td;
    }
  }, []);

  // ── Cell keyboard navigation ───────────────────────────────────────────────
  const handleCellNavigate = useCallback((rowIndex: number, colId: string, dir: 'up' | 'down' | 'left' | 'right', totalPageRows: number) => {
    const navigableCols = ['front_text', 'tags'];
    if (columnVisibility['extra'] !== false) navigableCols.push('extra');
    if (columnVisibility['vignette'] !== false) navigableCols.push('vignette');
    if (columnVisibility['teaching_case'] !== false) navigableCols.push('teaching_case');

    const colIdx = navigableCols.indexOf(colId);
    let newRow = rowIndex;
    let newCol = colId;

    if (dir === 'up') newRow = Math.max(0, rowIndex - 1);
    if (dir === 'down') newRow = Math.min(totalPageRows - 1, rowIndex + 1);
    if (dir === 'left') newCol = navigableCols[Math.max(0, colIdx - 1)];
    if (dir === 'right') newCol = navigableCols[Math.min(navigableCols.length - 1, colIdx + 1)];

    // Focus the target cell div — its onFocus will call handleCellSelect
    const target = tableContainerRef.current?.querySelector(
      `[data-cell-id="${newRow}:${newCol}"]`
    ) as HTMLElement | null;
    target?.focus({ preventScroll: false });
  }, [columnVisibility]);

  // ── Row resize drag handler ────────────────────────────────────────────────
  function handleRowResizeStart(e: React.MouseEvent, cardId: number, trEl: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = trEl.offsetHeight;
    const onMove = (mv: MouseEvent) => {
      const newH = Math.max(36, startH + (mv.clientY - startY));
      setRowHeights(prev => ({ ...prev, [cardId]: newH }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const handleRegen = useCallback(async (id: number, prompt?: string) => {
    setRegenLoading(true); setActionError(null);
    try {
      const updated = await regenerateCard(id, { model: selectedModel, prompt: (prompt ?? regenPrompt) || undefined });
      setRegenId(null); setRegenPrompt('');
      // Update the card in-place — no full reload, no flicker
      setCards(prev => prev.map(c => c.id === id ? { ...c, ...updated } : c));
      invalidateDocCache();
      refreshUsage?.();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Regeneration failed'); }
    finally { setRegenLoading(false); }
  }, [selectedModel, regenPrompt, invalidateDocCache]);

  const unreviewedSelectedIds = useMemo(
    () => cards.filter(c => selectedIds.has(c.id) && c.status === 'active' && !c.is_reviewed).map(c => c.id),
    [cards, selectedIds]
  );

  const handleBulkReview = useCallback(async () => {
    if (unreviewedSelectedIds.length === 0) return;
    try {
      await bulkMarkReviewed(unreviewedSelectedIds);
      setSelectedIds(new Set());
      setCards(prev => prev.map(c => unreviewedSelectedIds.includes(c.id) ? { ...c, is_reviewed: true } : c));
      invalidateDocCache();
      onReviewChange?.();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to mark as reviewed'); }
  }, [unreviewedSelectedIds, onReviewChange, invalidateDocCache]);

  const handleBulkDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} selected card${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    try {
      await bulkDeleteCards(ids);
      setSelectedIds(new Set());
      setCards(prev => prev.filter(c => !ids.includes(c.id)));
      invalidateDocCache();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to delete cards'); }
  }, [selectedIds]);

  // ── Supplemental job polling ──────────────────────────────────────────────
  useEffect(() => {
    if (!supplementalJobId) return;
    const interval = setInterval(async () => {
      try {
        const job = await getGenerationJob(supplementalJobId);
        if (job.status === 'done' || job.status === 'failed') {
          clearInterval(interval);
          setSupplementalJobId(null);
          invalidateDocCache();
          if (documentId != null) fetchCards(documentId, null, chunkId ?? null, true);
          else if (topicPath) fetchCards(null, topicPath, null, true);
          refreshUsage?.();
          if (job.status === 'failed') {
            setJobAlertError(job.error_message ?? 'Supplemental generation failed');
          }
        }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [supplementalJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Supplemental generation handlers ─────────────────────────────────────
  async function handleSupplementalClick(
    replaceExisting: boolean,
    cardIds: number[]
  ) {
    if (cardIds.length === 0) return;
    setSupplementalEstimating(true);
    try {
      const est = await estimateSupplemental({ card_ids: cardIds, model: vignetteModel });
      setSupplementalPending({ replaceExisting, cardIds, estimate: est });
    } catch {
      setSupplementalPending({ replaceExisting, cardIds, estimate: null });
    } finally {
      setSupplementalEstimating(false);
    }
  }

  async function handleSupplementalConfirm() {
    if (!supplementalPending) return;
    const { replaceExisting, cardIds } = supplementalPending;
    setSupplementalPending(null);

    // Resolve rule set id — try vignette rules first, fall back to any supplemental default
    let ruleId = vignetteRuleSetId;
    if (ruleId == null) {
      try {
        const rules = await getRuleSets('vignette');
        ruleId = rules.find(r => r.is_default)?.id ?? rules[0]?.id ?? null;
      } catch { /* leave null */ }
    }
    if (ruleId == null) {
      setActionError('No vignette rule set configured. Please set one in Settings or Library > Rules.');
      return;
    }

    try {
      const resp = await startSupplemental({ card_ids: cardIds, rule_set_id: ruleId, model: vignetteModel, replace_existing: replaceExisting });
      setSupplementalJobId(resp.job_id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start generation');
    }
  }

  // ── Filtered cards ─────────────────────────────────────────────────────────
  const filteredCards = useMemo(
    () => cards.filter(c => {
      if (unreviewedOnly && c.is_reviewed) return false;
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (searchQ.trim() && !c.front_text.toLowerCase().includes(searchQ.toLowerCase()) && !c.tags.some(t => t.toLowerCase().includes(searchQ.toLowerCase()))) return false;
      return true;
    }),
    [cards, unreviewedOnly, statusFilter, searchQ]
  );

  // ── Column visibility toggle handler ──────────────────────────────────────
  function toggleColumn(colId: string, visible: boolean) {
    const next = { ...columnVisibility, [colId]: visible };
    setColumnVisibility(next);
    localStorage.setItem('cards_column_visibility', JSON.stringify(next));
  }

  // ── TanStack Table columns ─────────────────────────────────────────────────
  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        size: 88,
        minSize: 88,
        maxSize: 88,
        enableResizing: false,
        enableHiding: false,
        header: (ctx) => {
          const pageRows = ctx.table.getRowModel().rows;
          const pageIds = pageRows.map(r => r.original.id);
          const allSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));
          const someSelected = !allSelected && pageIds.some(id => selectedIds.has(id));
          return (
            <input
              type="checkbox"
              checked={allSelected}
              ref={el => { if (el) el.indeterminate = someSelected; }}
              onChange={() => {
                if (allSelected) setSelectedIds(prev => { const n = new Set(prev); pageIds.forEach(id => n.delete(id)); return n; });
                else setSelectedIds(prev => new Set([...prev, ...pageIds]));
              }}
              className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
            />
          );
        },
        cell: (info) => {
          const id = info.row.original.id;
          const card = info.row.original;
          const rowIndex = info.row.index;
          return (
            <div className="flex flex-col items-center justify-between h-full py-1">
              <input
                type="checkbox"
                checked={selectedIds.has(id)}
                onChange={() => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
                className="w-4 h-4 rounded border-gray-300 text-blue-700 focus:ring-blue-500"
              />
              <div className="grid grid-cols-2 gap-0.5 mt-9">
                <button
                  onClick={() => {
                    const div = tableContainerRef.current?.querySelector(
                      `[data-cell-id="${rowIndex}:front_text"]`
                    ) as HTMLElement | null;
                    div?.focus();
                    requestAnimationFrame(() => div?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
                  }}
                  title="Edit"
                  className="p-1 text-gray-400 hover:text-blue-700 transition-colors duration-150 rounded hover:bg-blue-50"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
                  </svg>
                </button>
                {card.status === 'rejected' ? (
                  <button onClick={() => handleRestore(card.id)} title="Restore" className="p-1 text-green-500 hover:text-green-700 transition-colors duration-150 rounded hover:bg-green-50">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 11l3 3L22 4M3 12a9 9 0 1018 0 9 9 0 00-18 0z" />
                    </svg>
                  </button>
                ) : (
                  <button onClick={() => handleReject(card.id)} title="Reject" className="p-1 text-gray-400 hover:text-red-500 transition-colors duration-150 rounded hover:bg-red-50">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
                <button onClick={() => setConfirmDeleteCardId(card.id)} title="Delete permanently" className="p-1 text-gray-400 hover:text-red-700 transition-colors duration-150 rounded hover:bg-red-50">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
                  </svg>
                </button>
              <div className="relative">
                <button
                  onClick={() => { setRegenId(regenId === card.id ? null : card.id); setRegenPrompt(''); }}
                  title="Regenerate"
                  className={`p-1 transition-colors duration-150 rounded ${regenId === card.id ? 'text-amber-600 bg-amber-50' : 'text-gray-400 hover:text-amber-500 hover:bg-amber-50'}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
                {regenId === card.id && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setRegenId(null)} />
                    <div className="absolute left-full ml-1 top-0 z-20 bg-white border border-amber-200 rounded-xl shadow-xl p-3 w-52">
                      <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide mb-2">Regenerate card</p>
                      <input
                        className="w-full text-xs border border-amber-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-amber-50/40 transition-colors duration-150 mb-2"
                        placeholder="Optional guidance..."
                        value={regenPrompt}
                        onChange={(e) => setRegenPrompt(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleRegen(card.id); if (e.key === 'Escape') setRegenId(null); }}
                        autoFocus
                      />
                      <div className="flex gap-1.5">
                        <button onClick={() => handleRegen(card.id)} disabled={regenLoading} className="flex-1 px-2.5 py-1.5 text-xs font-medium text-white bg-amber-500 rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors duration-150">
                          {regenLoading ? 'Working...' : 'Regenerate'}
                        </button>
                        <button onClick={() => setRegenId(null)} className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-50 transition-colors duration-150">Cancel</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('card_number', {
        header: '#',
        size: 38,
        enableHiding: false,
        cell: (info) => {
          const card = info.row.original;
          const dotColor = card.status === 'rejected' ? 'bg-red-400' : card.is_reviewed ? 'bg-gray-300' : 'bg-amber-400';
          return (
            <div className="flex flex-col items-center gap-0.5">
              <span className={`text-xs tabular-nums ${!card.is_reviewed ? 'font-bold text-gray-900' : 'font-normal text-gray-400'}`}>{info.getValue()}</span>
              <span className={`w-2 h-2 rounded-full ${dotColor}`} />
              <button onClick={(e) => { e.stopPropagation(); setChunkInfoCard(card); }} title="View source chunk" className="text-gray-300 hover:text-blue-500 transition-colors duration-150 p-0.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            </div>
          );
        },
      }),
      columnHelper.accessor('front_text', {
        header: 'Front',
        size: 500,
        minSize: 200,
        enableHiding: false,
        cell: (info) => {
          const card = info.row.original;
          const rowIndex = info.row.index;
          const totalPageRows = info.table.getRowModel().rows.length;
          return (
            <EditableCell
              value={card.front_html}
              cellId={`${rowIndex}:front_text`}
              onSelect={handleCellSelect}
              onSave={(val) => saveFrontInline(card.id, val)}
              onNavigate={(dir) => handleCellNavigate(rowIndex, 'front_text', dir, totalPageRows)}
              multiline
              renderDisplay={(val) =>
                showAnkiFormat
                  ? <span className="block text-sm text-gray-800 whitespace-normal break-words leading-relaxed" dangerouslySetInnerHTML={{ __html: renderClozeHtml(val) }} />
                  : <span className="block text-sm text-gray-800 whitespace-normal break-words leading-relaxed">{stripHtmlKeepCloze(val)}</span>
              }
            />
          );
        },
      }),
      columnHelper.accessor('tags', {
        header: 'Tags',
        size: 200,
        cell: (info) => {
          const card = info.row.original;
          const rowIndex = info.row.index;
          const totalPageRows = info.table.getRowModel().rows.length;
          return (
            <TagsCell
              tags={card.tags}
              cellId={`${rowIndex}:tags`}
              onSelect={handleCellSelect}
              onSave={(t) => saveTagsInline(card.id, t)}
              onNavigate={(dir) => handleCellNavigate(rowIndex, 'tags', dir, totalPageRows)}
            />
          );
        },
      }),
      columnHelper.display({
        id: 'ref_img',
        header: 'Ref Image',
        size: 200,
        cell: ({ row }) => {
          const card = row.original;

          async function applyImage(dataUri: string) {
            try {
              const updated = await updateCard(card.id, { ref_img: dataUri });
              setCards(prev => prev.map(c => c.id === card.id ? { ...c, ref_img: updated.ref_img } : c));
              invalidateDocCache();
            } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save image'); }
          }

          function handleFile(file: File) {
            if (!file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = (e) => { if (e.target?.result) applyImage(e.target.result as string); };
            reader.readAsDataURL(file);
          }

          async function handlePaste() {
            try {
              const items = await navigator.clipboard.read();
              for (const item of items) {
                const imageType = item.types.find(t => t.startsWith('image/'));
                if (imageType) {
                  const blob = await item.getType(imageType);
                  const reader = new FileReader();
                  reader.onload = (e) => { if (e.target?.result) applyImage(e.target.result as string); };
                  reader.readAsDataURL(blob);
                  return;
                }
              }
            } catch { setActionError('Paste failed — try using the upload button instead'); }
          }

          return (
            <div className="flex flex-col items-center gap-1.5">
              {card.ref_img ? (
                <>
                  <img src={card.ref_img} alt="Reference" className="max-h-24 max-w-full rounded" />
                  <div className="flex gap-1 flex-wrap justify-center">
                    <button
                      className={`text-xs px-2 py-0.5 rounded ${card.ref_img_position === 'front' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}
                      onClick={async () => {
                        try {
                          const updated = await updateCard(card.id, { ref_img_position: 'front' });
                          setCards(prev => prev.map(c => c.id === card.id ? { ...c, ref_img_position: updated.ref_img_position } : c));
                          invalidateDocCache();
                        } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save'); }
                      }}
                    >Front</button>
                    <button
                      className={`text-xs px-2 py-0.5 rounded ${card.ref_img_position === 'back' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}
                      onClick={async () => {
                        try {
                          const updated = await updateCard(card.id, { ref_img_position: 'back' });
                          setCards(prev => prev.map(c => c.id === card.id ? { ...c, ref_img_position: updated.ref_img_position } : c));
                          invalidateDocCache();
                        } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save'); }
                      }}
                    >Back</button>
                    <button
                      className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100"
                      onClick={async () => {
                        try {
                          await updateCard(card.id, { ref_img: '' });
                          setCards(prev => prev.map(c => c.id === card.id ? { ...c, ref_img: null } : c));
                          invalidateDocCache();
                        } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to remove image'); }
                      }}
                    >Remove</button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-1">
                  <label className="cursor-pointer text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
                    Upload
                    <input type="file" accept="image/*" className="hidden" onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); e.target.value = ''; }} />
                  </label>
                  <button
                    onClick={handlePaste}
                    className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                  >Paste</button>
                </div>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor('extra', {
        id: 'extra',
        header: 'Extra',
        size: 300,
        minSize: 150,
        cell: (info) => {
          const card = info.row.original;
          const rowIndex = info.row.index;
          const totalPageRows = info.table.getRowModel().rows.length;
          return (
            <EditableCell
              value={card.extra ?? ''}
              cellId={`${rowIndex}:extra`}
              onSelect={handleCellSelect}
              onSave={(v) => saveFieldInline(card.id, 'extra', v)}
              onNavigate={(dir) => handleCellNavigate(rowIndex, 'extra', dir, totalPageRows)}
              multiline
              clampLines={4}
              renderDisplay={(v) =>
                v
                  ? <div className="text-sm text-gray-800 leading-relaxed whitespace-normal break-words" dangerouslySetInnerHTML={{ __html: v }} />
                  : <span className="text-gray-300 text-xs">—</span>
              }
            />
          );
        },
      }),
      columnHelper.accessor('vignette', {
        id: 'vignette',
        header: 'Vignette',
        size: 350,
        minSize: 150,
        cell: (info) => {
          const card = info.row.original;
          const rowIndex = info.row.index;
          const totalPageRows = info.table.getRowModel().rows.length;
          return (
            <EditableCell
              value={card.vignette ?? ''}
              cellId={`${rowIndex}:vignette`}
              onSelect={handleCellSelect}
              onSave={(v) => saveFieldInline(card.id, 'vignette', v)}
              onNavigate={(dir) => handleCellNavigate(rowIndex, 'vignette', dir, totalPageRows)}
              multiline
              clampLines={4}
              renderDisplay={(v) =>
                v
                  ? <div className="text-sm text-gray-800 leading-relaxed whitespace-normal break-words" dangerouslySetInnerHTML={{ __html: v }} />
                  : <span className="text-gray-300 text-xs">—</span>
              }
            />
          );
        },
      }),
      columnHelper.accessor('teaching_case', {
        id: 'teaching_case',
        header: 'Teaching Case',
        size: 400,
        minSize: 150,
        cell: (info) => {
          const card = info.row.original;
          const rowIndex = info.row.index;
          const totalPageRows = info.table.getRowModel().rows.length;
          return (
            <EditableCell
              value={card.teaching_case ?? ''}
              cellId={`${rowIndex}:teaching_case`}
              onSelect={handleCellSelect}
              onSave={(v) => saveFieldInline(card.id, 'teaching_case', v)}
              onNavigate={(dir) => handleCellNavigate(rowIndex, 'teaching_case', dir, totalPageRows)}
              multiline
              clampLines={4}
              renderDisplay={(v) =>
                v
                  ? <div className="text-sm text-gray-800 leading-relaxed whitespace-normal break-words" dangerouslySetInnerHTML={{ __html: v }} />
                  : <span className="text-gray-300 text-xs">—</span>
              }
            />
          );
        },
      }),
    ],
    [
      handleCellSelect,
      handleCellNavigate,
      saveFrontInline,
      saveTagsInline,
      saveFieldInline,
      handleReject,
      handleRestore,
      regenId,
      regenPrompt,
      regenLoading,
      handleRegen,
      showAnkiFormat,
      selectedIds,
      invalidateDocCache,
    ]
  );

  const table = useReactTable({
    data: filteredCards,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    autoResetPageIndex: true,
    state: { columnSizing, pagination, columnVisibility },
    onColumnSizingChange: (updater) => {
      setColumnSizing(prev => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        localStorage.setItem('cards_column_sizing', JSON.stringify(next));
        return next;
      });
    },
    onPaginationChange: setPagination,
    onColumnVisibilityChange: (updater) => {
      setColumnVisibility(prev => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        localStorage.setItem('cards_column_visibility', JSON.stringify(next));
        return next;
      });
    },
  });

  // ── Empty state ────────────────────────────────────────────────────────────
  if (documentId === null && !topicPath) {
    return (
      <main className="flex-1 overflow-hidden flex flex-col items-center justify-center gap-4 bg-gray-50/50">
        <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <p className="text-sm text-gray-500 font-medium">Select a topic or document to view cards</p>
      </main>
    );
  }

  const topicName = topicPath ? topicPath.split(' > ').at(-1) ?? topicPath : null;

  return (
    <>
      <main className="flex-1 overflow-hidden flex flex-col bg-white">
        {/* ── Generation Controls ── */}
        {documentId != null && (
          <div className="bg-white px-5 py-2.5 shrink-0 border-b border-gray-200">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={handleEstimate} disabled={jobRunning || estimating || !selectedModel} className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-600">
                {estimating ? 'Estimating...' : 'Estimate cost'}
              </button>
              <button onClick={() => setShowGenerateConfirm(true)} disabled={jobRunning || !selectedModel} className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-1">
                {jobRunning ? (
                  <>
                    <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Generating...
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Generate for whole Document
                  </>
                )}
              </button>
              {estimate && (
                <span className="inline-flex flex-col items-center px-3 py-1.5 rounded-full text-xs font-medium bg-green-50 text-green-700 leading-tight">
                  <span className="font-semibold">~${estimate.estimated_cost_usd.toFixed(3)}</span>
                  <span className="text-green-500 font-normal text-[10px]">{estimate.estimated_input_tokens.toLocaleString()} in / {estimate.estimated_output_tokens.toLocaleString()} out</span>
                </span>
              )}
              {estimateError && <span className="text-xs text-red-600">{estimateError}</span>}
              {jobRunning && jobProgress && <span className="text-xs text-gray-500 tabular-nums font-medium">{jobProgress.processed}/{jobProgress.total} chunks</span>}
              {jobError && <span className="text-xs text-red-600">{jobError}</span>}
            </div>
          </div>
        )}

        {/* ── Topic header ── */}
        {topicPath && (
          <div className="px-5 py-3 border-b border-gray-200 bg-blue-50/40 shrink-0">
            <p className="text-xs font-medium text-blue-700">Cards for: <span className="font-semibold">{topicName}</span></p>
            <p className="text-[10px] text-blue-500 mt-0.5 truncate">{topicPath}</p>
          </div>
        )}

        {/* ── Card grid toolbar ── */}
        <div className="flex flex-col border-b border-gray-200 shrink-0 bg-white">

          {/* Row 1: view controls + filters + export */}
          <div className="flex items-center justify-between gap-3 px-5 py-2.5 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              {/* View mode toggle */}
              <div className="flex items-center gap-0.5 rounded-lg bg-gray-100/80 p-0.5">
                <button onClick={() => setViewMode('table')} title="Table view" className={`p-1.5 rounded-md transition-colors duration-150 ${viewMode === 'table' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M10 4v16M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" />
                  </svg>
                </button>
                <button onClick={() => setViewMode('cards')} title="Card view" className={`p-1.5 rounded-md transition-colors duration-150 ${viewMode === 'cards' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" />
                    <rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" />
                  </svg>
                </button>
              </div>

              {/* Column visibility toggle — table view only */}
              {viewMode === 'table' && (
                <div className="relative">
                  <button
                    onClick={() => setColVisPopover(v => !v)}
                    className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors duration-150 ${colVisPopover ? 'bg-gray-100 text-gray-700 border-gray-300' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                    </svg>
                    Columns
                  </button>
                  {colVisPopover && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setColVisPopover(false)} />
                      <div className="absolute left-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-xl shadow-xl p-3 min-w-[190px]">
                        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2 px-1">Optional columns</p>
                        {OPTIONAL_COLUMNS.map(col => (
                          <label key={col.id} className="flex items-center gap-2 py-1 px-1 cursor-pointer hover:bg-gray-50 rounded-lg">
                            <input
                              type="checkbox"
                              checked={columnVisibility[col.id] !== false}
                              onChange={e => toggleColumn(col.id, e.target.checked)}
                              className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
                            />
                            <span className="text-xs text-gray-700">{col.label}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Anki format toggle */}
              {viewMode === 'table' && (
                <button
                  onClick={() => setShowAnkiFormat(v => !v)}
                  title={showAnkiFormat ? 'Switch to plain text' : 'Switch to Anki cloze view'}
                  className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors duration-150 ${showAnkiFormat ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                >
                  {showAnkiFormat ? 'Anki' : 'Text'}
                </button>
              )}

              {/* Unreviewed only */}
              <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none font-medium">
                <input type="checkbox" checked={unreviewedOnly} onChange={e => setUnreviewedOnly(e.target.checked)} className="rounded border-gray-300 text-blue-700 focus:ring-blue-500" />
                Unreviewed only
              </label>

              {/* Status filter */}
              <select className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-600 font-medium focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150" value={statusFilter} onChange={e => setStatusFilter(e.target.value as 'all' | CardStatus)}>
                <option value="all">All status</option>
                <option value="active">Active</option>
                <option value="rejected">Rejected</option>
              </select>

              {/* Search */}
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent w-44 transition-colors duration-150" placeholder="Search cards..." value={searchQ} onChange={e => setSearchQ(e.target.value)} />
                {searchQ && (
                  <button onClick={() => setSearchQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>

              <span className="text-xs text-gray-400 tabular-nums font-medium">{filteredCards.length} card{filteredCards.length !== 1 ? 's' : ''}</span>
            </div>

            {/* Export */}
            <button
              onClick={() => window.open(documentId != null ? exportCardsUrl({ document_id: documentId }) : exportCardsUrl())}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export
            </button>
          </div>

          {/* Row 2: selection actions — only shown when cards are selected */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 px-5 py-2 bg-blue-50/60 border-t border-blue-100 flex-wrap">
              <span className="text-[11px] font-semibold text-blue-600 mr-1">{selectedIds.size} selected</span>

              {/* Ankify */}
              <button onClick={() => setAnkifyOpen(true)} className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100 transition-colors duration-150" title="Review cards Anki-style">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Ankify
              </button>

              {/* Mark reviewed */}
              {unreviewedSelectedIds.length > 0 && (
                <button onClick={handleBulkReview} className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors duration-150">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Mark {unreviewedSelectedIds.length} reviewed
                </button>
              )}

              {/* Vignette + Teaching Case generation */}
              {(() => {
                const selCards = cards.filter(c => selectedIds.has(c.id));
                const needsGen = selCards.filter(c => !c.vignette || !c.teaching_case);
                const hasGen = selCards.filter(c => c.vignette && c.teaching_case);
                return (
                  <>
                    {needsGen.length > 0 && (
                      <button
                        disabled={supplementalEstimating || !!supplementalJobId}
                        onClick={() => handleSupplementalClick(false, needsGen.map(c => c.id))}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
                      >
                        Gen Vignettes &amp; Cases ({needsGen.length})
                      </button>
                    )}
                    {hasGen.length > 0 && (
                      <button
                        disabled={supplementalEstimating || !!supplementalJobId}
                        onClick={() => handleSupplementalClick(true, hasGen.map(c => c.id))}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
                      >
                        Regen Vignettes ({hasGen.length})
                      </button>
                    )}
                    {supplementalJobId && (
                      <span className="text-xs text-gray-500 font-medium animate-pulse">Generating...</span>
                    )}
                  </>
                );
              })()}

              {/* Discuss in Chat */}
              <button
                onClick={() => {
                  const selected = cards.filter(c => selectedIds.has(c.id));
                  const cardList = selected.map((c, i) => {
                    const tags = (c.tags || []).join(' > ') || 'no topic';
                    const lines = [
                      `Card ${i + 1}:`,
                      `  Front: ${c.front_html}`,
                      `  Topic: ${tags}`,
                    ];
                    if (c.extra) lines.push(`  Extra: ${c.extra}`);
                    if (c.vignette) lines.push(`  Vignette: ${c.vignette}`);
                    if (c.teaching_case) lines.push(`  Teaching case: ${c.teaching_case}`);
                    return lines.join('\n');
                  }).join('\n\n');
                  window.dispatchEvent(new CustomEvent('discuss-cards', {
                    detail: {
                      message: `Here are the cards I want to discuss:\n\n${cardList}\n\nPlease review them against the current rules and explain what's controlling how they were generated.`,
                      cards: selected.map((c, i) => ({ ...c, index: i + 1 })),
                    }
                  }));
                }}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors duration-150"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                Discuss in Chat
              </button>

              {/* Delete */}
              <button
                onClick={handleBulkDelete}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors duration-150"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
                </svg>
                Delete {selectedIds.size}
              </button>
            </div>
          )}
        </div>

        {/* Action error banner */}
        {actionError && <div className="px-5 py-2.5 text-xs text-red-600 bg-red-50 border-b border-red-100">{actionError}</div>}

        {/* Cards content */}
        {cardsLoading ? (
          <div className="flex items-center justify-center h-32 text-sm text-gray-400 flex-1">Loading cards...</div>
        ) : filteredCards.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 gap-3">
            <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <p className="text-sm text-gray-500 font-medium">
              {cards.length === 0 ? (topicPath ? 'No cards for this topic yet.' : 'No cards yet -- generate some above.') : 'No cards match the current filters.'}
            </p>
          </div>
        ) : viewMode === 'cards' ? (
          <div className="overflow-y-auto flex-1 flex flex-col">
            <div className="px-5 pt-4 pb-2 shrink-0">
              <label className="flex items-center gap-2 cursor-pointer w-fit">
                <input
                  type="checkbox"
                  checked={table.getRowModel().rows.length > 0 && table.getRowModel().rows.every(r => selectedIds.has(r.original.id))}
                  ref={el => { if (el) el.indeterminate = !table.getRowModel().rows.every(r => selectedIds.has(r.original.id)) && table.getRowModel().rows.some(r => selectedIds.has(r.original.id)); }}
                  onChange={() => {
                    const pageIds = table.getRowModel().rows.map(r => r.original.id);
                    const allSelected = pageIds.every(id => selectedIds.has(id));
                    setSelectedIds(prev => { const n = new Set(prev); if (allSelected) pageIds.forEach(id => n.delete(id)); else pageIds.forEach(id => n.add(id)); return n; });
                  }}
                  className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
                />
                <span className="text-xs text-gray-500 font-medium select-none">Select all</span>
              </label>
            </div>
            <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {table.getRowModel().rows.map(row => (
                <CardTile
                  key={row.original.id}
                  card={row.original}
                  cardIndex={row.original.card_number}
                  onEdit={startEdit}
                  onReject={handleReject}
                  onRestore={handleRestore}
                  onDelete={id => setConfirmDeleteCardId(id)}
                  onChunkInfo={card => setChunkInfoCard(card)}
                  editingId={editingId}
                  editFrontHtml={editFrontHtml}
                  setEditFrontHtml={setEditFrontHtml}
                  editTags={editTags}
                  setEditTags={setEditTags}
                  onSave={saveEdit}
                  onCancel={cancelEdit}
                  regenLoading={regenLoading}
                  onRegen={handleRegen}
                  selected={selectedIds.has(row.original.id)}
                  onToggleSelect={id => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
                />
              ))}
            </div>
          </div>
        ) : (
          <div ref={tableContainerRef} className="flex-1 overflow-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10">
                {table.getHeaderGroups().map(headerGroup => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map(header => (
                      <th
                        key={header.id}
                        style={{ width: header.getSize(), position: 'relative' }}
                        className="px-3 py-2 text-left text-[11px] font-semibold text-gray-700 uppercase tracking-wide bg-gray-100 border border-gray-400 select-none"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanResize() && (
                          <div
                            onMouseDown={header.getResizeHandler()}
                            onTouchStart={header.getResizeHandler()}
                            className={`absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none ${header.column.getIsResizing() ? 'bg-blue-500' : 'bg-gray-400 hover:bg-blue-400'}`}
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map(row => (
                  <tr
                    key={row.id}
                    className={`group transition-colors duration-100 ${row.original.status === 'rejected' ? 'bg-gray-100/60 opacity-70' : 'hover:bg-blue-50/30'}`}
                    style={rowHeights[row.original.id] ? { height: rowHeights[row.original.id] } : undefined}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const isEditable = ['front_text', 'tags', 'vignette', 'teaching_case'].includes(cell.column.id);
                      const isNumberCol = cell.column.id === 'card_number';
                      return (
                        <td
                          key={cell.id}
                          data-row={row.index}
                          data-col={cell.column.id}
                          style={{ width: cell.column.getSize(), ...(isEditable ? { height: '1px', padding: 0 } : {}) }}
                          className={`align-top border border-gray-300 ${isEditable ? '' : isNumberCol ? 'relative px-3 py-2.5' : 'px-3 py-2.5'}`}
                        >
                          {isEditable ? (
                            <div className="px-3 py-2.5 h-full">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </div>
                          ) : flexRender(cell.column.columnDef.cell, cell.getContext())}
                          {isNumberCol && (
                            <div
                              className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize opacity-0 group-hover:opacity-100 bg-blue-400/40 transition-opacity"
                              onMouseDown={(e) => handleRowResizeStart(e, row.original.id, e.currentTarget.closest('tr') as HTMLElement)}
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filteredCards.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-t border-gray-200 shrink-0 bg-white">
            <div className="flex items-center gap-1.5">
              <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} className="p-1.5 text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <span className="text-xs text-gray-500 tabular-nums">Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}</span>
              <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} className="p-1.5 text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{filteredCards.length} total</span>
              <select value={table.getState().pagination.pageSize} onChange={e => table.setPageSize(Number(e.target.value))} className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600">
                {[25, 50, 100].map(size => <option key={size} value={size}>{size} / page</option>)}
              </select>
            </div>
          </div>
        )}
      </main>

      {jobAlertError && <AlertModal title="Generation failed" message={jobAlertError} onClose={() => setJobAlertError(null)} />}

      {supplementalPending && (
        <ConfirmModal
          title={supplementalPending.replaceExisting ? 'Regenerate Vignettes & Cases?' : 'Generate Vignettes & Cases?'}
          message={
            supplementalPending.estimate
              ? `${supplementalPending.replaceExisting ? 'Regenerate' : 'Generate'} vignettes and teaching cases for ${supplementalPending.estimate.card_count} cards (${(supplementalPending.estimate as any).condition_groups ?? '?'} condition groups)?\n\nEstimated cost: ~$${supplementalPending.estimate.estimated_cost_usd.toFixed(3)}`
              : `${supplementalPending.replaceExisting ? 'Regenerate' : 'Generate'} vignettes and teaching cases for ${supplementalPending.cardIds.length} cards?`
          }
          confirmLabel={supplementalPending.replaceExisting ? 'Regenerate' : 'Generate'}
          variant="primary"
          onConfirm={handleSupplementalConfirm}
          onCancel={() => setSupplementalPending(null)}
        />
      )}

      {showGenerateConfirm && (
        <ConfirmModal
          title="Generate cards for whole document?"
          message={
            estimate
              ? `This will generate cards for all chunks and replace any existing cards.\n\nEstimated cost: ~$${estimate.estimated_cost_usd.toFixed(3)} (${estimate.estimated_input_tokens.toLocaleString()} in / ${estimate.estimated_output_tokens.toLocaleString()} out tokens).`
              : 'This will generate cards for all chunks and replace any existing cards.'
          }
          confirmLabel="Generate"
          variant="primary"
          onConfirm={() => { setShowGenerateConfirm(false); handleGenerate(); }}
          onCancel={() => setShowGenerateConfirm(false)}
        />
      )}

      {confirmDeleteCardId != null && (
        <ConfirmModal
          title="Delete card?"
          message="This permanently removes the card and cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => { handleDelete(confirmDeleteCardId); setConfirmDeleteCardId(null); }}
          onCancel={() => setConfirmDeleteCardId(null)}
        />
      )}

      {/* ── Chunk info modal ── */}
      {chunkInfoCard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setChunkInfoCard(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-mono text-gray-400 shrink-0">Chunk #{chunkInfoCard.chunk_id}</span>
                {chunkInfoCard.chunk_heading && <span className="text-xs font-semibold text-gray-800 truncate">{chunkInfoCard.chunk_heading}</span>}
                {chunkInfoCard.topic_path && (
                  <span className="text-[10px] text-blue-600 truncate hidden sm:block" title={chunkInfoCard.topic_path}>
                    {chunkInfoCard.topic_path.split(' > ').slice(-2).join(' › ')}
                  </span>
                )}
                {chunkInfoCard.note_id && (
                  <span className="text-[10px] font-mono text-gray-400 shrink-0" title="Anki Note ID">
                    NID: {chunkInfoCard.note_id}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-3">
                {onGoToChunk && (
                  <button onClick={() => { onGoToChunk(chunkInfoCard.document_id, chunkInfoCard.chunk_id); setChunkInfoCard(null); }} className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors duration-150">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                    Go to chunk
                  </button>
                )}
                <button onClick={() => setChunkInfoCard(null)} className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors duration-150">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">
              {chunkInfoCard.chunk_source_html ? (
                <div className="chunk-content" dangerouslySetInnerHTML={{ __html: chunkInfoCard.chunk_source_html }} />
              ) : (
                <p className="text-sm text-gray-400 italic">No content available.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {ankifyOpen && filteredCards.length > 0 && (
        <AnkifyModal
          cards={selectedIds.size > 0 ? filteredCards.filter(c => selectedIds.has(c.id)) : filteredCards}
          onClose={() => setAnkifyOpen(false)}
        />
      )}
    </>
  );
}
