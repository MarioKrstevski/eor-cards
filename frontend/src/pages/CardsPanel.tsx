import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import {
  getRuleSets,
  getModels,
  estimateCost,
  startGeneration,
  getGenerationJob,
  getCards,
  updateCard,
  rejectCard,
  exportCardsUrl,
} from '../api';
import type { Card, RuleSet, Model, CostEstimate, CardStatus } from '../types';

interface CardsPanelProps {
  documentId: number | null;
}

const columnHelper = createColumnHelper<Card>();

// ── Cloze rendering utility ────────────────────────────────────────────────────
function renderClozeHtml(html: string): string {
  return html.replace(
    /\{\{c\d+::([^}]+)\}\}/g,
    '<span style="background:#fef3c7;border-radius:3px;padding:1px 4px;font-weight:600;color:#92400e;border-bottom:2px solid #f59e0b">$1</span>'
  );
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
      className={`bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow flex flex-col${isRejected ? ' opacity-50' : ''}`}
    >
      {/* Card body */}
      <div className="p-4 flex-1" style={{ minHeight: '100px' }}>
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <textarea
              className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 resize-y min-h-[80px] focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              value={editFrontHtml}
              onChange={(e) => setEditFrontHtml(e.target.value)}
            />
            <input
              className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder="tag1, tag2"
            />
            <div className="flex items-center gap-1">
              <button
                onClick={() => onSave(card.id)}
                className="px-2 py-1 text-xs font-medium text-white bg-violet-600 rounded-md hover:bg-violet-700 transition-colors"
              >
                Save
              </button>
              <button
                onClick={onCancel}
                className="px-2 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
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
      <div className="border-t border-gray-100 px-3 py-2 bg-gray-50/50 rounded-b-lg flex items-center gap-1.5">
        {/* Card number */}
        <span className="text-xs text-gray-400 tabular-nums shrink-0">#{cardIndex}</span>

        {/* Tags */}
        <div className="flex items-center gap-1 flex-1 overflow-hidden">
          {card.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="bg-gray-100 text-gray-500 text-xs px-1.5 py-0.5 rounded-full truncate max-w-[80px]"
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Right side: review flag, status badge, actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Needs review */}
          {card.needs_review && (
            <span title="Needs review" className="text-yellow-500 text-base leading-none">⚠</span>
          )}

          {/* Status badge */}
          {isRejected ? (
            <span className="inline-flex items-center gap-1 text-xs text-gray-400 line-through">
              Rejected
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-green-700">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />
              Active
            </span>
          )}

          {/* Edit button */}
          <button
            onClick={() => onEdit(card)}
            title="Edit card"
            className="p-1 text-gray-400 hover:text-violet-600 transition-colors rounded"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
            </svg>
          </button>

          {/* Reject button */}
          <button
            onClick={() => onReject(card.id)}
            title="Reject card"
            className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CardsPanel({ documentId }: CardsPanelProps) {
  // ── Generation controls state ──────────────────────────────────────────────
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedRuleSetId, setSelectedRuleSetId] = useState<number | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [jobRunning, setJobRunning] = useState(false);
  const [jobProgress, setJobProgress] = useState<{ processed: number; total: number } | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fix C1 — stable ref so the polling closure never captures a stale documentId
  const documentIdRef = useRef(documentId);
  useEffect(() => { documentIdRef.current = documentId; }, [documentId]);

  // ── Card list state ────────────────────────────────────────────────────────
  const [cards, setCards] = useState<Card[]>([]);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | CardStatus>('all');

  // ── Inline editing state ───────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFrontHtml, setEditFrontHtml] = useState('');
  const [editTags, setEditTags] = useState('');

  // Fix I4 — action error state for reject / save failures
  const [actionError, setActionError] = useState<string | null>(null);

  // ── View mode state ────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');

  // ── Load rule sets and models once ────────────────────────────────────────
  // Fix I3 — add .catch(console.error) so mount errors surface in the console
  useEffect(() => {
    getRuleSets()
      .then((sets) => {
        setRuleSets(sets);
        const def = sets.find((s) => s.is_default) ?? sets[0];
        if (def) setSelectedRuleSetId(def.id);
      })
      .catch(console.error);
    getModels()
      .then((ms) => {
        setModels(ms);
        if (ms.length > 0) setSelectedModel(ms[0].id);
      })
      .catch(console.error);
  }, []);

  // ── Fetch cards ────────────────────────────────────────────────────────────
  const fetchCards = useCallback(async (docId: number) => {
    setCardsLoading(true);
    try {
      const data = await getCards({ document_id: docId });
      setCards(data);
    } catch {
      // silently fail
    } finally {
      setCardsLoading(false);
    }
  }, []);

  // ── Reset state when documentId changes ───────────────────────────────────
  useEffect(() => {
    // Clear any running poll
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
    setNeedsReviewOnly(false);
    setStatusFilter('all');
    setActionError(null);
    setViewMode('table');

    if (documentId != null) {
      fetchCards(documentId);
    }
  }, [documentId, fetchCards]);

  // ── Clean up interval on unmount ──────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // ── Estimate cost ──────────────────────────────────────────────────────────
  async function handleEstimate() {
    if (documentId == null || selectedRuleSetId == null || !selectedModel) return;
    setEstimating(true);
    setEstimateError(null);
    try {
      const result = await estimateCost({
        document_id: documentId,
        rule_set_id: selectedRuleSetId,
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
    if (documentId == null || selectedRuleSetId == null || !selectedModel) return;
    // Fix S1 — clear stale estimate when a new generation starts
    setEstimate(null);
    setJobError(null);
    setJobRunning(true);
    setJobProgress(null);

    try {
      const resp = await startGeneration({
        document_id: documentId,
        rule_set_id: selectedRuleSetId,
        model: selectedModel,
      });

      const jobId = resp.job_id;

      // Fix C2 — guard against double-start of interval
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(async () => {
        try {
          const job = await getGenerationJob(jobId);
          setJobProgress({ processed: job.processed_chunks, total: job.total_chunks });

          if (job.status === 'done') {
            clearInterval(intervalRef.current!);
            intervalRef.current = null;
            setJobRunning(false);
            // Fix C1 — use ref so closure always sees the latest documentId
            fetchCards(documentIdRef.current!);
          } else if (job.status === 'failed') {
            clearInterval(intervalRef.current!);
            intervalRef.current = null;
            setJobRunning(false);
            setJobError(job.error_message ?? 'Generation failed');
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

  // ── Handle selection changes (clear estimate) ──────────────────────────────
  function handleRuleSetChange(id: number) {
    setSelectedRuleSetId(id);
    setEstimate(null);
  }

  function handleModelChange(id: string) {
    setSelectedModel(id);
    setEstimate(null);
  }

  // Fix C3/I1 — wrap handlers in useCallback so columns memo dep array is stable

  // Fix I4 — handleReject surfaces errors via actionError
  const handleReject = useCallback(async (id: number) => {
    if (documentId == null) return;
    setActionError(null);
    try {
      await rejectCard(id);
      fetchCards(documentId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject card');
    }
  }, [documentId, fetchCards]);

  const startEdit = useCallback((card: Card) => {
    setEditingId(card.id);
    setEditFrontHtml(card.front_html);
    setEditTags(card.tags.join(', '));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  // Fix I4 — saveEdit surfaces errors via actionError
  const saveEdit = useCallback(async (id: number) => {
    if (documentId == null) return;
    setActionError(null);
    try {
      await updateCard(id, {
        front_html: editFrontHtml,
        tags: editTags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setEditingId(null);
      fetchCards(documentId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to save card');
    }
  }, [documentId, editFrontHtml, editTags, fetchCards]);

  // Fix I2 — memoize filteredCards
  const filteredCards = useMemo(
    () => cards.filter((c) => {
      if (needsReviewOnly && !c.needs_review) return false;
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      return true;
    }),
    [cards, needsReviewOnly, statusFilter],
  );

  // Fix C3/I1 — memoize columns so TanStack Table only rebuilds when inputs change
  const columns = useMemo(() => [
    columnHelper.accessor('card_number', {
      header: '#',
      size: 32,
      cell: (info) => <span className="text-xs text-gray-400 tabular-nums">{info.getValue()}</span>,
    }),
    columnHelper.accessor('front_text', {
      header: 'Front',
      cell: (info) => {
        const card = info.row.original;
        if (editingId === card.id) {
          return (
            <textarea
              className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 resize-y min-h-[60px] focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              value={editFrontHtml}
              onChange={(e) => setEditFrontHtml(e.target.value)}
            />
          );
        }
        return (
          <span className="block text-sm text-gray-800 whitespace-normal break-words">
            {info.getValue()}
          </span>
        );
      },
    }),
    columnHelper.accessor('tags', {
      header: 'Tags',
      size: 200,
      cell: (info) => {
        const card = info.row.original;
        if (editingId === card.id) {
          return (
            <input
              className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder="tag1, tag2"
            />
          );
        }
        const tags = info.getValue();
        if (tags.length === 0) return null;
        return (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600"
              >
                {tag}
              </span>
            ))}
          </div>
        );
      },
    }),
    columnHelper.accessor('needs_review', {
      header: 'Review',
      size: 70,
      cell: (info) =>
        info.getValue() ? (
          <span title="Needs review" className="text-yellow-500 text-base leading-none">⚠</span>
        ) : null,
    }),
    columnHelper.accessor('status', {
      header: 'Status',
      size: 90,
      cell: (info) => {
        const v = info.getValue();
        return v === 'active' ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-green-700">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />
            Active
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-red-600">
            <span className="h-1.5 w-1.5 rounded-full bg-red-400 inline-block" />
            Rejected
          </span>
        );
      },
    }),
    columnHelper.display({
      id: 'actions',
      header: 'Actions',
      size: 90,
      cell: (info) => {
        const card = info.row.original;
        if (editingId === card.id) {
          return (
            <div className="flex items-center gap-1">
              <button
                onClick={() => saveEdit(card.id)}
                className="px-2 py-1 text-xs font-medium text-white bg-violet-600 rounded-md hover:bg-violet-700 transition-colors"
              >
                Save
              </button>
              <button
                onClick={cancelEdit}
                className="px-2 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-1">
            {/* Edit */}
            <button
              onClick={() => startEdit(card)}
              title="Edit card"
              className="p-1 text-gray-400 hover:text-violet-600 transition-colors rounded"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H8v-2.414a2 2 0 01.586-1.414z" />
              </svg>
            </button>
            {/* Reject */}
            <button
              onClick={() => handleReject(card.id)}
              title="Reject card"
              className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      },
    }),
  ], [editingId, editFrontHtml, editTags, saveEdit, cancelEdit, startEdit, handleReject]);

  const table = useReactTable({
    data: filteredCards,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  // ── Null state ─────────────────────────────────────────────────────────────
  if (documentId === null) {
    return (
      <main className="flex-1 overflow-hidden flex flex-col items-center justify-center gap-3 bg-gray-50">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-12 w-12 text-gray-200"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <p className="text-sm text-gray-400">Select a document from the sidebar to view cards</p>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-hidden flex flex-col bg-white">
      {/* ── Section 1: Generation Controls ────────────────────────────────── */}
      <div className="bg-gray-50 border-b border-gray-200 px-5 py-3 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Rule set selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Rule set</label>
            <select
              className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:opacity-50"
              value={selectedRuleSetId ?? ''}
              onChange={(e) => handleRuleSetChange(Number(e.target.value))}
              disabled={jobRunning}
            >
              {ruleSets.map((rs) => (
                <option key={rs.id} value={rs.id}>
                  {rs.name}{rs.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Model selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Model</label>
            <select
              className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent disabled:opacity-50"
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={jobRunning}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display}
                </option>
              ))}
            </select>
          </div>

          {/* Divider */}
          <div className="h-5 w-px bg-gray-200" />

          {/* Estimate button */}
          <button
            onClick={handleEstimate}
            disabled={jobRunning || estimating || !selectedRuleSetId || !selectedModel}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500"
          >
            {estimating ? 'Estimating…' : 'Estimate cost'}
          </button>

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={jobRunning || !selectedRuleSetId || !selectedModel}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-violet-600 rounded-md hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1"
          >
            {jobRunning ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Generating…
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Generate
              </>
            )}
          </button>

          {/* Inline estimate result */}
          {estimate && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
              ~${estimate.estimated_cost_usd.toFixed(4)}
              <span className="text-green-500">·</span>
              {estimate.estimated_input_tokens.toLocaleString()} in / {estimate.estimated_output_tokens.toLocaleString()} out tokens
            </span>
          )}

          {/* Estimate error */}
          {estimateError && (
            <span className="text-xs text-red-600">{estimateError}</span>
          )}

          {/* Job progress */}
          {jobRunning && jobProgress && (
            <span className="text-xs text-gray-500 tabular-nums">
              {jobProgress.processed}/{jobProgress.total} chunks
            </span>
          )}

          {/* Job error */}
          {jobError && (
            <span className="text-xs text-red-600">{jobError}</span>
          )}
        </div>
      </div>

      {/* ── Section 2: Card Grid ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Toolbar above table */}
        <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-gray-100 shrink-0 bg-white">
          <div className="flex items-center gap-4">
            {/* View mode toggle */}
            <div className="flex items-center gap-0.5 rounded-md border border-gray-200 p-0.5 bg-gray-50">
              {/* Table view */}
              <button
                onClick={() => setViewMode('table')}
                title="Table view"
                className={`p-1 rounded transition-colors ${viewMode === 'table' ? 'bg-violet-100 text-violet-700' : 'text-gray-400 hover:text-gray-600'}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M10 4v16M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" />
                </svg>
              </button>
              {/* Cards view */}
              <button
                onClick={() => setViewMode('cards')}
                title="Card view"
                className={`p-1 rounded transition-colors ${viewMode === 'cards' ? 'bg-violet-100 text-violet-700' : 'text-gray-400 hover:text-gray-600'}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <rect x="3" y="3" width="8" height="8" rx="1" strokeLinecap="round" strokeLinejoin="round" />
                  <rect x="13" y="3" width="8" height="8" rx="1" strokeLinecap="round" strokeLinejoin="round" />
                  <rect x="3" y="13" width="8" height="8" rx="1" strokeLinecap="round" strokeLinejoin="round" />
                  <rect x="13" y="13" width="8" height="8" rx="1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            {/* Needs review toggle */}
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={needsReviewOnly}
                onChange={(e) => setNeedsReviewOnly(e.target.checked)}
                className="rounded border-gray-300 text-violet-600 focus:ring-violet-400"
              />
              Needs review only
            </label>

            {/* Status filter */}
            <div className="flex items-center gap-1.5">
              <label className="text-xs font-medium text-gray-500">Status</label>
              <select
                className="text-sm border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | CardStatus)}
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>

            {/* Card count */}
            <span className="text-xs text-gray-400 tabular-nums">
              {filteredCards.length} card{filteredCards.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Export button */}
          <button
            onClick={() => window.open(exportCardsUrl({ document_id: documentId }))}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export
          </button>
        </div>

        {/* Fix I4 — action error banner (reject / save failures) */}
        {actionError && (
          <div className="px-5 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">
            {actionError}
          </div>
        )}

        {/* Loading / empty states (shared across views) */}
        {cardsLoading ? (
          <div className="flex items-center justify-center h-32 text-sm text-gray-400 flex-1">
            Loading cards…
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-gray-400 flex-1">
            {cards.length === 0 ? 'No cards yet — generate some above.' : 'No cards match the current filters.'}
          </div>
        ) : viewMode === 'cards' ? (
          /* Card grid view */
          <div className="p-4 overflow-y-auto flex-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredCards.map((card, idx) => (
                <CardTile
                  key={card.id}
                  card={card}
                  cardIndex={card.card_number ?? idx + 1}
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
          /* Table view */
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-gray-50 z-10">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id} className="border-b border-gray-200">
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                        className="px-3 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        style={{ width: cell.column.getSize() !== 150 ? cell.column.getSize() : undefined }}
                        className="px-3 py-2.5 align-top"
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
      </div>
    </main>
  );
}
