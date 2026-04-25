import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import type { ColumnSizingState, PaginationState } from '@tanstack/react-table';
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
import { useSettings } from '../context/SettingsContext';

interface CardsPanelProps {
  documentId: number | null;
  chunkId?: number | null;
  topicPath?: string | null;
  refreshKey?: number;
  refreshUsage?: () => void;
  onGoToChunk?: (documentId: number, chunkId: number) => void;
}

const columnHelper = createColumnHelper<Card>();

// ── Cloze rendering utility ────────────────────────────────────────────────────
// Just reveal the term — all bold/color styling comes from Claude's HTML output.
function renderClozeHtml(html: string): string {
  return html.replace(/\{\{c\d+::([^}]+)\}\}/g, '$1');
}

// Strips HTML tags but preserves {{c1::term}} cloze syntax
function stripHtmlKeepCloze(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ── CardTile component ─────────────────────────────────────────────────────────
interface CardTileProps {
  card: Card;
  cardIndex: number;
  onEdit: (card: Card) => void;
  onReject: (id: number) => void;
  editingId: number | null;
  editFrontHtml: string;
  setEditFrontHtml: (v: string) => void;
  editTags: string;
  setEditTags: (v: string) => void;
  onSave: (id: number) => void;
  onCancel: () => void;
}

function CardTile({
  card,
  cardIndex,
  onEdit,
  onReject,
  editingId,
  editFrontHtml,
  setEditFrontHtml,
  editTags,
  setEditTags,
  onSave,
  onCancel,
}: CardTileProps) {
  const isEditing = editingId === card.id;
  const isRejected = card.status === 'rejected';

  return (
    <div
      className={`bg-white rounded-xl border border-gray-200 shadow-md hover:shadow-lg transition-all duration-200 flex flex-col${isRejected ? ' opacity-60 bg-gray-50' : ''}`}
    >
      {/* Card body */}
      <div className="p-5 flex-1" style={{ minHeight: '100px' }}>
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
              <button
                onClick={() => onSave(card.id)}
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150"
              >
                Save
              </button>
              <button
                onClick={onCancel}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className="text-sm leading-relaxed text-gray-800"
            dangerouslySetInnerHTML={{ __html: renderClozeHtml(card.front_html) }}
          />
        )}
      </div>

      {/* Bottom strip */}
      <div className="border-t border-gray-50 px-4 py-2.5 bg-gray-50/30 rounded-b-xl flex items-center gap-2">
        <span className="text-xs text-gray-400 tabular-nums shrink-0 font-medium">#{cardIndex}</span>
        <div className="flex items-center gap-1 flex-1 overflow-hidden">
          {card.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="bg-gray-100 text-gray-500 text-[11px] px-2 py-0.5 rounded-full truncate max-w-[80px] font-medium"
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className={`w-2 h-2 rounded-full ${
              isRejected ? 'bg-red-400' : card.is_reviewed ? 'bg-gray-300' : 'bg-amber-400'
            }`}
            title={isRejected ? 'Rejected' : card.is_reviewed ? 'Reviewed' : 'Not reviewed'}
          />
          <button
            onClick={() => onEdit(card)}
            title="Edit card"
            className="p-1 text-gray-400 hover:text-blue-700 transition-colors duration-150 rounded-lg"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z"
              />
            </svg>
          </button>
          <button
            onClick={() => onReject(card.id)}
            title="Reject card"
            className="p-1 text-gray-400 hover:text-red-500 transition-colors duration-150 rounded-lg"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CardsPanel({
  documentId,
  chunkId,
  topicPath,
  refreshKey,
  refreshUsage,
  onGoToChunk,
}: CardsPanelProps) {
  const { selectedModel, selectedRuleSetId } = useSettings();

  // ── Generation controls state ──────────────────────────────────────────────
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [jobRunning, setJobRunning] = useState(false);
  const [jobProgress, setJobProgress] = useState<{ processed: number; total: number } | null>(
    null
  );
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobAlertError, setJobAlertError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stable ref so the polling closure never captures stale documentId
  const documentIdRef = useRef(documentId);
  useEffect(() => {
    documentIdRef.current = documentId;
  }, [documentId]);

  // ── Card list state ────────────────────────────────────────────────────────
  const [cards, setCards] = useState<Card[]>([]);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });
  const [statusFilter, setStatusFilter] = useState<'all' | CardStatus>('all');
  const [searchQ, setSearchQ] = useState('');

  // ── Inline editing state ───────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFrontHtml, setEditFrontHtml] = useState('');
  const [editTags, setEditTags] = useState('');

  // ── Per-card regenerate state ─────────────────────────────────────────────
  const [regenId, setRegenId] = useState<number | null>(null);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);

  // ── Delete confirmation ───────────────────────────────────────────────────
  const [confirmDeleteCardId, setConfirmDeleteCardId] = useState<number | null>(null);

  // ── Tags popover ──────────────────────────────────────────────────────────
  const [tagsPopoverId, setTagsPopoverId] = useState<number | null>(null);

  // ── Chunk info modal ──────────────────────────────────────────────────────
  const [chunkInfoCard, setChunkInfoCard] = useState<Card | null>(null);

  // ── Action error state ────────────────────────────────────────────────────
  const [actionError, setActionError] = useState<string | null>(null);

  // ── View mode state ────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');

  // ── Anki/plain toggle ─────────────────────────────────────────────────────
  const [showAnkiFormat, setShowAnkiFormat] = useState(false);

  // ── Column sizing (persisted) ─────────────────────────────────────────────
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    try {
      const stored = localStorage.getItem('cards_column_sizing');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  // ── Fetch cards ────────────────────────────────────────────────────────────
  const fetchCards = useCallback(
    async (
      docId: number | null,
      topicPathFilter?: string | null,
      chunk?: number | null
    ) => {
      setCardsLoading(true);
      try {
        let rawCards: Card[];
        if (docId != null) {
          rawCards = await getCards(
            chunk != null
              ? { document_id: docId, chunk_id: chunk }
              : { document_id: docId }
          );
        } else if (topicPathFilter) {
          // Fetch all cards and filter locally by topic_path prefix
          rawCards = await getCards();
          rawCards = rawCards.filter(
            (c) => c.topic_path && c.topic_path.startsWith(topicPathFilter)
          );
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
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setCards([]);
    setEstimate(null);
    setEstimateError(null);
    setJobRunning(false);
    setJobProgress(null);
    setJobError(null);
    setEditingId(null);
    setUnreviewedOnly(false);
    setSelectedIds(new Set());
    setStatusFilter('all');
    setSearchQ('');
    setActionError(null);
    setViewMode('table');

    if (documentId != null) {
      fetchCards(documentId, null, chunkId ?? null);
    } else if (topicPath) {
      fetchCards(null, topicPath);
    }
  }, [documentId, chunkId, topicPath, fetchCards]);

  // ── Re-fetch cards on external refresh trigger ─────────────────────────────
  useEffect(() => {
    if (!refreshKey) return;
    if (documentId != null) {
      fetchCards(documentId, null, chunkId ?? null);
    } else if (topicPath) {
      fetchCards(null, topicPath);
    }
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clean up interval on unmount ──────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // ── Estimate cost ──────────────────────────────────────────────────────────
  async function handleEstimate() {
    if (documentId == null || !selectedModel) return;
    setEstimating(true);
    setEstimateError(null);
    try {
      const rules = await getRuleSets();
      const ruleId =
        rules.find((r) => r.id === selectedRuleSetId)?.id ??
        rules.find((r) => r.is_default)?.id ??
        rules[0]?.id;
      if (!ruleId) { setEstimateError('No rule set available'); setEstimating(false); return; }
      const result = await estimateCost({
        document_id: documentId,
        rule_set_id: ruleId,
        model: selectedModel,
      });
      setEstimate(result);
    } catch (err) {
      setEstimateError(err instanceof Error ? err.message : 'Estimate failed');
      setEstimate(null);
    } finally {
      setEstimating(false);
    }
  }

  // ── Start generation ───────────────────────────────────────────────────────
  async function handleGenerate() {
    if (documentId == null || !selectedModel) return;
    setEstimate(null);
    setJobError(null);
    setJobRunning(true);
    setJobProgress(null);

    try {
      const rules = await getRuleSets();
      const ruleId =
        rules.find((r) => r.id === selectedRuleSetId)?.id ??
        rules.find((r) => r.is_default)?.id ??
        rules[0]?.id;
      if (!ruleId) { setJobRunning(false); setJobError('No rule set available'); return; }
      const resp = await startGeneration({
        document_id: documentId,
        rule_set_id: ruleId,
        model: selectedModel,
      });

      const jobId = resp.job_id;
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(jobId);
          setJobProgress({ processed: job.processed_chunks, total: job.total_chunks });

          if (job.status === 'done') {
            clearInterval(intervalRef.current!);
            intervalRef.current = null;
            setJobRunning(false);
            fetchCards(documentIdRef.current!, null, null);
            refreshUsage?.();
          } else if (job.status === 'failed') {
            clearInterval(intervalRef.current!);
            intervalRef.current = null;
            setJobRunning(false);
            const errMsg = job.error_message ?? 'Generation failed';
            setJobError(errMsg);
            setJobAlertError(errMsg);
          }
        } catch {
          // keep polling on transient errors
        }
      }, 2000);
    } catch (err) {
      setJobRunning(false);
      setJobError(err instanceof Error ? err.message : 'Failed to start generation');
    }
  }

  // ── Card action handlers ───────────────────────────────────────────────────
  const handleReject = useCallback(
    async (id: number) => {
      setActionError(null);
      try {
        await rejectCard(id);
        if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
        else if (topicPath) fetchCards(null, topicPath);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to reject card');
      }
    },
    [documentId, chunkId, topicPath, fetchCards]
  );

  const handleRestore = useCallback(
    async (id: number) => {
      setActionError(null);
      try {
        await updateCard(id, { status: 'active' });
        if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
        else if (topicPath) fetchCards(null, topicPath);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to restore card');
      }
    },
    [documentId, chunkId, topicPath, fetchCards]
  );

  const handleDelete = useCallback(async (id: number) => {
    setActionError(null);
    try {
      await deleteCard(id);
      setCards((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete card');
    }
  }, []);

  const startEdit = useCallback((card: Card) => {
    setEditingId(card.id);
    setEditFrontHtml(card.front_html);
    setEditTags(card.tags.join(', '));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const saveEdit = useCallback(
    async (id: number) => {
      setActionError(null);
      try {
        await updateCard(id, {
          front_html: editFrontHtml,
          tags: editTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        });
        setEditingId(null);
        if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
        else if (topicPath) fetchCards(null, topicPath);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to save card');
      }
    },
    [documentId, chunkId, topicPath, editFrontHtml, editTags, fetchCards]
  );

  const handleRegen = useCallback(
    async (id: number) => {
      setRegenLoading(true);
      setActionError(null);
      try {
        await regenerateCard(id, {
          model: selectedModel,
          prompt: regenPrompt || undefined,
        });
        setRegenId(null);
        setRegenPrompt('');
        if (documentId != null) fetchCards(documentId, null, chunkId ?? null);
        else if (topicPath) fetchCards(null, topicPath);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Regeneration failed');
      } finally {
        setRegenLoading(false);
      }
    },
    [documentId, chunkId, topicPath, selectedModel, regenPrompt, fetchCards]
  );

  const handleBulkReview = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    try {
      await bulkMarkReviewed(ids);
      setSelectedIds(new Set());
      setCards(prev => prev.map(c => ids.includes(c.id) ? { ...c, is_reviewed: true } : c));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to mark as reviewed');
    }
  }, [selectedIds]);

  // ── Filtered cards ─────────────────────────────────────────────────────────
  const filteredCards = useMemo(
    () =>
      cards.filter((c) => {
        if (unreviewedOnly && c.is_reviewed) return false;
        if (statusFilter !== 'all' && c.status !== statusFilter) return false;
        if (
          searchQ.trim() &&
          !c.front_text.toLowerCase().includes(searchQ.toLowerCase()) &&
          !c.tags.some((t) => t.toLowerCase().includes(searchQ.toLowerCase()))
        )
          return false;
        return true;
      }),
    [cards, unreviewedOnly, statusFilter, searchQ]
  );

  // ── TanStack Table columns ─────────────────────────────────────────────────
  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        size: 32,
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
                if (allSelected) {
                  setSelectedIds(prev => { const n = new Set(prev); pageIds.forEach(id => n.delete(id)); return n; });
                } else {
                  setSelectedIds(prev => new Set([...prev, ...pageIds]));
                }
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
              onChange={() => {
                setSelectedIds(prev => {
                  const n = new Set(prev);
                  if (n.has(id)) n.delete(id); else n.add(id);
                  return n;
                });
              }}
              className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
            />
          );
        },
      }),
      columnHelper.accessor('card_number', {
        header: '#',
        size: 40,
        cell: (info) => {
          const card = info.row.original;
          const dotColor = card.status === 'rejected'
            ? 'bg-red-400'
            : card.is_reviewed
              ? 'bg-gray-300'
              : 'bg-amber-400';
          return (
            <div className="flex flex-col items-center gap-0.5">
              <span className={`text-xs tabular-nums ${!card.is_reviewed ? 'font-bold text-gray-900' : 'font-normal text-gray-400'}`}>
                {info.getValue()}
              </span>
              <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
              <button
                onClick={(e) => { e.stopPropagation(); setChunkInfoCard(card); }}
                title="View source chunk"
                className="text-gray-300 hover:text-blue-500 transition-colors duration-150"
              >
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
        cell: (info) => {
          const card = info.row.original;
          if (editingId === card.id) {
            return (
              <textarea
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-y min-h-[60px] focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
                value={editFrontHtml}
                onChange={(e) => setEditFrontHtml(e.target.value)}
              />
            );
          }
          if (showAnkiFormat) {
            return (
              <span
                className="block text-sm text-gray-800 whitespace-normal break-words leading-relaxed"
                dangerouslySetInnerHTML={{ __html: renderClozeHtml(card.front_html) }}
              />
            );
          }
          return (
            <span className="block text-sm text-gray-800 whitespace-normal break-words leading-relaxed">
              {stripHtmlKeepCloze(card.front_html)}
            </span>
          );
        },
      }),
      columnHelper.accessor('tags', {
        header: 'Tags',
        size: 120,
        cell: (info) => {
          const card = info.row.original;
          if (editingId === card.id) {
            return (
              <textarea
                className="w-full text-[11px] border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-transparent transition-colors duration-150"
                rows={3}
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
                placeholder="tag1, tag2"
              />
            );
          }
          const tags = info.getValue();
          if (tags.length === 0) return <span className="text-gray-300 text-xs">—</span>;
          const isOpen = tagsPopoverId === card.id;
          return (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setTagsPopoverId(isOpen ? null : card.id);
                }}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border transition-colors duration-150 ${
                  isOpen
                    ? 'bg-blue-100 text-blue-700 border-blue-300'
                    : 'bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100 hover:border-blue-300'
                }`}
              >
                {tags[0]}
                {tags.length > 1 && (
                  <span className="bg-blue-200 text-blue-700 rounded px-1 text-[10px] font-semibold">
                    +{tags.length - 1}
                  </span>
                )}
              </button>
              {isOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setTagsPopoverId(null)}
                  />
                  <div className="absolute left-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-xl shadow-xl p-2.5 min-w-[160px] max-w-[240px]">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5 px-1">Tags</p>
                    <div className="flex flex-wrap gap-1">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-medium"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        size: 64,
        cell: (info) => {
          const card = info.row.original;
          if (editingId === card.id) {
            return (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => saveEdit(card.id)}
                  className="px-2.5 py-1 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors duration-150"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                >
                  Cancel
                </button>
              </div>
            );
          }
          return (
            <div className="relative grid grid-cols-2 gap-0.5 w-fit">
                <button
                  onClick={() => startEdit(card)}
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
                  <button
                    onClick={() => handleRestore(card.id)}
                    title="Restore card"
                    className="p-1.5 text-green-500 hover:text-green-700 transition-colors duration-150 rounded-lg hover:bg-green-50"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 11l3 3L22 4M3 12a9 9 0 1018 0 9 9 0 00-18 0z" />
                    </svg>
                  </button>
                ) : (
                  <button
                    onClick={() => handleReject(card.id)}
                    title="Reject"
                    className="p-1.5 text-gray-400 hover:text-red-500 transition-colors duration-150 rounded-lg hover:bg-red-50"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={() => setConfirmDeleteCardId(card.id)}
                  title="Delete permanently"
                  className="p-1.5 text-gray-400 hover:text-red-700 transition-colors duration-150 rounded-lg hover:bg-red-50"
                >
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
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRegen(card.id);
                        if (e.key === 'Escape') setRegenId(null);
                      }}
                      autoFocus
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleRegen(card.id)}
                        disabled={regenLoading}
                        className="flex-1 px-2.5 py-1.5 text-xs font-medium text-white bg-amber-500 rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors duration-150"
                      >
                        {regenLoading ? 'Working...' : 'Regenerate'}
                      </button>
                      <button
                        onClick={() => setRegenId(null)}
                        className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-50 transition-colors duration-150"
                      >
                        Cancel
                      </button>
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
      editingId,
      editFrontHtml,
      editTags,
      saveEdit,
      cancelEdit,
      startEdit,
      handleReject,
      handleRestore,
      regenId,
      regenPrompt,
      regenLoading,
      handleRegen,
      showAnkiFormat,
      tagsPopoverId,
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
    state: { columnSizing, pagination },
    onColumnSizingChange: (updater) => {
      setColumnSizing((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        localStorage.setItem('cards_column_sizing', JSON.stringify(next));
        return next;
      });
    },
    onPaginationChange: setPagination,
  });

  // ── Empty state ────────────────────────────────────────────────────────────
  if (documentId === null && !topicPath) {
    return (
      <main className="flex-1 overflow-hidden flex flex-col items-center justify-center gap-4 bg-gray-50/50">
        <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-8 w-8 text-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
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
        {/* ── Generation Controls — only when documentId is set ── */}
        {documentId != null && (
          <div className="bg-white px-5 py-2.5 shrink-0 border-b border-gray-200">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Estimate button — ghost style */}
              <button
                onClick={handleEstimate}
                disabled={jobRunning || estimating || !selectedModel}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {estimating ? 'Estimating...' : 'Estimate cost'}
              </button>

              {/* Generate button — solid blue */}
              <button
                onClick={handleGenerate}
                disabled={jobRunning || !selectedModel}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-1"
              >
                {jobRunning ? (
                  <>
                    <svg
                      className="animate-spin h-3.5 w-3.5"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v8H4z"
                      />
                    </svg>
                    Generating...
                  </>
                ) : (
                  <>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      />
                    </svg>
                    Generate for whole Document
                  </>
                )}
              </button>

              {/* Estimate result — elegant pill */}
              {estimate && (
                <span className="inline-flex flex-col items-center px-3 py-1.5 rounded-full text-xs font-medium bg-green-50 text-green-700 leading-tight">
                  <span className="font-semibold">~${estimate.estimated_cost_usd.toFixed(2)}</span>
                  <span className="text-green-500 font-normal text-[10px]">
                    {estimate.estimated_input_tokens.toLocaleString()} in /{' '}
                    {estimate.estimated_output_tokens.toLocaleString()} out
                  </span>
                </span>
              )}

              {estimateError && <span className="text-xs text-red-600">{estimateError}</span>}

              {jobRunning && jobProgress && (
                <span className="text-xs text-gray-500 tabular-nums font-medium">
                  {jobProgress.processed}/{jobProgress.total} chunks
                </span>
              )}

              {jobError && <span className="text-xs text-red-600">{jobError}</span>}
            </div>
          </div>
        )}

        {/* ── Topic header when in topic mode ── */}
        {topicPath && (
          <div className="px-5 py-3 border-b border-gray-200 bg-blue-50/40 shrink-0">
            <p className="text-xs font-medium text-blue-700">
              Cards for:{' '}
              <span className="font-semibold">{topicName}</span>
            </p>
            <p className="text-[10px] text-blue-500 mt-0.5 truncate">{topicPath}</p>
          </div>
        )}

        {/* ── Card grid toolbar ── */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-200 shrink-0 bg-white flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            {/* View mode toggle */}
            <div className="flex items-center gap-0.5 rounded-lg bg-gray-100/80 p-0.5">
              <button
                onClick={() => setViewMode('table')}
                title="Table view"
                className={`p-1.5 rounded-md transition-colors duration-150 ${viewMode === 'table' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 10h18M3 14h18M10 4v16M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z"
                  />
                </svg>
              </button>
              <button
                onClick={() => setViewMode('cards')}
                title="Card view"
                className={`p-1.5 rounded-md transition-colors duration-150 ${viewMode === 'cards' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <rect x="3" y="3" width="8" height="8" rx="1" />
                  <rect x="13" y="3" width="8" height="8" rx="1" />
                  <rect x="3" y="13" width="8" height="8" rx="1" />
                  <rect x="13" y="13" width="8" height="8" rx="1" />
                </svg>
              </button>
            </div>

            {/* Anki format toggle — only relevant in table view */}
            {viewMode === 'table' && (
              <button
                onClick={() => setShowAnkiFormat((v) => !v)}
                title={showAnkiFormat ? 'Switch to plain text' : 'Switch to Anki cloze view'}
                className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors duration-150 ${
                  showAnkiFormat
                    ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {showAnkiFormat ? 'Anki' : 'Text'}
              </button>
            )}

            {/* Unreviewed only toggle */}
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none font-medium">
              <input
                type="checkbox"
                checked={unreviewedOnly}
                onChange={(e) => setUnreviewedOnly(e.target.checked)}
                className="rounded border-gray-300 text-blue-700 focus:ring-blue-500"
              />
              Unreviewed only
            </label>

            {/* Status filter */}
            <div className="flex items-center gap-1.5">
              <select
                className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-600 font-medium focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | CardStatus)}
              >
                <option value="all">All status</option>
                <option value="active">Active</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>

            {/* Search */}
            <div className="relative">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent w-44 transition-colors duration-150"
                placeholder="Search cards..."
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
              />
              {searchQ && (
                <button
                  onClick={() => setSearchQ('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>

            {/* Card count */}
            <span className="text-xs text-gray-400 tabular-nums font-medium">
              {filteredCards.length} card{filteredCards.length !== 1 ? 's' : ''}
            </span>

            {/* Bulk review button */}
            {selectedIds.size > 0 && (
              <button
                onClick={handleBulkReview}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors duration-150"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Mark {selectedIds.size} reviewed
              </button>
            )}
          </div>

          {/* Export button */}
          <button
            onClick={() =>
              window.open(
                documentId != null ? exportCardsUrl({ document_id: documentId }) : exportCardsUrl()
              )
            }
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Export
          </button>
        </div>

        {/* Action error banner */}
        {actionError && (
          <div className="px-5 py-2.5 text-xs text-red-600 bg-red-50 border-b border-red-100">
            {actionError}
          </div>
        )}

        {/* Cards content */}
        {cardsLoading ? (
          <div className="flex items-center justify-center h-32 text-sm text-gray-400 flex-1">
            Loading cards...
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 gap-3">
            <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6 text-gray-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
            </div>
            <p className="text-sm text-gray-500 font-medium">
              {cards.length === 0
                ? topicPath
                  ? 'No cards for this topic yet.'
                  : 'No cards yet -- generate some above.'
                : 'No cards match the current filters.'}
            </p>
          </div>
        ) : viewMode === 'cards' ? (
          <div className="p-5 overflow-y-auto flex-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {table.getRowModel().rows.map((row) => (
                <CardTile
                  key={row.original.id}
                  card={row.original}
                  cardIndex={row.original.card_number}
                  onEdit={startEdit}
                  onReject={handleReject}
                  editingId={editingId}
                  editFrontHtml={editFrontHtml}
                  setEditFrontHtml={setEditFrontHtml}
                  editTags={editTags}
                  setEditTags={setEditTags}
                  onSave={saveEdit}
                  onCancel={cancelEdit}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
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
                            className={`absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none ${
                              header.column.getIsResizing()
                                ? 'bg-blue-500'
                                : 'bg-gray-400 hover:bg-blue-400'
                            }`}
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`transition-colors duration-100 ${
                      row.original.status === 'rejected'
                        ? 'bg-gray-100/60 opacity-70'
                        : 'hover:bg-blue-50/30'
                    }`}
                  >
                    {row.getVisibleCells().map((cell) => (
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
              <button
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                className="p-1.5 text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="text-xs text-gray-500 tabular-nums">
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
              </span>
              <button
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                className="p-1.5 text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{filteredCards.length} total</span>
              <select
                value={table.getState().pagination.pageSize}
                onChange={(e) => table.setPageSize(Number(e.target.value))}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {[25, 50, 100].map(size => (
                  <option key={size} value={size}>{size} / page</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </main>

      {jobAlertError && (
        <AlertModal
          title="Generation failed"
          message={jobAlertError}
          onClose={() => setJobAlertError(null)}
        />
      )}

      {confirmDeleteCardId != null && (
        <ConfirmModal
          title="Delete card?"
          message="This permanently removes the card and cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => {
            handleDelete(confirmDeleteCardId);
            setConfirmDeleteCardId(null);
          }}
          onCancel={() => setConfirmDeleteCardId(null)}
        />
      )}

      {/* ── Chunk info modal ── */}
      {chunkInfoCard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setChunkInfoCard(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            {/* Compact header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-mono text-gray-400 shrink-0">#{chunkInfoCard.chunk_id}</span>
                {chunkInfoCard.chunk_heading && (
                  <span className="text-xs font-semibold text-gray-800 truncate">{chunkInfoCard.chunk_heading}</span>
                )}
                {chunkInfoCard.topic_path && (
                  <span className="text-[10px] text-blue-600 truncate hidden sm:block" title={chunkInfoCard.topic_path}>
                    {chunkInfoCard.topic_path.split(' > ').slice(-2).join(' › ')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-3">
                {onGoToChunk && (
                  <button
                    onClick={() => {
                      onGoToChunk(chunkInfoCard.document_id, chunkInfoCard.chunk_id);
                      setChunkInfoCard(null);
                    }}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors duration-150"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    Go to chunk
                  </button>
                )}
                <button
                  onClick={() => setChunkInfoCard(null)}
                  className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors duration-150"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Chunk content — same rendering as sidebar chunk view */}
            <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">
              {chunkInfoCard.chunk_source_html ? (
                <div
                  className="chunk-content"
                  dangerouslySetInnerHTML={{ __html: chunkInfoCard.chunk_source_html }}
                />
              ) : (
                <p className="text-sm text-gray-400 italic">No content available.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
