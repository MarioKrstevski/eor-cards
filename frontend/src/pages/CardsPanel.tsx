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
} from '../api';
import type { Card, CostEstimate, CardStatus } from '../types';
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
  return html.replace(/\{\{c\d+::([^}]+)\}\}/g, '$1');
}

function stripHtmlKeepCloze(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ── Excel-style editable cell ──────────────────────────────────────────────────
interface EditableCellProps {
  value: string;
  isSelected: boolean;
  isEditing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onSave: (val: string) => void;
  onCancel: () => void;
  onNavigate: (dir: 'up' | 'down' | 'left' | 'right') => void;
  multiline?: boolean;
  renderDisplay?: (val: string) => React.ReactNode;
}

function EditableCell({
  value,
  isSelected,
  isEditing,
  onSelect,
  onStartEdit,
  onSave,
  onCancel,
  onNavigate,
  multiline,
  renderDisplay,
}: EditableCellProps) {
  const [localVal, setLocalVal] = useState(value);
  const wasEditing = useRef(false);
  const divRef = useRef<HTMLDivElement>(null);

  // Sync local value when edit starts
  useEffect(() => {
    if (isEditing && !wasEditing.current) setLocalVal(value);
    wasEditing.current = isEditing;
  }, [isEditing, value]);

  // Focus the div when selected (enables keyboard nav)
  useEffect(() => {
    if (isSelected && !isEditing && divRef.current) {
      divRef.current.focus({ preventScroll: true });
    }
  }, [isSelected, isEditing]);

  if (isEditing) {
    const sharedProps = {
      value: localVal,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
        setLocalVal(e.target.value),
      onBlur: () => onSave(localVal),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        if (e.key === 'Tab') { e.preventDefault(); onSave(localVal); }
      },
      autoFocus: true,
      className:
        'w-full text-sm bg-transparent resize-none border-0 outline-none focus:outline-none p-0 leading-relaxed',
    };
    return (
      <div className="ring-2 ring-blue-600 ring-inset rounded-sm min-h-[2rem] p-0.5">
        {multiline ? (
          <textarea {...sharedProps} rows={3} />
        ) : (
          <input type="text" {...sharedProps} />
        )}
      </div>
    );
  }

  return (
    <div
      ref={divRef}
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={(e) => { e.preventDefault(); onStartEdit(); }}
      onFocus={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); onNavigate('up'); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onNavigate('down'); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); onNavigate('left'); }
        if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('right'); }
        if (e.key === 'Enter') { e.preventDefault(); onStartEdit(); }
      }}
      className={`min-h-[2rem] cursor-default outline-none rounded-sm ${
        isSelected ? 'ring-2 ring-blue-500 ring-inset' : ''
      }`}
    >
      {renderDisplay ? renderDisplay(value) : (
        <span className="text-sm text-gray-800">{value}</span>
      )}
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

// ── Column definitions for visibility toggle ───────────────────────────────────
const OPTIONAL_COLUMNS = [
  { id: 'vignette', label: 'Vignette' },
  { id: 'teaching_case', label: 'Teaching Case' },
] as const;

const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
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
  const { selectedModel, selectedRuleSetId } = useSettings();

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
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [statusFilter, setStatusFilter] = useState<'all' | CardStatus>('all');
  const [searchQ, setSearchQ] = useState('');

  // ── Tile-view inline editing state ────────────────────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFrontHtml, setEditFrontHtml] = useState('');
  const [editTags, setEditTags] = useState('');

  // ── Excel-style cell selection (table view only) ───────────────────────────
  type CellCoord = { rowIndex: number; colId: string };
  const [selectedCell, setSelectedCell] = useState<CellCoord | null>(null);
  const [editingCell, setEditingCell] = useState<CellCoord | null>(null);

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

  // ── Anki/plain toggle ─────────────────────────────────────────────────────
  const [showAnkiFormat, setShowAnkiFormat] = useState(false);

  // ── Column sizing (persisted) ─────────────────────────────────────────────
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    try {
      const stored = localStorage.getItem('cards_column_sizing');
      return stored ? JSON.parse(stored) : {};
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
    async (docId: number | null, topicPathFilter?: string | null, chunk?: number | null) => {
      setCardsLoading(true);
      try {
        let rawCards: Card[];
        if (docId != null) {
          rawCards = await getCards(
            chunk != null ? { document_id: docId, chunk_id: chunk } : { document_id: docId }
          );
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
        setCardsLoading(false);
      }
    },
    []
  );

  // ── Reset state when props change ─────────────────────────────────────────
  useEffect(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setCards([]);
    setEstimate(null);
    setEstimateError(null);
    setJobRunning(false);
    setJobProgress(null);
    setJobError(null);
    setEditingId(null);
    setSelectedCell(null);
    setEditingCell(null);
    setUnreviewedOnly(false);
    setSelectedIds(new Set());
    setStatusFilter('all');
    setSearchQ('');
    setActionError(null);
    setViewMode('table');
    if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
    else if (topicPath) fetchCards(null, topicPath);
  }, [documentId, chunkId, topicPath, fetchCards]);

  // ── Re-fetch on external refresh trigger ──────────────────────────────────
  useEffect(() => {
    if (!refreshKey) return;
    if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
    else if (topicPath) fetchCards(null, topicPath);
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clean up interval on unmount ──────────────────────────────────────────
  useEffect(() => { return () => { if (intervalRef.current) clearInterval(intervalRef.current); }; }, []);

  // ── Clear cell selection on page change ───────────────────────────────────
  useEffect(() => { setSelectedCell(null); setEditingCell(null); }, [pagination.pageIndex]);

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
            fetchCards(documentIdRef.current!, null, null);
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
      await rejectCard(id);
      if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
      else if (topicPath) fetchCards(null, topicPath);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to reject card'); }
  }, [documentId, chunkId, topicPath, fetchCards]);

  const handleRestore = useCallback(async (id: number) => {
    setActionError(null);
    try {
      await updateCard(id, { status: 'active' });
      if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
      else if (topicPath) fetchCards(null, topicPath);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to restore card'); }
  }, [documentId, chunkId, topicPath, fetchCards]);

  const handleDelete = useCallback(async (id: number) => {
    setActionError(null);
    try {
      await deleteCard(id);
      setCards(prev => prev.filter(c => c.id !== id));
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to delete card'); }
  }, []);

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

  // ── Table-view inline save handlers ───────────────────────────────────────
  const saveFrontInline = useCallback(async (id: number, val: string) => {
    setActionError(null);
    try {
      await updateCard(id, { front_html: val });
      if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
      else if (topicPath) fetchCards(null, topicPath);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save'); }
  }, [documentId, chunkId, topicPath, fetchCards]);

  const saveTagsInline = useCallback(async (id: number, val: string) => {
    setActionError(null);
    const tags = val.split(',').map(t => t.trim()).filter(Boolean);
    try {
      await updateCard(id, { tags });
      if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
      else if (topicPath) fetchCards(null, topicPath);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save tags'); }
  }, [documentId, chunkId, topicPath, fetchCards]);

  const saveFieldInline = useCallback(async (id: number, field: 'vignette' | 'teaching_case', val: string) => {
    setActionError(null);
    try {
      await updateCard(id, { [field]: val });
      if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
      else if (topicPath) fetchCards(null, topicPath);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to save'); }
  }, [documentId, chunkId, topicPath, fetchCards]);

  // ── Cell keyboard navigation ───────────────────────────────────────────────
  const handleCellNavigate = useCallback((rowIndex: number, colId: string, dir: 'up' | 'down' | 'left' | 'right', totalPageRows: number) => {
    const navigableCols = ['front_text', 'tags'];
    if (columnVisibility['vignette'] !== false) navigableCols.push('vignette');
    if (columnVisibility['teaching_case'] !== false) navigableCols.push('teaching_case');

    const colIdx = navigableCols.indexOf(colId);
    let newRow = rowIndex;
    let newCol = colId;

    if (dir === 'up') newRow = Math.max(0, rowIndex - 1);
    if (dir === 'down') newRow = Math.min(totalPageRows - 1, rowIndex + 1);
    if (dir === 'left') newCol = navigableCols[Math.max(0, colIdx - 1)];
    if (dir === 'right') newCol = navigableCols[Math.min(navigableCols.length - 1, colIdx + 1)];

    setSelectedCell({ rowIndex: newRow, colId: newCol });
    setEditingCell(null);
  }, [columnVisibility]);

  const handleRegen = useCallback(async (id: number, prompt?: string) => {
    setRegenLoading(true); setActionError(null);
    try {
      await regenerateCard(id, { model: selectedModel, prompt: (prompt ?? regenPrompt) || undefined });
      setRegenId(null); setRegenPrompt('');
      if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
      else if (topicPath) fetchCards(null, topicPath);
      refreshUsage?.();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Regeneration failed'); }
    finally { setRegenLoading(false); }
  }, [documentId, chunkId, topicPath, selectedModel, regenPrompt, fetchCards]);

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
      onReviewChange?.();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed to mark as reviewed'); }
  }, [unreviewedSelectedIds, onReviewChange]);

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
        size: 38,
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
          return (
            <input
              type="checkbox"
              checked={selectedIds.has(id)}
              onChange={() => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
              className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
            />
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
              <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
              <button onClick={(e) => { e.stopPropagation(); setChunkInfoCard(card); }} title="View source chunk" className="text-gray-300 hover:text-blue-500 transition-colors duration-150">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
          const isSel = selectedCell?.rowIndex === rowIndex && selectedCell?.colId === 'front_text';
          const isEd = editingCell?.rowIndex === rowIndex && editingCell?.colId === 'front_text';
          return (
            <EditableCell
              value={card.front_html}
              isSelected={isSel}
              isEditing={isEd}
              onSelect={() => { setSelectedCell({ rowIndex, colId: 'front_text' }); setEditingCell(null); }}
              onStartEdit={() => setEditingCell({ rowIndex, colId: 'front_text' })}
              onSave={(val) => { setEditingCell(null); saveFrontInline(card.id, val); }}
              onCancel={() => { setEditingCell(null); setSelectedCell({ rowIndex, colId: 'front_text' }); }}
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
          const tagsStr = card.tags.join(', ');
          const isSel = selectedCell?.rowIndex === rowIndex && selectedCell?.colId === 'tags';
          const isEd = editingCell?.rowIndex === rowIndex && editingCell?.colId === 'tags';
          return (
            <EditableCell
              value={tagsStr}
              isSelected={isSel}
              isEditing={isEd}
              onSelect={() => { setSelectedCell({ rowIndex, colId: 'tags' }); setEditingCell(null); }}
              onStartEdit={() => setEditingCell({ rowIndex, colId: 'tags' })}
              onSave={(val) => { setEditingCell(null); saveTagsInline(card.id, val); }}
              onCancel={() => { setEditingCell(null); setSelectedCell({ rowIndex, colId: 'tags' }); }}
              onNavigate={(dir) => handleCellNavigate(rowIndex, 'tags', dir, totalPageRows)}
              renderDisplay={(val) => {
                if (!val) return <span className="text-gray-300 text-xs">—</span>;
                const tags = val.split(',').map(t => t.trim()).filter(Boolean);
                return (
                  <div className="flex flex-wrap gap-1">
                    {tags.map(tag => (
                      <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium">{tag}</span>
                    ))}
                  </div>
                );
              }}
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
          const val = card.vignette ?? '';
          const isSel = selectedCell?.rowIndex === rowIndex && selectedCell?.colId === 'vignette';
          const isEd = editingCell?.rowIndex === rowIndex && editingCell?.colId === 'vignette';
          return (
            <EditableCell
              value={val}
              isSelected={isSel}
              isEditing={isEd}
              onSelect={() => { setSelectedCell({ rowIndex, colId: 'vignette' }); setEditingCell(null); }}
              onStartEdit={() => setEditingCell({ rowIndex, colId: 'vignette' })}
              onSave={(v) => { setEditingCell(null); saveFieldInline(card.id, 'vignette', v); }}
              onCancel={() => { setEditingCell(null); setSelectedCell({ rowIndex, colId: 'vignette' }); }}
              onNavigate={(dir) => handleCellNavigate(rowIndex, 'vignette', dir, totalPageRows)}
              multiline
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
          const val = card.teaching_case ?? '';
          const isSel = selectedCell?.rowIndex === rowIndex && selectedCell?.colId === 'teaching_case';
          const isEd = editingCell?.rowIndex === rowIndex && editingCell?.colId === 'teaching_case';
          return (
            <EditableCell
              value={val}
              isSelected={isSel}
              isEditing={isEd}
              onSelect={() => { setSelectedCell({ rowIndex, colId: 'teaching_case' }); setEditingCell(null); }}
              onStartEdit={() => setEditingCell({ rowIndex, colId: 'teaching_case' })}
              onSave={(v) => { setEditingCell(null); saveFieldInline(card.id, 'teaching_case', v); }}
              onCancel={() => { setEditingCell(null); setSelectedCell({ rowIndex, colId: 'teaching_case' }); }}
              onNavigate={(dir) => handleCellNavigate(rowIndex, 'teaching_case', dir, totalPageRows)}
              multiline
              renderDisplay={(v) =>
                v
                  ? <div className="text-sm text-gray-800 leading-relaxed whitespace-normal break-words" dangerouslySetInnerHTML={{ __html: v }} />
                  : <span className="text-gray-300 text-xs">—</span>
              }
            />
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        size: 76,
        enableHiding: false,
        cell: (info) => {
          const card = info.row.original;
          const rowIndex = info.row.index;
          return (
            <div className="relative grid grid-cols-2 gap-0.5 w-fit">
              <button
                onClick={() => setEditingCell({ rowIndex, colId: 'front_text' })}
                title="Edit"
                className="p-1.5 text-gray-400 hover:text-blue-700 transition-colors duration-150 rounded-lg hover:bg-blue-50"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
                </svg>
              </button>
              <button
                onClick={() => { setRegenId(regenId === card.id ? null : card.id); setRegenPrompt(''); }}
                title="Regenerate"
                className={`p-1.5 transition-colors duration-150 rounded-lg ${regenId === card.id ? 'text-amber-600 bg-amber-50' : 'text-gray-400 hover:text-amber-500 hover:bg-amber-50'}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              {card.status === 'rejected' ? (
                <button onClick={() => handleRestore(card.id)} title="Restore card" className="p-1.5 text-green-500 hover:text-green-700 transition-colors duration-150 rounded-lg hover:bg-green-50">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 11l3 3L22 4M3 12a9 9 0 1018 0 9 9 0 00-18 0z" />
                  </svg>
                </button>
              ) : (
                <button onClick={() => handleReject(card.id)} title="Reject" className="p-1.5 text-gray-400 hover:text-red-500 transition-colors duration-150 rounded-lg hover:bg-red-50">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              <button onClick={() => setConfirmDeleteCardId(card.id)} title="Delete permanently" className="p-1.5 text-gray-400 hover:text-red-700 transition-colors duration-150 rounded-lg hover:bg-red-50">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
                </svg>
              </button>
              {regenId === card.id && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setRegenId(null)} />
                  <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-amber-200 rounded-xl shadow-xl p-3 w-52">
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
          );
        },
      }),
    ],
    [
      selectedCell,
      editingCell,
      saveFrontInline,
      saveTagsInline,
      saveFieldInline,
      handleCellNavigate,
      handleReject,
      handleRestore,
      regenId,
      regenPrompt,
      regenLoading,
      handleRegen,
      showAnkiFormat,
      selectedIds,
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
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-200 shrink-0 bg-white flex-wrap">
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

            {/* Ankify */}
            {filteredCards.length > 0 && (
              <button onClick={() => setAnkifyOpen(true)} className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100 transition-colors duration-150" title="Review cards Anki-style">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Ankify
              </button>
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

            {unreviewedSelectedIds.length > 0 && (
              <button onClick={handleBulkReview} className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors duration-150">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Mark {unreviewedSelectedIds.length} reviewed
              </button>
            )}
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
          <div className="flex-1 overflow-auto">
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
                    className={`transition-colors duration-100 ${row.original.status === 'rejected' ? 'bg-gray-100/60 opacity-70' : 'hover:bg-blue-50/30'}`}
                  >
                    {row.getVisibleCells().map(cell => (
                      <td
                        key={cell.id}
                        style={{ width: cell.column.getSize() }}
                        className="px-3 py-2.5 align-top border border-gray-300"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
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
                <span className="text-[10px] font-mono text-gray-400 shrink-0">#{chunkInfoCard.chunk_id}</span>
                {chunkInfoCard.chunk_heading && <span className="text-xs font-semibold text-gray-800 truncate">{chunkInfoCard.chunk_heading}</span>}
                {chunkInfoCard.topic_path && (
                  <span className="text-[10px] text-blue-600 truncate hidden sm:block" title={chunkInfoCard.topic_path}>
                    {chunkInfoCard.topic_path.split(' > ').slice(-2).join(' › ')}
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
