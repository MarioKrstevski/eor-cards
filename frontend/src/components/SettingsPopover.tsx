import { useEffect, useRef, useState } from 'react';
import { getModels, getRuleSets } from '../api';
import type { Model, RuleSet } from '../types';
import { useSettings } from '../context/SettingsContext';

export default function SettingsPopover({ onClose }: { onClose: () => void }) {
  const {
    selectedModel, setSelectedModel,
    chunkingModel, setChunkingModel,
    selectedRuleSetId, setSelectedRuleSetId,
  } = useSettings();
  const [models, setModels] = useState<Model[]>([]);
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([getModels(), getRuleSets()])
      .then(([ms, rs]) => {
        setModels(ms);
        setRuleSets(rs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  function modelLabel(m: Model) {
    return `${m.display} ($${m.input_per_1m.toFixed(2)}/$${m.output_per_1m.toFixed(2)})`;
  }

  return (
    <div className="fixed inset-0 z-50" aria-modal="true" role="dialog">
      <div className="absolute inset-0" />
      <div
        ref={panelRef}
        className="absolute top-14 right-3 w-72 bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-xs font-semibold text-gray-900 uppercase tracking-wider">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50 transition-colors duration-150"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3.5">
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-2">Loading...</p>
          ) : (
            <>
              {/* Chunking model */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                  Chunking Model
                </label>
                <select
                  className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
                  value={chunkingModel}
                  onChange={(e) => setChunkingModel(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{modelLabel(m)}</option>
                  ))}
                  {models.length === 0 && <option value={chunkingModel}>{chunkingModel}</option>}
                </select>
              </div>

              {/* Generation model */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                  Generation Model
                </label>
                <select
                  className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{modelLabel(m)}</option>
                  ))}
                  {models.length === 0 && <option value={selectedModel}>{selectedModel}</option>}
                </select>
              </div>

              {/* Rule set */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                  Rule Set
                </label>
                <select
                  className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-colors duration-150"
                  value={selectedRuleSetId ?? ''}
                  onChange={(e) => setSelectedRuleSetId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">-- none --</option>
                  {ruleSets.map((rs) => (
                    <option key={rs.id} value={rs.id}>
                      {rs.name}{rs.is_default ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <p className="text-[10px] text-gray-400">Saved automatically to localStorage.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
