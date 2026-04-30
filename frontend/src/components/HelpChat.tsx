import { useState, useRef, useEffect } from 'react';
import { sendChatMessage, getChatSessions, getChatSession, deleteChatSession, createRequest, type ChatSessionSummary } from '../api';
import { APP_VERSION } from '../version';
import { useSettings } from '../context/SettingsContext';

interface Message {
  role: string;
  content: string;
}

export default function HelpChat() {
  const { selectedRuleSetId, vignetteRuleSetId } = useSettings();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'sessions'>('chat');

  // Current chat state
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionName, setSessionName] = useState('New chat');
  const [sessionVersion, setSessionVersion] = useState(APP_VERSION);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [requestAdded, setRequestAdded] = useState<number | null>(null);

  // Session list
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, view]);

  useEffect(() => {
    async function handleDiscussCards(e: Event) {
      const { message } = (e as CustomEvent).detail;
      // Open chat in a fresh session
      setOpen(true);
      setView('chat');
      setSessionId(null);
      setSessionName('New chat');
      setRequestAdded(null);
      setInput('');

      // Add user message immediately and send
      const userMsg = { role: 'user', content: message };
      setMessages([userMsg]);
      setLoading(true);
      try {
        const resp = await sendChatMessage(message, null, selectedRuleSetId, vignetteRuleSetId);
        setMessages([userMsg, { role: 'assistant', content: resp.content }]);
        setSessionId(resp.session_id);
        setSessionName(resp.session_name);
      } catch {
        setMessages([userMsg, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }]);
      } finally {
        setLoading(false);
      }
    }
    window.addEventListener('discuss-cards', handleDiscussCards);
    return () => window.removeEventListener('discuss-cards', handleDiscussCards);
  }, []);

  async function loadSessions() {
    setSessionsLoading(true);
    try {
      const list = await getChatSessions();
      setSessions(list);
    } catch { /* ignore */ }
    setSessionsLoading(false);
  }

  async function openSession(id: number) {
    try {
      const detail = await getChatSession(id);
      setSessionId(detail.id);
      setSessionName(detail.name);
      setSessionVersion(detail.app_version);
      setMessages(detail.messages);
      setView('chat');
    } catch { /* ignore */ }
  }

  async function handleDeleteSession(id: number) {
    try {
      await deleteChatSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
      if (sessionId === id) startNewChat();
    } catch { /* ignore */ }
  }

  function startNewChat() {
    setSessionId(null);
    setSessionName('New chat');
    setSessionVersion(APP_VERSION);
    setMessages([]);
    setRequestAdded(null);
    setView('chat');
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setLoading(true);

    try {
      const resp = await sendChatMessage(text, sessionId, selectedRuleSetId, vignetteRuleSetId);
      setMessages(prev => [...prev, { role: 'assistant', content: resp.content }]);
      setSessionId(resp.session_id);
      setSessionName(resp.session_name);
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }]);
    } finally {
      setLoading(false);
    }
  }

  const isOutdated = sessionVersion < APP_VERSION;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-50 w-12 h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-colors duration-150"
        title="Help Assistant"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 w-96 h-[520px] bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-blue-50 shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-green-500 rounded-full" />
          <span className="text-sm font-semibold text-gray-900">
            {view === 'sessions' ? 'Chat History' : sessionName}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {view === 'chat' && (
            <>
              <button
                onClick={() => { setView('sessions'); loadSessions(); }}
                className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100"
                title="Chat history"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              <button
                onClick={startNewChat}
                className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100"
                title="New chat"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </>
          )}
          {view === 'sessions' && (
            <button
              onClick={() => setView('chat')}
              className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100"
              title="Back to chat"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </button>
          )}
          <button onClick={() => setOpen(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Session list view */}
      {view === 'sessions' && (
        <div className="flex-1 overflow-y-auto">
          <div className="p-3">
            <button
              onClick={startNewChat}
              className="w-full text-left px-3 py-2.5 rounded-lg bg-blue-50 text-blue-700 text-sm font-medium hover:bg-blue-100 transition-colors mb-2"
            >
              + New Chat
            </button>
          </div>
          {sessionsLoading ? (
            <p className="text-xs text-gray-400 text-center py-4">Loading...</p>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">No chat history yet</p>
          ) : (
            <div className="px-3 space-y-1 pb-3">
              {sessions.map(s => (
                <div
                  key={s.id}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${sessionId === s.id ? 'bg-blue-50' : ''}`}
                  onClick={() => openSession(s.id)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 truncate font-medium">{s.name}</p>
                    <p className="text-[10px] text-gray-400">
                      {s.message_count} messages
                      {s.app_version < APP_VERSION && (
                        <span className="text-amber-500 ml-1">(v{s.app_version} — outdated)</span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                    className="opacity-0 group-hover:opacity-100 p-1 text-gray-300 hover:text-red-500 transition-all"
                    title="Delete"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m-7 0a1 1 0 01-1-1V5a1 1 0 011-1h6a1 1 0 011 1v1a1 1 0 01-1 1H9z" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Chat view */}
      {view === 'chat' && (
        <>
          {/* Outdated version warning */}
          {isOutdated && messages.length > 0 && (
            <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-700 shrink-0">
              This chat was from v{sessionVersion}. The app is now v{APP_VERSION} — some information may be outdated. Start a new chat for current info.
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-gray-400 text-xs mt-6">
                <p className="text-sm font-medium text-gray-500 mb-3">Ask me anything about EOR Card Studio</p>
                <div className="space-y-1.5">
                  {[
                    'How does card generation work?',
                    'What are vignettes and teaching cases?',
                    'How do I set up rules?',
                    'How is this different from Claude Chat?',
                  ].map(q => (
                    <button
                      key={q}
                      onClick={() => setInput(q)}
                      className="text-blue-500 hover:underline block mx-auto text-xs"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-md'
                    : 'bg-gray-100 text-gray-800 rounded-bl-md'
                }`}>
                  {msg.role === 'assistant' ? (
                    <div dangerouslySetInnerHTML={{
                      __html: msg.content
                        .replace(/\n/g, '<br>')
                        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                        .replace(/`([^`]+)`/g, '<code class="bg-gray-200 px-1 rounded text-xs">$1</code>')
                    }} />
                  ) : msg.content}
                </div>
                {msg.role === 'assistant' && /contact mario/i.test(msg.content) && (
                  <button
                    onClick={async () => {
                      const match = msg.content.match(/(?:contact mario[^:]*:\s*)([\s\S]+)/i);
                      const desc = match ? match[1].trim() : msg.content;
                      const prevUserMsg = messages[i - 1]?.content || '';
                      try {
                        await createRequest({
                          title: prevUserMsg.slice(0, 60) + (prevUserMsg.length > 60 ? '...' : ''),
                          description: desc,
                          source: 'chat',
                          chat_session_id: sessionId,
                        });
                        setRequestAdded(i);
                      } catch { /* ignore */ }
                    }}
                    disabled={requestAdded === i}
                    className={`mt-1.5 text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
                      requestAdded === i
                        ? 'bg-green-100 text-green-700 cursor-default'
                        : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    }`}
                  >
                    {requestAdded === i ? '✓ Request added' : '+ Add as Request'}
                  </button>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 text-gray-500 px-3 py-2 rounded-xl rounded-bl-md text-sm animate-pulse">
                  Thinking...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-gray-100 px-3 py-2.5 shrink-0">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
                placeholder="Ask a question..."
                disabled={loading}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
              />
              <button
                onClick={handleSend}
                disabled={loading || !input.trim()}
                className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
