import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDocument, getDocuments, uploadDocument } from '../api';
import type { Document } from '../types';

export default function WorkspacePage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocuments = useCallback(async () => {
    try {
      const docs = await getDocuments();
      setDocuments(docs);
    } catch {
      // silently fail on refresh — list just stays stale
    }
  }, []);

  useEffect(() => {
    setLoadingDocs(true);
    fetchDocuments().finally(() => setLoadingDocs(false));
  }, [fetchDocuments]);

  function handleUploadClick() {
    setUploadError(null);
    fileInputRef.current?.click();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // reset so selecting the same file again fires the event
    e.target.value = '';

    setUploadError(null);
    setUploading(true);

    try {
      const result = await uploadDocument(file);
      if (result.suggested_curriculum_id != null) {
        console.log('Suggested curriculum_id:', result.suggested_curriculum_id);
      }
      await fetchDocuments();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Upload failed. Please try again.';
      setUploadError(msg);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    setDeleteError(null);
    try {
      await deleteDocument(id);
      if (selectedDocumentId === id) setSelectedDocumentId(null);
      await fetchDocuments();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Delete failed. Please try again.';
      setDeleteError(msg);
    }
  }

  return (
    <div className="flex h-[calc(100vh-49px)] overflow-hidden">
      {/* Left panel */}
      <aside className="w-64 shrink-0 border-r border-gray-200 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Documents
          </h2>
          <button
            onClick={handleUploadClick}
            disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-md bg-purple-600 hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {uploading ? (
              <>
                <svg
                  className="animate-spin h-3 w-3"
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
                Uploading…
              </>
            ) : (
              'Upload .docx'
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Upload error */}
        {uploadError && (
          <div className="mx-3 mt-2 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md">
            {uploadError}
          </div>
        )}

        {/* Delete error */}
        {deleteError && (
          <div className="mx-3 mt-2 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md">
            {deleteError}
          </div>
        )}

        {/* Document list */}
        <div className="flex-1 overflow-y-auto py-1">
          {loadingDocs ? (
            <div className="flex items-center justify-center h-20 text-sm text-gray-400">
              Loading…
            </div>
          ) : documents.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-sm text-gray-400">
              No documents yet
            </div>
          ) : (
            documents.map((doc) => {
              const isSelected = doc.id === selectedDocumentId;
              return (
                <div
                  key={doc.id}
                  onClick={() => setSelectedDocumentId(doc.id)}
                  className={[
                    'group flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors',
                    isSelected
                      ? 'bg-purple-50 border-l-2 border-purple-500'
                      : 'border-l-2 border-transparent',
                  ].join(' ')}
                >
                  {/* Doc info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 truncate leading-tight">
                      {doc.original_name}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {doc.chunk_count} chunk{doc.chunk_count !== 1 ? 's' : ''}
                    </p>
                  </div>

                  {/* Delete button */}
                  <button
                    onClick={(e) => handleDelete(e, doc.id)}
                    title="Delete document"
                    className="shrink-0 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z"
                      />
                    </svg>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Right panel */}
      <main className="flex-1 overflow-hidden flex items-center justify-center text-sm text-gray-400">
        Select a document to view cards
      </main>
    </div>
  );
}
