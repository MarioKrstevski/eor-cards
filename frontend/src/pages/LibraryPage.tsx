import { useCallback, useEffect, useState } from 'react';
import {
  getCurriculum,
  createCurriculumNode,
  updateCurriculumNode,
  deleteCurriculumNode,
  getRuleSets,
  createRuleSet,
  updateRuleSet,
  deleteRuleSet,
  setDefaultRuleSet,
  getDocuments,
  updateDocument,
  deleteDocument,
  exportCardsUrl,
} from '../api';
import type { CurriculumNode, RuleSet, Document } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flattenTree(nodes: CurriculumNode[]): CurriculumNode[] {
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

// ─── CurriculumTreeNode ───────────────────────────────────────────────────────

interface TreeNodeProps {
  node: CurriculumNode;
  selectedId: number | null;
  onSelect: (node: CurriculumNode) => void;
  onRefresh: () => void;
  onDeselect: (id: number) => void;
}

function CurriculumTreeNode({
  node,
  selectedId,
  onSelect,
  onRefresh,
  onDeselect,
}: TreeNodeProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [addingChild, setAddingChild] = useState(false);
  const [childName, setChildName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isSelected = node.id === selectedId;

  async function handleRename() {
    if (!renameValue.trim()) return;
    try {
      await updateCurriculumNode(node.id, { name: renameValue.trim() });
      setRenaming(false);
      onRefresh();
    } catch {
      setError('Rename failed');
    }
  }

  async function handleDelete() {
    try {
      await deleteCurriculumNode(node.id);
      onDeselect(node.id);
      onRefresh();
    } catch {
      setError('Delete failed');
    }
  }

  async function handleAddChild() {
    if (!childName.trim()) return;
    try {
      await createCurriculumNode({ name: childName.trim(), parent_id: node.id });
      setChildName('');
      setAddingChild(false);
      onRefresh();
    } catch {
      setError('Add child failed');
    }
  }

  return (
    <div>
      <div
        className={`group flex items-center gap-1 py-0.5 px-2 rounded cursor-pointer text-sm
          ${isSelected ? 'bg-purple-50 border-l-2 border-purple-500 pl-1.5' : 'hover:bg-gray-50'}`}
        onClick={() => onSelect(node)}
      >
        {renaming ? (
          <input
            autoFocus
            className="flex-1 border border-gray-300 rounded px-1 py-0 text-sm"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { setRenaming(false); setRenameValue(node.name); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate">{node.name}</span>
        )}

        {renaming ? (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); handleRename(); }}
              className="text-xs text-green-600 hover:text-green-800 px-1"
            >
              OK
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setRenaming(false); setRenameValue(node.name); }}
              className="text-xs text-gray-500 hover:text-gray-700 px-1"
            >
              Cancel
            </button>
          </>
        ) : (
          <span className="opacity-0 group-hover:opacity-100 flex items-center gap-1 ml-1">
            <button
              title="Add child"
              onClick={(e) => { e.stopPropagation(); setAddingChild((v) => !v); }}
              className="text-xs text-blue-500 hover:text-blue-700 leading-none px-0.5"
            >
              +
            </button>
            <button
              title="Rename"
              onClick={(e) => { e.stopPropagation(); setRenaming(true); }}
              className="text-xs text-gray-500 hover:text-gray-700 leading-none px-0.5"
            >
              ✎
            </button>
            <button
              title="Delete"
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              className="text-xs text-red-400 hover:text-red-600 leading-none px-0.5"
            >
              ×
            </button>
          </span>
        )}
      </div>

      {error && <p className="text-red-500 text-xs pl-4">{error}</p>}

      {addingChild && (
        <div className="pl-6 flex items-center gap-1 mt-0.5">
          <input
            autoFocus
            className="border border-gray-300 rounded px-1 py-0 text-xs flex-1"
            placeholder="Child name"
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddChild();
              if (e.key === 'Escape') { setAddingChild(false); setChildName(''); }
            }}
          />
          <button onClick={handleAddChild} className="text-xs text-green-600 hover:text-green-800">OK</button>
          <button onClick={() => { setAddingChild(false); setChildName(''); }} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
        </div>
      )}

      {node.children.length > 0 && (
        <div className="pl-4">
          {node.children.map((child) => (
            <CurriculumTreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              onRefresh={onRefresh}
              onDeselect={onDeselect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RuleSetItem ──────────────────────────────────────────────────────────────

interface RuleSetItemProps {
  rs: RuleSet;
  onRefresh: () => void;
}

function RuleSetItem({ rs, onRefresh }: RuleSetItemProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(rs.name);
  const [editContent, setEditContent] = useState(rs.content);
  const [editIsDefault, setEditIsDefault] = useState(rs.is_default);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    try {
      await updateRuleSet(rs.id, {
        name: editName.trim(),
        content: editContent,
        is_default: editIsDefault,
      });
      setEditing(false);
      onRefresh();
    } catch {
      setError('Save failed');
    }
  }

  async function handleDelete() {
    try {
      await deleteRuleSet(rs.id);
      onRefresh();
    } catch {
      setError('Delete failed');
    }
  }

  async function handleSetDefault() {
    try {
      await setDefaultRuleSet(rs.id);
      onRefresh();
    } catch {
      setError('Set default failed');
    }
  }

  if (editing) {
    return (
      <div className="border border-gray-200 rounded p-2 mb-2 text-sm">
        {error && <p className="text-red-500 text-xs mb-1">{error}</p>}
        <input
          className="w-full border border-gray-300 rounded px-2 py-1 mb-1 text-sm"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder="Rule set name"
        />
        <textarea
          className="w-full border border-gray-300 rounded px-2 py-1 mb-1 text-xs font-mono resize-y"
          rows={6}
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          placeholder="Rule set content"
        />
        <label className="flex items-center gap-1 text-xs mb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={editIsDefault}
            onChange={(e) => setEditIsDefault(e.target.checked)}
          />
          Is default
        </label>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
          >
            Save
          </button>
          <button
            onClick={() => { setEditing(false); setError(null); }}
            className="text-xs text-gray-600 hover:text-gray-800"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded p-2 mb-2 text-sm">
      {error && <p className="text-red-500 text-xs mb-1">{error}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium flex-1 truncate">{rs.name}</span>
        {rs.is_default && (
          <span className="bg-green-100 text-green-700 text-xs px-1.5 py-0.5 rounded-full font-medium">
            default
          </span>
        )}
      </div>
      <div className="flex gap-1 mt-1.5 flex-wrap">
        {!rs.is_default && (
          <button
            onClick={handleSetDefault}
            className="text-xs text-green-600 hover:text-green-800 underline"
          >
            Set default
          </button>
        )}
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-blue-600 hover:text-blue-800 underline"
        >
          Edit
        </button>
        <button
          onClick={handleDelete}
          className="text-xs text-red-500 hover:text-red-700 underline"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ─── NewRuleSetForm ───────────────────────────────────────────────────────────

interface NewRuleSetFormProps {
  onSaved: () => void;
  onCancel: () => void;
}

function NewRuleSetForm({ onSaved, onCancel }: NewRuleSetFormProps) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    try {
      await createRuleSet({ name: name.trim(), content, is_default: isDefault });
      onSaved();
    } catch {
      setError('Create failed');
    }
  }

  return (
    <div className="border border-gray-200 rounded p-2 mb-2 text-sm">
      {error && <p className="text-red-500 text-xs mb-1">{error}</p>}
      <input
        autoFocus
        className="w-full border border-gray-300 rounded px-2 py-1 mb-1 text-sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Rule set name"
      />
      <textarea
        className="w-full border border-gray-300 rounded px-2 py-1 mb-1 text-xs font-mono resize-y"
        rows={6}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Rule set content"
      />
      <label className="flex items-center gap-1 text-xs mb-2 cursor-pointer">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        Is default
      </label>
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="text-xs text-gray-600 hover:text-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── LibraryPage ──────────────────────────────────────────────────────────────

export default function LibraryPage() {
  // Curriculum state
  const [curriculum, setCurriculum] = useState<CurriculumNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<CurriculumNode | null>(null);
  const [addingRoot, setAddingRoot] = useState(false);
  const [rootName, setRootName] = useState('');
  const [curriculumError, setCurriculumError] = useState<string | null>(null);

  // Rule sets state
  const [ruleSets, setRuleSets] = useState<RuleSet[]>([]);
  const [creatingRuleSet, setCreatingRuleSet] = useState(false);
  const [ruleSetError, setRuleSetError] = useState<string | null>(null);

  // Documents state
  const [documents, setDocuments] = useState<Document[]>([]);
  const [docError, setDocError] = useState<string | null>(null);

  // ── Data fetching ──

  const fetchCurriculum = useCallback(async () => {
    try {
      const data = await getCurriculum();
      setCurriculum(data);
    } catch {
      setCurriculumError('Failed to load curriculum');
    }
  }, []);

  const fetchRuleSets = useCallback(async () => {
    try {
      const data = await getRuleSets();
      setRuleSets(data);
    } catch {
      setRuleSetError('Failed to load rule sets');
    }
  }, []);

  const fetchDocuments = useCallback(async () => {
    try {
      const data = await getDocuments();
      setDocuments(data);
    } catch {
      setDocError('Failed to load documents');
    }
  }, []);

  useEffect(() => {
    fetchCurriculum();
    fetchRuleSets();
    fetchDocuments();
  }, [fetchCurriculum, fetchRuleSets, fetchDocuments]);

  // ── Curriculum helpers ──

  const handleDeselectIfDeleted = useCallback((id: number) => {
    setSelectedNode((prev) => (prev?.id === id ? null : prev));
  }, []);

  async function handleAddRoot() {
    if (!rootName.trim()) return;
    try {
      await createCurriculumNode({ name: rootName.trim(), parent_id: null });
      setRootName('');
      setAddingRoot(false);
      fetchCurriculum();
    } catch {
      setCurriculumError('Add root failed');
    }
  }

  // ── Document helpers ──

  const handleAssignCurriculum = useCallback(async (docId: number, value: string) => {
    const curriculum_id = value === '' ? null : Number(value);
    try {
      await updateDocument(docId, { curriculum_id });
      fetchDocuments();
    } catch {
      setDocError('Update failed');
    }
  }, [fetchDocuments]);

  const handleDeleteDocument = useCallback(async (docId: number) => {
    try {
      await deleteDocument(docId);
      fetchDocuments();
    } catch {
      setDocError('Delete failed');
    }
  }, [fetchDocuments]);

  // ── Derived data ──

  const flatCurriculum = flattenTree(curriculum);

  const filteredDocuments = selectedNode
    ? documents.filter(
        (doc) =>
          doc.topic_path === selectedNode.path ||
          doc.topic_path?.startsWith(selectedNode.path + ' > ')
      )
    : documents;

  // ── Export ──

  function handleExport() {
    const url = exportCardsUrl(
      selectedNode ? { curriculum_id: selectedNode.id } : undefined
    );
    window.open(url);
  }

  // ──────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-49px)]">
      {/* ── Left Panel ──────────────────────────────────────────────────── */}
      <aside className="w-64 border-r flex flex-col overflow-y-auto">

        {/* Curriculum section */}
        <div className="p-3 border-b">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">
              Curriculum
            </h2>
            <button
              onClick={() => setAddingRoot((v) => !v)}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              title="Add root node"
            >
              + Add root
            </button>
          </div>

          {curriculumError && (
            <p className="text-red-500 text-xs mb-1">{curriculumError}</p>
          )}

          {addingRoot && (
            <div className="flex items-center gap-1 mb-2">
              <input
                autoFocus
                className="border border-gray-300 rounded px-1 py-0 text-xs flex-1"
                placeholder="Node name"
                value={rootName}
                onChange={(e) => setRootName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddRoot();
                  if (e.key === 'Escape') { setAddingRoot(false); setRootName(''); }
                }}
              />
              <button onClick={handleAddRoot} className="text-xs text-green-600 hover:text-green-800">OK</button>
              <button onClick={() => { setAddingRoot(false); setRootName(''); }} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
            </div>
          )}

          {curriculum.length === 0 && !addingRoot && (
            <p className="text-xs text-gray-400 italic">No nodes yet</p>
          )}

          {curriculum.map((node) => (
            <CurriculumTreeNode
              key={node.id}
              node={node}
              selectedId={selectedNode?.id ?? null}
              onSelect={setSelectedNode}
              onRefresh={fetchCurriculum}
              onDeselect={handleDeselectIfDeleted}
            />
          ))}
        </div>

        {/* Rule Sets section */}
        <div className="p-3 flex-1">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-sm text-gray-700 uppercase tracking-wide">
              Rule Sets
            </h2>
            <button
              onClick={() => setCreatingRuleSet((v) => !v)}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              + New
            </button>
          </div>

          {ruleSetError && (
            <p className="text-red-500 text-xs mb-1">{ruleSetError}</p>
          )}

          {creatingRuleSet && (
            <NewRuleSetForm
              onSaved={() => { setCreatingRuleSet(false); fetchRuleSets(); }}
              onCancel={() => setCreatingRuleSet(false)}
            />
          )}

          {ruleSets.length === 0 && !creatingRuleSet && (
            <p className="text-xs text-gray-400 italic">No rule sets yet</p>
          )}

          {ruleSets.map((rs) => (
            <RuleSetItem key={rs.id} rs={rs} onRefresh={fetchRuleSets} />
          ))}
        </div>
      </aside>

      {/* ── Right Panel ─────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-gray-800">
            {selectedNode ? selectedNode.path : 'All Documents'}
          </h1>
          <div className="flex items-center gap-2">
            {selectedNode && (
              <button
                onClick={() => setSelectedNode(null)}
                className="text-xs text-gray-500 hover:text-gray-700 underline"
              >
                Clear filter
              </button>
            )}
            <button
              onClick={handleExport}
              className="text-sm bg-purple-600 text-white px-3 py-1.5 rounded hover:bg-purple-700"
            >
              Export cards
            </button>
          </div>
        </div>

        {docError && (
          <p className="text-red-500 text-sm mb-3">{docError}</p>
        )}

        {filteredDocuments.length === 0 ? (
          <p className="text-gray-400 italic text-sm">No documents found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-3 py-2 border-b font-medium">Document</th>
                  <th className="px-3 py-2 border-b font-medium">Topic path</th>
                  <th className="px-3 py-2 border-b font-medium text-right">Chunks</th>
                  <th className="px-3 py-2 border-b font-medium">Assigned curriculum</th>
                  <th className="px-3 py-2 border-b font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.map((doc) => (
                  <tr key={doc.id} className="hover:bg-gray-50 border-b border-gray-100">
                    <td className="px-3 py-2 font-medium text-gray-800 max-w-xs truncate">
                      {doc.original_name}
                    </td>
                    <td className="px-3 py-2 text-gray-400 text-xs max-w-xs truncate">
                      {doc.topic_path ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {doc.chunk_count}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className="border border-gray-300 rounded px-1 py-0.5 text-xs w-full max-w-[180px]"
                        value={doc.curriculum_id ?? ''}
                        onChange={(e) =>
                          handleAssignCurriculum(doc.id, e.target.value)
                        }
                      >
                        <option value="">— unassigned —</option>
                        {flatCurriculum.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.path}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => handleDeleteDocument(doc.id)}
                        className="text-red-400 hover:text-red-600 text-xs font-medium"
                        title="Delete document"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
